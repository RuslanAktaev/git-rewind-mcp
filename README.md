<p align="center">
  <img src="assets/logo.png" alt="git-rewind-mcp" width="200">
</p>

<h1 align="center">git-rewind-mcp</h1>

<p align="center">
  An MCP server that answers one question: <b>have we built this before, anywhere?</b>
</p>

You pick up a task and want to know whether someone in the company already solved it —
in this project, in the one next door, three years ago. The server searches merge request
titles across every GitLab project you belong to and returns concrete merge requests with
links. Your agent reads the titles and decides whether they answer the question; the server
does not decide that for you.

Search is semantic, so `two-factor authentication OTP` finds `Implement OTP-based 2FA
verification flow` without sharing a single word with it.

## Why not just search GitLab?

Fair question, and it was measured rather than argued. GitLab's own merge request search
takes exact words — every word of the query has to occur in one title, matched as a substring,
with no synonyms, no stemming and no relevance ranking. An agent can paper over that by firing
several wordings at it. So the two were put side by side on 13 labelled topics: this server
answered each with one query, while an agent that had never seen the index wrote five keyword
variants per topic and fired all of them at the API.

| | this server | GitLab API + an agent guessing words |
|---|---|---|
| topics whose merge requests were found | 13 of 13 | 12 of 13 |
| queries | 13 | 65 |
| wall clock | ~1 s | ~146 s |
| titles returned | 65 | 521 |
| of those, on topic | 71% | 43% |
| context per query | ~150 tokens | ~1,200 filtered, ~16,200 raw |

Two of those rows carry the verdict.

**Noise.** A merge request comes back from the API with 50 fields; two of them are useful here.
Filtering that down to titles and links takes a shell and a correct `jq` pipeline, which a
client without a shell does not have. Unfiltered, one query costs 16 thousand tokens and a
handful of wordings costs eighty — for a question a compact answer settles in a hundred and
fifty.

**Guessing.** Keyword search finds a feature only if you already use the word the team used in
the title. The agent's variants were good, and mostly the question's own words are the title's
words too — but on one topic in thirteen they diverged, and the API returned nothing at all,
which reads exactly like "we never built this".

What this is *not* about is reach. A token reaches every project it can see without cloning
anything, so "the merge requests are unreachable from a laptop" would be false. The argument
for this server is a short, ranked, low-noise answer and a calibrated *no* — not access, and
not recall. Where keyword search stays better: an exact rare string, and freshness, since it
queries GitLab live while this index is only as new as its last run.

Honest limits of the comparison: 13 topics is a small sample, the labelled queries were
written by someone who had seen the index, and "on topic" was judged by a regular expression
over titles, which is blunt in both directions.

## Requirements

- **Node.js 22.13+** — the server uses the built-in `node:sqlite` module.
- **[ollama](https://ollama.com)** with the `bge-m3` embedding model (1.16 GB):
  ```bash
  ollama serve
  ollama pull bge-m3
  ```
- **A GitLab token** with the `read_api` scope — for building the index, not for searching
  it. Put it in `~/.gitlab-token` (one line) or pass it as `GITLAB_TOKEN`.

Embeddings are computed locally. Nothing is sent to a third party.

## Build the index

The server searches a local SQLite file, not GitLab. Build it once, with ollama running:

```bash
GITLAB_HOST=https://gitlab.example.com npx @ruslan-aktaev/git-rewind-mcp index
```

It walks every project you are a member of, fetches their merge requests, embeds the titles
and writes vectors and a full-text index into a single file:

```
model bge-m3: 1024 dimensions
building the index from scratch
projects: 142
  [1/142] acme/wallet-react-native: 2269 merge requests
  [2/142] acme/insurance-nextjs: 418 merge requests
  ...
done: 22366 merge requests from 106 projects, 22366 in the index
database: /Users/you/.git-rewind/index.db
```

On our instance that is 22 366 merge requests from 106 projects, about 100 MB and roughly
13 minutes — most of it spent embedding. The first thing it does is ask the model for one
test vector, so a missing ollama or a missing model fails in a second rather than after ten
minutes of fetching.

**Keeping it fresh.** Run the same command again. It remembers when it last ran and asks
GitLab, in a single request, only for merge requests updated since — a repeat run takes a
couple of seconds. There is no scheduler: the index is only as fresh as the last run.

**Rebuilding from scratch.** Delete the file and run `index` again. You need this if you
switch `EMBED_MODEL` — vectors from different models are not comparable, so the server
refuses to open an index built by another model instead of silently returning nonsense.

The index stays on your machine. It is not part of the npm package and is never published —
it holds your customers' project and branch names.

## Connect it to an agent

```bash
claude mcp add git-rewind -- npx @ruslan-aktaev/git-rewind-mcp
```

Or, in a client config file:

```json
{
  "mcpServers": {
    "git-rewind": {
      "command": "npx",
      "args": ["@ruslan-aktaev/git-rewind-mcp"]
    }
  }
}
```

The server speaks stdio and starts instantly — the database opens on the first search. It
needs no GitLab host and no token: searching reads the local index, and only `index` talks to
GitLab. Set `INDEX_DB` here if the file does not live in the default place.

## The tool

**`search_mrs(query, limit = 5)`** — `query` must be **English**. The index holds English
titles only; a query in another language misses what it should find, so the server rejects
Cyrillic input and asks for a translation. Your agent translates the question on its way in.

```
5 of 22366 merge requests, closest 0.762
words of the query, and how many merge requests contain each: two=24, factor=4, authentication=18, otp=16
both search methods agree on 8 candidates

Include the links below in your answer — the user needs to open them.

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

The line about links is aimed at the agent, not at you: left to itself it retells the findings
in its own words and drops the links, and an answer you cannot open is an answer you cannot
check.

## Configuration

| Variable | Default | What it is | Needed by |
|---|---|---|---|
| `GITLAB_HOST` | — | e.g. `https://gitlab.example.com` | `index` |
| `GITLAB_TOKEN` | — | token with `read_api`; falls back to a file | `index` |
| `GITLAB_TOKEN_FILE` | `~/.gitlab-token` | where to read the token from | `index` |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | where ollama listens | both |
| `EMBED_MODEL` | `bge-m3` | changing it requires rebuilding the index | both |
| `INDEX_DB` | `~/.git-rewind/index.db` | the database file | both |

These can also live in a `.env` file in the working directory — copy `.env.example` and fill
it in. Real environment variables win over the file, and `.env` is gitignored.

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
node dist/index.js eval
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
test. It takes about 1.6 seconds. Like the server, it never touches GitLab.

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
