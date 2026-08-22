#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { runIndex } from './indexer.js';

// Индексация — отдельная команда, а не часть запуска сервера: она идёт минуты
// и должна запускаться осознанно.
if (process.argv[2] === 'index') {
  runIndex().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
} else {
  const server = new McpServer({ name: 'git-rewind', version: '0.1.0' });

  // Инструмент поиска по merge request'ам появится здесь.
  // Инструменты истории git удалены осознанно, код лежит в коммите a308772.

  serveStdio(() => server);
}
