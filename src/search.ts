/**
 * Гибридный поиск: смысл и слова вместе.
 *
 * Векторный поиск понимает синонимы, но считает все слова запроса одинаково
 * важными — «pay with cryptocurrency» он находит по «pay» и молчит о том, что
 * «cryptocurrency» не встретилось нигде. Полнотекстовый видит редкое слово, но
 * не знает синонимов: «dark mode» не найдёт «dark theme». Поодиночке каждый
 * слеп там, где второй видит.
 */
import type { Embedder } from './embeddings.js';
import type { Hit, Store } from './store.js';

/** Сколько берём от каждого способа перед объединением. */
const CANDIDATES = 20;
/**
 * Ниже этой близости в базе нет ничего по теме. Порог выведен на 21 размеченном
 * запросе: самая слабая находка дала 0.685, самый сильный промах 0.667.
 * Действует только для английских запросов — на русских оценка плывёт.
 */
export const FOUND_CUTOFF = 0.675;

const STOP = new Set([
  'the', 'and', 'with', 'for', 'into', 'app', 'from', 'that', 'this',
  'to', 'in', 'on', 'of', 'at', 'by', 'is', 'it', 'as', 'be', 'an', 'or', 'we', 'do'
]);

export interface SearchResult {
  hits: Hit[];
  /** Сколько записей содержит каждое значимое слово запроса. Ноль — сильная улика. */
  wordCounts: Array<{ word: string; count: number }>;
  /** Лучшая близость по всей базе — по ней и решается, нашлось ли хоть что-то. */
  best: number;
  /** На скольких записях сошлись оба способа. */
  agreement: number;
}

export function queryWords(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) =>
      word.length >= 2 &&
      // Хотя бы одна буква: иначе в запрос попадают годы и номера задач.
      // Начинаться с буквы не обязано — иначе теряются «2fa» и «s3», а это
      // как раз те редкие точные слова, ради которых поиск по словам и нужен.
      /[a-z]/.test(word) &&
      !STOP.has(word)
  );
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const keyOf = (hit: Hit) => `${hit.projectId}:${hit.iid}`;

export async function search(
  store: Store,
  embedder: Embedder,
  query: string,
  limit: number
): Promise<SearchResult> {
  const vector = await embedder.embed(query);
  const byMeaning = store.searchVector(vector, CANDIDATES);
  const words = queryWords(query);
  const byWords = store.searchWords(words, CANDIDATES);

  const meaningKeys = new Set(byMeaning.map(keyOf));
  const wordKeys = new Set(byWords.map(keyOf));

  // Порядок — по близости, а не по склейке мест. Склейка (RRF) пробовалась и
  // отвергнута замером: записи, найденные обоими способами, обгоняли одинокого
  // лидера, и лучший MR с 0.762 вылетал из пятёрки в пользу 0.682.
  // Полнотекстовый поиск при этом не лишний: он добавляет кандидатов с точным
  // редким словом и даёт счётчики слов, которых у векторного нет.
  const rows = new Map<string, Hit>();
  for (const hit of [...byMeaning, ...byWords]) {
    if (!rows.has(keyOf(hit))) rows.set(keyOf(hit), hit);
  }

  for (const hit of rows.values()) {
    if (Number.isNaN(hit.similarity)) {
      const stored = store.embeddingOf(hit.projectId, hit.iid);
      hit.similarity = stored ? cosine(vector, stored) : 0;
    }
  }

  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const [key, hit] of [...rows].sort((a, b) => b[1].similarity - a[1].similarity)) {
    // Одинаковые заголовки встречаются: переоткрытые MR, копии в разных ветках.
    const title = hit.title.trim().toLowerCase();
    if (seen.has(title)) continue;
    seen.add(title);

    hit.source = meaningKeys.has(key) && wordKeys.has(key) ? 'both' : hit.source;
    hits.push(hit);
    if (hits.length === limit) break;
  }

  return {
    hits,
    wordCounts: words.map((word) => ({ word, count: store.wordFrequency(word) })),
    best: byMeaning[0]?.similarity ?? 0,
    agreement: [...meaningKeys].filter((k) => wordKeys.has(k)).length
  };
}
