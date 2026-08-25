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

  /** Merge request'ы одного проекта — нужны при первой сборке индекса. */
  async mergeRequests(project: Project): Promise<MergeRequest[]> {
    const raw = await this.pages<Record<string, unknown>>(
      `/api/v4/projects/${project.id}/merge_requests?state=all`
    );
    return raw.map((m) => toMergeRequest(m, project.id, project.path_with_namespace));
  }

  /**
   * Всё изменившееся по всем проектам разом. Обход проектов по одному стоит
   * 142 запроса и почти четыре минуты, из которых 137 возвращают пустоту, —
   * здесь тот же ответ приходит одним запросом за полторы секунды.
   */
  async updatedSince(since: string): Promise<MergeRequest[]> {
    const raw = await this.pages<Record<string, unknown>>(
      `/api/v4/merge_requests?scope=all&state=all&updated_after=${encodeURIComponent(since)}`
    );
    return raw.map((m) => toMergeRequest(m, m.project_id as number, projectPathOf(m)));
  }
}

/**
 * Пути проекта в ответе глобального эндпоинта нет, но он есть в ссылке на MR:
 * `spaces/team/app!2280`. Запасной вариант — вычленить его из web_url.
 */
function projectPathOf(m: Record<string, unknown>): string {
  const full = (m.references as { full?: string } | undefined)?.full;
  if (full?.includes('!')) return full.slice(0, full.lastIndexOf('!'));
  return String(m.web_url ?? '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\/-\/merge_requests\/\d+$/, '');
}

function toMergeRequest(
  m: Record<string, unknown>,
  projectId: number,
  project: string
): MergeRequest {
  return {
    projectId,
    project,
    iid: m.iid as number,
    title: (m.title as string) ?? '',
    description: ((m.description as string) ?? '').slice(0, 800),
    state: m.state as string,
    createdAt: (m.created_at as string).slice(0, 10),
    updatedAt: m.updated_at as string,
    url: m.web_url as string
  };
}
