#!/usr/bin/env node
import { existsSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { loadConfig } from './config.js';
import { Embedder } from './embeddings.js';
import { runIndex } from './indexer.js';
import { FOUND_CUTOFF, search } from './search.js';
import { Store } from './store.js';

// Индексация — отдельная команда, а не часть запуска сервера: она идёт минуты
// и должна запускаться осознанно.
if (process.argv[2] === 'index') {
  runIndex().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
} else {
  serveMcp();
}

function serveMcp(): void {
  const server = new McpServer({ name: 'git-rewind', version: '0.1.0' });

  // База открывается при первом поиске, а не при запуске: размерность вектора
  // известна только после обращения к модели, да и старт должен быть мгновенным.
  let store: Store | undefined;
  let embedder: Embedder | undefined;

  server.registerTool(
    'search_mrs',
    {
      description:
        'Finds whether this team has already built something, by searching merge requests ' +
        'across every GitLab project the user belongs to. Use it for "have we done X before", ' +
        '"where did we implement X", "which project has X". ' +
        'The query MUST be in English — the index holds English titles only, and a query in ' +
        'another language misses what it should find. Translate the user question first. ' +
        'Returns merge requests with links; judge from the titles whether they really answer ' +
        'the question, the server does not decide that for you.',
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .describe('What to look for, in English. A short phrase works best: "two-factor authentication OTP".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe('How many merge requests to return.')
      })
    },
    async ({ query, limit }) => {
      // Русский запрос находит заметно хуже английского — проверено на полной
      // базе. Отвечаем отказом, а не плохой выдачей: перевод агенту ничего не стоит.
      if (/[Ѐ-ӿ]/.test(query)) {
        return {
          content: [
            {
              type: 'text',
              text: 'the query must be in English — the index holds English titles only. Translate it and call again.'
            }
          ],
          isError: true
        };
      }

      const config = loadConfig();
      if (!existsSync(config.dbPath)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `no index at ${config.dbPath} — build it once with "npx git-rewind-mcp index" ` +
                `(needs GITLAB_HOST, a token, and a running ollama)`
            }
          ],
          isError: true
        };
      }

      try {
        embedder ??= new Embedder(config.ollamaUrl, config.model);
        store ??= await Store.open(config.dbPath, (await embedder.embed('probe')).length, config.model);
        const result = await search(store, embedder, query, limit);

        const counts = result.wordCounts.map((w) => `${w.word}=${w.count}`).join(', ');
        const total = store.count();

        // Ниже порога список не отдаём: он состоит из случайно похожих строк,
        // и агент, читая пять правдоподобных заголовков, поверит им зря.
        if (result.best < FOUND_CUTOFF) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `nothing about this in ${total} merge requests ` +
                  `(closest match ${result.best.toFixed(3)}, below the ${FOUND_CUTOFF} cutoff).\n` +
                  `words of the query, and how many merge requests contain each: ${counts}\n` +
                  `A zero here means nobody on the team ever wrote that word.`
              }
            ]
          };
        }

        const lines = [
          `${result.hits.length} of ${total} merge requests, closest ${result.best.toFixed(3)}`,
          `words of the query, and how many merge requests contain each: ${counts}`,
          `both search methods agree on ${result.agreement} candidates`,
          ''
        ];
        for (const hit of result.hits) {
          lines.push(
            `${hit.similarity.toFixed(3)} [${hit.source}] ${hit.project} !${hit.iid} (${hit.createdAt})`,
            `  ${hit.title}`,
            `  ${hit.url}`
          );
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: (error as Error).message }],
          isError: true
        };
      }
    }
  );

  serveStdio(() => server);
}
