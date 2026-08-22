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

server.registerTool(
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


/** Separators for log records. NUL is unusable: Node refuses arguments containing it. */
const FIELD = '\x1f';
const RECORD = '\x1e';

interface FileCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  /** Path the file had in this commit — differs from the query path after a rename. */
  path: string;
  added: string;
  deleted: string;
  /** Set when this commit renamed the file; holds the name it had before. */
  renamedFrom?: string;
  /** Set when the path matched several files, i.e. a directory was queried. */
  files?: number;
  status: 'added' | 'deleted' | 'modified' | 'merge';
}

/**
 * Expands the compact rename notation git uses in --numstat:
 * `src/{old.ts => new.ts}` or `old.ts => new.ts` -> ['old.ts', 'new.ts'].
 * Returns null when the entry is not a rename.
 */
function splitRename(spec: string): [string, string] | null {
  if (!spec.includes(' => ')) return null;

  const open = spec.indexOf('{');
  const close = spec.indexOf('}', open);
  if (open !== -1 && close !== -1) {
    const [from, to] = spec.slice(open + 1, close).split(' => ');
    const prefix = spec.slice(0, open);
    const suffix = spec.slice(close + 1);
    // A pure deletion or addition of a directory level leaves one side empty,
    // which would otherwise produce a double slash.
    const join = (part: string) => (prefix + part + suffix).replace('//', '/');
    return [join(from), join(to)];
  }

  const [from, to] = spec.split(' => ');
  return [from, to];
}

/** Parses `git log --numstat` output into one entry per commit. */
function parseLog(stdout: string, queryPath: string): FileCommit[] {
  return stdout
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [header, ...rest] = record.split('\n');
      const [sha, shortSha, author, date, subject] = header.split(FIELD);

      // Merge commits carry no numstat block under --follow. A single file gives
      // exactly one line; a directory path gives one per file it touched.
      const stats = rest.filter((line) => line.includes('\t')).map((line) => line.split('\t'));
      const commit: FileCommit = {
        sha,
        shortSha,
        author,
        date: date.slice(0, 10),
        subject,
        path: queryPath,
        added: '?',
        deleted: '?',
        status: 'merge'
      };
      if (stats.length === 0) return commit;

      commit.status = 'modified';
      // Binary files report "-" instead of a count; summing would turn that into NaN.
      const sum = (index: number) =>
        stats.some((stat) => stat[index] === '-')
          ? '-'
          : String(stats.reduce((total, stat) => total + Number(stat[index]), 0));
      commit.added = sum(0);
      commit.deleted = sum(1);

      if (stats.length > 1) {
        commit.files = stats.length;
        return commit;
      }

      const spec = stats[0][2];
      const rename = splitRename(spec);
      if (rename) {
        commit.renamedFrom = rename[0];
        commit.path = rename[1];
      } else {
        commit.path = spec;
      }
      return commit;
    });
}

/** Caps a diff so one noisy commit cannot swallow the whole answer. */
function capDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return [...lines.slice(0, maxLines), `... diff truncated, ${lines.length - maxLines} more lines`].join('\n');
}

server.registerTool(
  'file_history',
  {
    description:
      'History of one file: the commits that touched it, with author, date, message and change size, ' +
      'following the file across renames. Use it to answer "when did this file appear", "who has been ' +
      'changing it" and "what did it look like before". Prefer this over running git by hand: one call ' +
      'replaces log + follow + show and returns only what matters.',
    inputSchema: z.object({
      path: z.string().describe('Path to the file, relative to the repository root.'),
      repo: z
        .string()
        .optional()
        .describe('Path to the repository. Defaults to the working directory of the server process.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe('How many of the most recent commits to return.'),
      include_diff: z
        .boolean()
        .default(false)
        .describe('Include the diff of the file for every returned commit. Off by default: diffs are large.')
    })
  },
  async ({ path, repo, limit, include_diff }) => {
    const cwd = repo ?? process.cwd();

    let root: string;
    try {
      root = await git(['rev-parse', '--show-toplevel'], cwd);
    } catch {
      return {
        content: [{ type: 'text', text: `not a git repository: ${cwd}` }],
        isError: true
      };
    }

    const format = `${RECORD}%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s`;
    let stdout: string;
    try {
      stdout = await git(['log', '--follow', '--numstat', `--format=${format}`, `-${limit}`, '--', path], cwd);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `git log failed for "${path}": ${(error as Error).message}` }],
        isError: true
      };
    }

    const commits = parseLog(stdout, path);

    if (commits.length === 0) {
      const shallow = (await git(['rev-parse', '--is-shallow-repository'], cwd)) === 'true';
      const tracked = await git(['ls-files', '--', path], cwd).catch(() => '');
      const reason = shallow
        ? 'the clone is shallow, so most history is missing here'
        : tracked
          ? 'the file is tracked but no commit in this history touches it'
          : 'the path is not tracked in this repository — check the spelling, it must be relative to the repository root';
      return { content: [{ type: 'text', text: `no history for "${path}" in ${root}: ${reason}` }] };
    }

    // Counting without --numstat is cheap: git skips diff generation entirely.
    const total = (await git(['log', '--follow', '--format=%H', '--', path], cwd)).split('\n').length;

    // The oldest returned commit only counts as "added" when it really is the
    // first one; otherwise the file simply predates the window we asked for.
    const oldest = commits[commits.length - 1];
    if (total === commits.length && !oldest.renamedFrom && oldest.deleted === '0') {
      oldest.status = 'added';
    }

    // The newest commit touching the path is always in the window, so a path that
    // no longer exists in the work tree was removed by exactly that commit.
    const tracked = await git(['ls-files', '--', path], cwd).catch(() => '');
    if (!tracked && commits[0].added === '0') {
      commits[0].status = 'deleted';
    }

    const lines = [
      `repository: ${root}`,
      `file: ${path}`,
      total === commits.length
        ? `${total} commits touch this path`
        : `${total} commits touch this path, showing the ${commits.length} most recent`,
      ''
    ];

    for (const commit of commits) {
      const marks: string[] = [];
      if (commit.status === 'added') marks.push('first appearance');
      if (commit.status === 'deleted') marks.push('deleted here');
      if (commit.status === 'merge') marks.push('merge');
      if (commit.files) marks.push(`${commit.files} files under this path`);
      if (commit.renamedFrom) marks.push(`renamed from ${commit.renamedFrom}`);
      else if (commit.path !== path && !commit.files && commit.status !== 'merge')
        marks.push(`named ${commit.path} here`);

      const size = commit.status === 'merge' ? '' : `  +${commit.added} -${commit.deleted}`;
      const suffix = marks.length ? `  (${marks.join(', ')})` : '';
      lines.push(`${commit.shortSha}  ${commit.date}  ${commit.author}${size}${suffix}`);
      lines.push(`    ${commit.subject}`);

      if (include_diff && commit.status !== 'merge') {
        // A rename shows up as an add plus a delete unless both names are in the
        // pathspec, which is what lets git pair them back together.
        const paths = commit.renamedFrom ? [commit.renamedFrom, commit.path] : [commit.path];
        const diff = await git(['show', '--format=', '--patch', '-M', commit.sha, '--', ...paths], cwd).catch(
          () => ''
        );
        if (diff) {
          lines.push('');
          lines.push(capDiff(diff, 200));
        }
      }
      lines.push('');
    }

    return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] };
  }
);

serveStdio(() => server);
