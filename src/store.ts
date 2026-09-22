/**
 * Хранилище: векторы и полнотекстовый индекс в одном файле SQLite.
 * Векторный поиск даёт смысл, полнотекстовый — точные и редкие слова;
 * поодиночке каждый слеп там, где второй видит.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import * as sqliteVec from 'sqlite-vec';

import type { MergeRequest } from './gitlab.js';

export interface Hit extends MergeRequest {
  /** Косинус между запросом и записью: 1 — совпадение, 0 — ничего общего. */
  similarity: number;
  /** Откуда пришла запись: смысл, слова или оба способа сразу. */
  source: 'vector' | 'words' | 'both';
}

/** Встроенный модуль появился в Node 22.13; раньше он был спрятан за флагом. */
async function openDatabase(path: string): Promise<DatabaseSync> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error(
      `this Node cannot open SQLite (you are on ${process.version}); Node 22.13 or newer is required`
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  return new sqlite.DatabaseSync(path, { allowExtension: true });
}

export class Store {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly dimension: number
  ) {}

  static async open(path: string, dimension: number, model: string): Promise<Store> {
    const db = await openDatabase(path);
    sqliteVec.load(db);

    // WAL: сессий может быть несколько, и индексация не должна блокировать поиск.
    db.exec('pragma journal_mode = wal');
    db.exec(`
      create table if not exists meta(key text primary key, value text not null);
      create table if not exists mr(
        id integer primary key autoincrement,
        project_id integer not null,
        project text not null,
        iid integer not null,
        title text not null,
        description text not null,
        state text not null,
        created_at text not null,
        updated_at text not null,
        url text not null,
        unique(project_id, iid)
      );
      create virtual table if not exists mr_fts using fts5(title, project, tokenize='porter unicode61');
    `);
    db.exec(`create virtual table if not exists mr_vec using vec0(
      embedding float[${dimension}] distance_metric=cosine)`);

    const store = new Store(db, dimension);
    // Векторы разных моделей несравнимы между собой, и молча смешивать их
    // нельзя: поиск не сломается, он просто начнёт врать.
    const previous = store.getMeta('model');
    if (previous && previous !== model) {
      throw new Error(
        `the index at ${path} was built with "${previous}", not "${model}" — ` +
          `delete the file or point INDEX_DB somewhere else`
      );
    }
    store.setMeta('model', model);
    return store;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = ?')
      .run(key, value, value);
  }

  /**
   * Кладёт merge request со всеми тремя представлениями сразу. Уже известный
   * MR обновляется на месте: заголовок могли переписать, значит и вектор другой.
   */
  upsert(mr: MergeRequest, embedding: Float32Array, indexedText: string): void {
    this.db
      .prepare(
        `insert into mr(project_id, project, iid, title, description, state, created_at, updated_at, url)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(project_id, iid) do update set
           title = excluded.title, description = excluded.description, state = excluded.state,
           updated_at = excluded.updated_at, url = excluded.url`
      )
      .run(
        mr.projectId,
        mr.project,
        mr.iid,
        mr.title,
        mr.description,
        mr.state,
        mr.createdAt,
        mr.updatedAt,
        mr.url
      );

    const { id } = this.db
      .prepare('select id from mr where project_id = ? and iid = ?')
      .get(mr.projectId, mr.iid) as { id: number };
    // vec0 принимает только целочисленный rowid — обычное число уходит как
    // дробное, и запись отвергается с невнятной ошибкой про primary key.
    const rowid = BigInt(id);

    this.db.prepare('delete from mr_fts where rowid = ?').run(rowid);
    this.db.prepare('insert into mr_fts(rowid, title, project) values (?, ?, ?)').run(
      rowid,
      indexedText,
      mr.project
    );

    this.db.prepare('delete from mr_vec where rowid = ?').run(rowid);
    this.db
      .prepare('insert into mr_vec(rowid, embedding) values (?, ?)')
      .run(rowid, new Uint8Array(embedding.buffer.slice(0)));
  }

  transaction<T>(body: () => T): T {
    this.db.exec('begin');
    try {
      const result = body();
      this.db.exec('commit');
      return result;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  /**
   * Ближайшие по смыслу. vec0 отдаёт расстояние, а порог в спеке записан
   * в косинусах — при distance_metric=cosine это одно и то же наоборот.
   */
  searchVector(embedding: Float32Array, limit: number): Hit[] {
    const rows = this.db
      .prepare(
        `select mr.project_id, mr.project, mr.iid, mr.title, mr.description, mr.state,
                mr.created_at, mr.updated_at, mr.url, vec.distance
         from mr_vec vec join mr on mr.id = vec.rowid
         where vec.embedding match ? and k = ?
         order by vec.distance`
      )
      .all(new Uint8Array(embedding.buffer.slice(0)), limit) as Array<Record<string, never>>;
    return rows.map((r) => ({
      projectId: Number(r.project_id),
      project: String(r.project),
      iid: Number(r.iid),
      title: String(r.title),
      description: String(r.description),
      state: String(r.state),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      url: String(r.url),
      similarity: 1 - Number(r.distance),
      source: 'vector' as const
    }));
  }

  /** Точные слова. Редкое слово весит больше частого — это делает bm25 сам. */
  searchWords(words: string[], limit: number): Hit[] {
    if (words.length === 0) return [];
    // Только по заголовку: путь проекта тоже лежит в индексе, и без ограничения
    // «react» совпадает с каждым MR из репозитория `*-react-native`.
    const expression = words.map((w) => `title:"${w}"`).join(' OR ');
    const rows = this.db
      .prepare(
        `select mr.project_id, mr.project, mr.iid, mr.title, mr.description, mr.state,
                mr.created_at, mr.updated_at, mr.url, mr.id
         from mr_fts join mr on mr.id = mr_fts.rowid
         where mr_fts match ? order by bm25(mr_fts) limit ?`
      )
      .all(expression, limit) as Array<Record<string, never>>;
    return rows.map((r) => ({
      projectId: Number(r.project_id),
      project: String(r.project),
      iid: Number(r.iid),
      title: String(r.title),
      description: String(r.description),
      state: String(r.state),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      url: String(r.url),
      // Оценку по словам не с чем сравнивать: bm25 несравним между запросами.
      // Досчитывается в search.ts по сохранённому вектору.
      similarity: Number.NaN,
      source: 'words' as const
    }));
  }

  /** Сохранённый вектор записи — чтобы досчитать оценку тем, кого нашли словами. */
  embeddingOf(projectId: number, iid: number): Float32Array | undefined {
    const row = this.db
      .prepare(
        `select vec.embedding from mr_vec vec join mr on mr.id = vec.rowid
         where mr.project_id = ? and mr.iid = ?`
      )
      .get(projectId, iid) as { embedding: Uint8Array } | undefined;
    if (!row) return undefined;
    const bytes = Uint8Array.from(row.embedding);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  /** В скольких записях встречается слово. Ноль — его тут не писал никто. */
  wordFrequency(word: string): number {
    const row = this.db
      .prepare('select count(*) as n from mr_fts where mr_fts match ?')
      .get(`title:"${word}"`) as { n: number };
    return row.n;
  }

  /** Все заголовки разом: прогону нужно посчитать эталон регуляркой. */
  titles(): string[] {
    const rows = this.db.prepare('select title from mr').all() as Array<{ title: string }>;
    return rows.map((row) => String(row.title));
  }

  count(): number {
    return (this.db.prepare('select count(*) as n from mr').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
