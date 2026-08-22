/** Чтение merge request'ов через GitLab API. Только GET, только чтение. */

export interface MergeRequest {
  projectId: number;
  project: string;
  iid: number;
  title: string;
  description: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface Project {
  id: number;
  path_with_namespace: string;
}

export class GitLab {
  constructor(
    private readonly host: string,
    private readonly token: string
  ) {}

  /**
   * GET с повтором. Длинный обход почти наверняка словит обрыв или таймаут,
   * а вот 4xx повторять бессмысленно — доступа от этого не прибавится.
   */
  private async get<T>(path: string): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(this.host + path, {
          headers: { 'PRIVATE-TOKEN': this.token },
          signal: AbortSignal.timeout(120_000)
        });
        if (response.ok) return (await response.json()) as T;

        // 401 значит «токен не тот» — это не сетевая икота, повторять нечего.
        if (response.status === 401) {
          throw new Error(`GitLab rejected the token (401) on ${path}`);
        }
        if (response.status < 500 && response.status !== 429) return null;
        if (attempt === 3) return null;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('GitLab rejected')) throw error;
        if (attempt === 3) return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }

  /** Идёт по страницам, пока GitLab отдаёт полные: короткая страница — последняя. */
  private async pages<T>(path: string, perPage = 100): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= 200; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const chunk = await this.get<T[]>(`${path}${separator}per_page=${perPage}&page=${page}`);
      if (!chunk?.length) return rows;
      rows.push(...chunk);
      if (chunk.length < perPage) return rows;
    }
    return rows;
  }

  /** Проекты, где состоит владелец токена. */
  async projects(): Promise<Project[]> {
    return this.pages<Project>('/api/v4/projects?membership=true&simple=true&order_by=id');
  }

  /**
   * Merge request'ы одного проекта. `updatedAfter` превращает полный обход
   * в дозагрузку: со второго раза тянется только изменившееся.
   */
  async mergeRequests(project: Project, updatedAfter?: string): Promise<MergeRequest[]> {
    const since = updatedAfter ? `&updated_after=${encodeURIComponent(updatedAfter)}` : '';
    const raw = await this.pages<Record<string, unknown>>(
      `/api/v4/projects/${project.id}/merge_requests?state=all${since}`
    );
    return raw.map((m) => ({
      projectId: project.id,
      project: project.path_with_namespace,
      iid: m.iid as number,
      title: (m.title as string) ?? '',
      description: ((m.description as string) ?? '').slice(0, 800),
      state: m.state as string,
      createdAt: (m.created_at as string).slice(0, 10),
      updatedAt: m.updated_at as string,
      url: m.web_url as string
    }));
  }
}
