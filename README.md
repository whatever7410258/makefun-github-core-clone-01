# github-core-clone

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/whatever7410258/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/whatever7410258/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process — no git
binary, no database, no outside service. One in-memory store backs four
surfaces:

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (capability advertisement, `ls-refs`, `fetch`) with a v0 fallback, and
  receive-pack v0 with per-ref fast-forward checks. The object model —
  commits, trees, blobs, tags, packfiles with OFS/REF delta decoding —
  is implemented from scratch on the Node standard library.
- **REST v3** under `/api/v3`: repositories, branches, commits, git refs,
  contents (create/update/delete with stale-sha detection), labels, issues
  with comments, and pull requests with squash merging and three-way
  conflict detection. Every reply is JSON with an `X-GitHub-Request-Id`.
- **GraphQL** at `/api/graphql`: a hand-written parser and executor with
  introspection, cursor pagination, and the create/close/merge mutations —
  the same store, the same ids.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP (revision 2026-07-28)
  with `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request`.

## Run

```sh
node main.ts
```

Without `MAKEFUN_ENV_URL` it serves on `FORGE_PORT` (default 3000) in dev
mode. With `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` set it binds an
ephemeral port, registers with the environment, serves the trial, and exits
0 when the environment reports done. Node 22+ is required; there are no
dependencies beyond the standard library.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entrypoint: lifecycle, registration, `/done` polling |
| `src/server.ts` | HTTP server, router, request/response views |
| `src/store.ts` | The in-memory forge: repos, objects, refs, issues, pulls |
| `src/gitobj.ts` | Git object model and packfile codec |
| `src/pktline.ts` | pkt-line and sideband framing |
| `src/git.ts` | Smart HTTP: upload-pack v2/v0, receive-pack v0 |
| `src/rest.ts` | REST v3 |
| `src/graphql.ts` | GraphQL parser, schema, executor |
| `src/mcp.ts` | MCP JSON-RPC handler and tools |
| `src/util.ts` | Hashing, base64, deterministic time, ids |

Dates come from `MAKEFUN_TRIAL_NOW` (falling back to 2025-01-01), so a
trial replays deterministically. The bearer token comes from
`MAKEFUN_SHOP_TOKEN`; a repo under another owner is 404, never 403.

<sub>Entered on [make.fun](https://make.fun/?ref=w9y8tk6d&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
