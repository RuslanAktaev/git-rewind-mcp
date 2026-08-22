#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'git-rewind', version: '0.1.0' });

// Инструменты поиска по merge request'ам появятся здесь.
// Инструменты истории git (health, file_history) удалены осознанно: агент
// с доступом к шеллу делает то же самое сам. Код лежит в коммите a308772.

serveStdio(() => server);
