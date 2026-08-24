# git-rewind-mcp

An MCP server that answers one question: **have we built this before, anywhere?**

You pick up a task and want to know whether someone in the company already solved it —
in this project, in the one next door, three years ago. The server searches merge request
titles across every GitLab project you belong to and returns concrete merge requests with
links. Your agent reads the titles and decides whether they answer the question; the server
does not decide that for you.

Search is semantic, so `two-factor authentication OTP` finds `Implement OTP-based 2FA
verification flow` without sharing a single word with it.

## Requirements

- **Node.js 22.13+** — the server uses the built-in `node:sqlite` module.
- **[ollama](https://ollama.com)** with the `bge-m3` embedding model (1.16 GB):
  ```bash
  ollama serve
  ollama pull bge-m3
  ```
- **A GitLab token** with the `read_api` scope. Put it in `~/.gitlab-token` (one line) or
  pass it as `GITLAB_TOKEN`.

Embeddings are computed locally. Nothing is sent to a third party.

## Build the index

The server searches a local SQLite file, not GitLab. Build it once:

```bash
GITLAB_HOST=https://gitlab.example.com npx @ruslan-aktaev/git-rewind-mcp index
```

It walks every project you are a member of, fetches merge requests, embeds their titles and
writes vectors and a full-text index into one file. On our instance a full run is 22 366
merge requests from 106 projects, about 100 MB, roughly 13 minutes. Run it again later and
it only fetches what changed.

The index stays on your machine. It is not part of the npm package and is never published —
it holds customer project titles.

## Connect it to an agent

```bash
claude mcp add git-rewind -e GITLAB_HOST=https://gitlab.example.com -- npx @ruslan-aktaev/git-rewind-mcp
```

Or, in a client config file:

```json
{
  "mcpServers": {
    "git-rewind": {
      "command": "npx",
      "args": ["@ruslan-aktaev/git-rewind-mcp"],
      "env": { "GITLAB_HOST": "https://gitlab.example.com" }
    }
  }
}
```

The server speaks stdio and starts instantly — the database opens on the first search.

## The tool

**`search_mrs(query, limit = 5)`** — `query` must be **English**. The index holds English
titles only; a query in another language misses what it should find, so the server rejects
Cyrillic input and asks for a translation. Your agent translates the question on its way in.

```
5 of 22366 merge requests, closest 0.762
words of the query, and how many merge requests contain each: two=24, factor=4, authentication=18, otp=16
both search methods agree on 8 candidates

0.762 [vector] acme/wallet-react-native !246 (2024-07-24)
  Implement OTP-based 2FA verification flow
  https://gitlab.example.com/acme/wallet-react-native/-/merge_requests/246
0.729 [both]   acme/insurance-nextjs !50 (2025-04-22)
  Implement Sign-in OTP
  https://gitlab.example.com/acme/insurance-nextjs/-/merge_requests/50
```

Three things in that output are there on purpose:

- **The score.** Below `0.675` the server returns no list at all and says nothing matched —
  a list of plausible-looking near misses is worse than an empty answer.
- **Word counts.** `otp=16` means sixteen merge requests contain that word; a zero means
  nobody on the team ever wrote it. Semantic search alone cannot tell you that.
- **`[vector]` / `[words]` / `[both]`** — which half of the search found the record.

## Configuration

| Variable | Default | What it is |
|---|---|---|
| `GITLAB_HOST` | — | required, e.g. `https://gitlab.example.com` |
| `GITLAB_TOKEN` | — | token with `read_api`; falls back to a file |
| `GITLAB_TOKEN_FILE` | `~/.gitlab-token` | where to read the token from |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | where ollama listens |
| `EMBED_MODEL` | `bge-m3` | changing it requires rebuilding the index |
| `INDEX_DB` | `~/.git-rewind/index.db` | the database file |

The server makes no assumptions about where it runs — bare `npx`, a container or a shared
service only change these values, never the code.

## For contributors

```bash
npm install
npm run build          # tsc → dist/
```

### Running the checks

There is one check, and it is the important one. The `0.675` cutoff is what keeps the server
from inventing answers, and it has a margin of `0.018` — almost anything you change in search
can move it. `eval` runs 21 labelled queries through the real search path:

```bash
GITLAB_HOST=https://gitlab.example.com node dist/index.js eval
```

```
21 of 21: 13 existing topics, 8 absent ones
worst find 0.685 | best miss 0.667 | margin 0.018
```

Thirteen queries are topics that exist in the index — each must be found *and* clear the
cutoff. Eight are invented (`nuclear reactor control panel`, `blockchain smart contract`) —
each must be rejected. The last line is the one to watch: if those two numbers converge, the
cutoff has stopped separating hits from misses and needs to be revisited, whatever the score
says.

It needs a built index and a running ollama, which is why it is a command rather than a unit
test. It takes about 1.6 seconds. `GITLAB_HOST` is required only because config loading is
shared with indexing — `eval` never touches GitLab.

### Layout

| File | What lives there |
|---|---|
| `src/index.ts` | entry point: the `search_mrs` tool, the `index` and `eval` commands |
| `src/search.ts` | hybrid search — meaning and words, and how the two are merged |
| `src/store.ts` | all the SQL: schema, vector search, full-text search, word counts |
| `src/indexer.ts`, `src/gitlab.ts` | building the index, walking the GitLab API |
| `src/embeddings.ts` | ollama, and the title cleanup that happens before embedding |
| `src/eval.ts` | the 21 labelled queries |

### Before you change anything

Read [.claude/SPEC.md](.claude/SPEC.md). It is the source of truth for what this project does
and why: what was measured, what was tried and rejected, and what is deliberately left out.
Code answers *how*; the spec answers *what and why*. Keep it updated in the same commit as
the code.

## Known limits

- **Only what the title says.** 62% of merge requests have an empty description and we do not
  index code. A feature shipped under the title `fix` cannot be found.
- **The index goes stale.** It is built by a command; new merge requests appear only when you
  run it again.
- **English queries only.** The index is entirely English, and a Russian query measurably
  misses records that are there.

## License

MIT
