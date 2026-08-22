/**
 * Все внешние адреса и пути приходят снаружи. Сервер не предполагает, где его
 * запустили: в контейнере, через npx или на общей машине — меняются только
 * значения, а не код.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export interface Config {
  /** Хост GitLab, например https://projects.example.com */
  gitlabHost: string;
  /** Токен с правом read_api. */
  gitlabToken: string;
  /** Адрес ollama, обычно локальный. */
  ollamaUrl: string;
  /** Модель эмбеддингов. Менять её без переиндексации нельзя: векторы несовместимы. */
  model: string;
  /** Файл базы: векторы и полнотекстовый индекс лежат в нём вместе. */
  dbPath: string;
}

/** Читает токен из переменной или из файла, на который она указывает. */
function readToken(): string {
  const direct = process.env.GITLAB_TOKEN?.trim();
  if (direct) return direct;

  const file = process.env.GITLAB_TOKEN_FILE ?? join(homedir(), '.gitlab-token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(
      `no GitLab token: set GITLAB_TOKEN, or put one in ${file} (needs the read_api scope)`
    );
  }
}

export function loadConfig(): Config {
  const host = process.env.GITLAB_HOST?.trim();
  if (!host) throw new Error('no GitLab host: set GITLAB_HOST, for example https://gitlab.com');

  return {
    gitlabHost: host.replace(/\/+$/, ''),
    gitlabToken: readToken(),
    ollamaUrl: (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: process.env.EMBED_MODEL ?? 'bge-m3',
    dbPath: process.env.INDEX_DB ?? join(homedir(), '.git-rewind', 'index.db')
  };
}
