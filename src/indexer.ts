/**
 * Построение индекса: выкачать merge request'ы, посчитать векторы, разложить
 * по базе. Разовая операция на минуты, поэтому команда, а не часть запуска
 * сервера. Со второго раза дотягивает только изменившееся.
 */
import { loadIndexConfig } from './config.js';
import { Embedder, cleanText } from './embeddings.js';
import { GitLab, type MergeRequest } from './gitlab.js';
import { Store } from './store.js';

const say = (line: string) => process.stdout.write(line + '\n');

/** Считает векторы пачкой и кладёт merge request'ы в базу одной транзакцией. */
async function absorb(store: Store, embedder: Embedder, mrs: MergeRequest[]): Promise<void> {
  const texts = mrs.map((mr) => cleanText(mr.title, mr.description));
  const vectors = await embedder.embedMany(texts);
  store.transaction(() => {
    mrs.forEach((mr, n) => store.upsert(mr, vectors[n], texts[n]));
  });
}

export async function runIndex(): Promise<void> {
  const config = loadIndexConfig();
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

  let indexed = 0;
  let touched = 0;

  if (previousRun) {
    // Дозагрузка идёт одним запросом по всем проектам сразу. Обход проектов
    // по одному стоил четыре минуты, из которых почти всё — ожидание пустых
    // ответов от проектов, где ничего не менялось.
    say(`updating what changed since ${previousRun}`);
    const changed = await gitlab.updatedSince(previousRun);

    const byProject = new Map<string, MergeRequest[]>();
    for (const mr of changed) {
      const list = byProject.get(mr.project);
      if (list) list.push(mr);
      else byProject.set(mr.project, [mr]);
    }

    for (const [project, mrs] of byProject) {
      await absorb(store, embedder, mrs);
      indexed += mrs.length;
      touched++;
      say(`  ${project}: ${mrs.length} merge requests`);
    }
  } else {
    // Первая сборка: глобальный эндпоинт отдаёт всё, что видно токену, а нам
    // нужны проекты, где пользователь состоит, — поэтому идём по ним.
    say('building the index from scratch');
    const projects = await gitlab.projects();
    say(`projects: ${projects.length}`);

    for (const [i, project] of projects.entries()) {
      const mrs = await gitlab.mergeRequests(project);
      if (mrs.length === 0) continue;

      await absorb(store, embedder, mrs);
      indexed += mrs.length;
      touched++;
      say(`  [${i + 1}/${projects.length}] ${project.path_with_namespace}: ${mrs.length} merge requests`);
    }
  }

  store.setMeta('indexed_at', startedAt);
  say(`\ndone: ${indexed} merge requests from ${touched} projects, ${store.count()} in the index`);
  say(`database: ${config.dbPath}`);
  store.close();
}
