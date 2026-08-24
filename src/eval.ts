/**
 * Прогон по размеченным запросам. Отвечает на один вопрос: отделяет ли порог
 * находку от промаха — на существующих темах и на заведомо отсутствующих.
 *
 * Команда, а не тест на `node:test`: нужна живая база на сто мегабайт и
 * запущенная ollama, в отрыве от них проверять нечего.
 */
import { loadConfig } from './config.js';
import { Embedder } from './embeddings.js';
import { FOUND_CUTOFF, search } from './search.js';
import { Store } from './store.js';

/**
 * Размечено вручную: регулярка по заголовкам — эталон того, что должно найтись.
 * `null` означает «такого в базе нет», и правильный ответ — не найти вовсе.
 * Список перенесён из `spike/5-eval.py` без изменений: на нём выведен порог.
 */
const CASES: Array<[string, RegExp | null]> = [
  ['two-factor authentication OTP', /\b2fa\b|two[- ]factor|\botp\b/i],
  ['export report to csv', /export.{0,20}csv|csv.{0,20}export/i],
  ['push notifications', /push notification/i],
  ['stripe payment integration', /stripe/i],
  ['dark mode theme switch', /dark (mode|theme)/i],
  ['google maps on screen', /google map|mapbox/i],
  ['sync cryptocurrency rates', /crypto/i],
  ['pay with cryptocurrency bitcoin', null],
  ['thermal printer label printing', null],
  ['nuclear reactor control panel', null],
  ['reset password by email', /reset password|forgot password/i],
  ['upload files to amazon s3', /\bs3\b/i],
  ['onboarding screens for new users', /onboarding/i],
  ['websocket real time updates', /socket/i],
  ['deep links into the app', /deep ?link/i],
  ['subscription in-app purchase', /in-?app purchase|subscription/i],
  ['3d printer calibration', null],
  ['alexa voice assistant skill', null],
  ['blockchain smart contract', null],
  ['tractor autopilot steering', null],
  ['medical prescription scanning', null]
];

/** Сколько результатов смотрим: столько же, сколько сервер отдаёт по умолчанию. */
const TOP = 5;

const say = (line: string) => process.stdout.write(line + '\n');

export async function runEval(): Promise<void> {
  const config = loadConfig();
  const embedder = new Embedder(config.ollamaUrl, config.model);
  const probe = await embedder.embed('probe');
  const store = await Store.open(config.dbPath, probe.length, config.model);

  const titles = store.titles();
  say(`${titles.length} merge requests, модель ${config.model}, порог ${FOUND_CUTOFF}\n`);
  say(`${'запрос'.padEnd(34)} ${'близость'} ${'в базе'.padStart(7)}  результат`);

  let passed = 0;
  // Границы, между которыми проходит порог. Запас между ними — то, ради чего
  // прогон и существует: он показывает, насколько близко подошли к обрыву.
  let worstFind = 1;
  let bestMiss = 0;

  for (const [query, truth] of CASES) {
    const result = await search(store, embedder, query, TOP);
    const passesCutoff = result.best >= FOUND_CUTOFF;

    let ok: boolean;
    let note: string;
    if (truth) {
      const inBase = titles.filter((title) => truth.test(title)).length;
      const inTop = result.hits.some((hit) => truth.test(hit.title));
      ok = passesCutoff && inTop;
      note = !passesCutoff ? 'не прошёл порог' : inTop ? `эталон в топ-${TOP}` : `эталона нет в топ-${TOP}`;
      note = `${String(inBase).padStart(5)}  ${note}`;
      if (ok) worstFind = Math.min(worstFind, result.best);
    } else {
      ok = !passesCutoff;
      note = `${'—'.padStart(5)}  ${ok ? 'отклонён верно' : 'ложная тревога'}`;
      if (ok) bestMiss = Math.max(bestMiss, result.best);
    }

    if (ok) passed++;
    say(`${ok ? '✓' : '✗'} ${query.padEnd(32)} ${result.best.toFixed(3)}  ${note}`);
  }

  const existing = CASES.filter(([, truth]) => truth).length;
  say('');
  say(`${passed} из ${CASES.length}: ${existing} существующих тем, ${CASES.length - existing} отсутствующих`);
  say(
    `худшая находка ${worstFind.toFixed(3)} | лучший промах ${bestMiss.toFixed(3)} | ` +
      `запас ${(worstFind - bestMiss).toFixed(3)}`
  );
  if (worstFind < FOUND_CUTOFF || bestMiss >= FOUND_CUTOFF) {
    say(`порог ${FOUND_CUTOFF} больше не разделяет их — его надо пересматривать`);
  }

  store.close();
  if (passed !== CASES.length) process.exitCode = 1;
}
