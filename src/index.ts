#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const execFileAsync = promisify(execFile);

/**
 * Runs git with the given arguments in `cwd`. Arguments are passed as an array,
 * never through a shell, so user-supplied paths cannot inject commands.
 */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

const server = new McpServer({ name: 'git-rewind', version: '0.1.0' });

но.registerTool(
  'health',
  {
    description:
      'Checks that git is available and that the target directory is a usable repository. ' +
      'Call this first when history tools return nothing, to tell "no such change" apart from "no history here".',
    inputSchema: z.object({
      repo: z
        .string()
        .optional()
        .describe('Path to the repository. Defaults to the working directory of the server process.')
    })
  },
  async ({ repo }) => {
    const cwd = repo ?? process.cwd();
    const lines: string[] = [];

    try {
      lines.push(await git(['--version'], cwd));
    } catch {
      return {
        content: [{ type: 'text', text: 'git not found in PATH — the server cannot read any history.' }],
        isError: true
      };
    }

    let root: string;
    try {
      root = await git(['rev-parse', '--show-toplevel'], cwd);
    } catch {
      return {
        content: [{ type: 'text', text: `not a git repository: ${cwd}` }],
        isError: true
      };
    }
    lines.push(`repository: ${root}`);

    // A shallow clone carries no history to search, so say so rather than
    // letting later tools report an empty result as "nothing ever changed".
    const shallow = (await git(['rev-parse', '--is-shallow-repository'], cwd)) === 'true';
    lines.push(shallow ? 'history: SHALLOW clone — history is truncated' : 'history: full');

    const count = await git(['rev-list', '--count', 'HEAD'], cwd).catch(() => '0');
    lines.push(`commits reachable from HEAD: ${count}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

serveStdio(() => server);
