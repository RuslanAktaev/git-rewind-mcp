/**
 * Построение индекса: выкачать merge request'ы, посчитать векторы, разложить
 * по базе. Разовая операция на минуты, поэтому команда, а не часть запуска
 * сервера. Со второго раза дотягивает только изменившееся.
 */
import { loadConfig } from './config.js';
import { Embedder, cleanText } from './embeddings.js';
import { GitLab } from './gitlab.js';
import { Store } from './store.js';

const say = (line: string) => process.stdout.write(line + '\n');

export async function runIndex(): Promise<void> {
  const config = loadConfig();
  const embedder = new Embedder(config.ollamaUrl, config.model);

  // Пробный вектор заодно проверяет, что ollama жива и модель на месте, —
  // лучше упасть здесь, чем после десяти минут выкачки.
  const probe = await embedder.embed('probe');
  say(`model ${config.model}: ${probe.length} dimensions`);

  const store = await Store.open(config.dbPath, probe.length, config.model);
  const gitlab = new GitLab(config.gitlabHost, config.gitlabToken);

  const previousRun = store.getMeta('indexed_at');
  // Отметку берём до выкачки: MR, изменённый во время прогона, попадёт
  // в следующий раз, а не потеряется между двумя отметками.
  const startedAt = new Date().toISOString();
  say(previousRun ? `updating what changed since ${previousRun}` : 'building the index from scratch');

  const projects = await gitlab.projects();
  say(`projects: ${projects.length}`);

  let indexed = 0;
  let touched = 0;
  for (const [i, project] of projects.entries()) {
    const mrs = await gitlab.mergeRequests(project, previousRun);
    if (mrs.length === 0) continue;
    touched++;

    const texts = mrs.map((mr) => cleanText(mr.title, mr.description));
    const vectors = await embedder.embedMany(texts);
    store.transaction(() => {
      mrs.forEach((mr, n) => store.upsert(mr, vectors[n], texts[n]));
    });

    indexed += mrs.length;
    say(`  [${i + 1}/${projects.length}] ${project.path_with_namespace}: ${mrs.length} merge requests`);
  }

  store.setMeta('indexed_at', startedAt);
  say(`\ndone: ${indexed} merge requests from ${touched} projects, ${store.count()} in the index`);
  say(`database: ${config.dbPath}`);
  store.close();
}
