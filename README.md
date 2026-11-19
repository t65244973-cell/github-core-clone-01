# github-core-clone

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://img.shields.io/badge/make.fun-rank-blue)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://img.shields.io/badge/make.fun-reward-blue)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge: clone and push over smart HTTP,
repositories and issues over the REST v3 API, queries over GraphQL, and tools
over MCP — all served from one process and its own store, with no UI and no
outside service.

Built for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01)
"Build a GitHub-compatible git forge" ($500).

## Run it

Requires Node.js 22.18 or newer. No dependencies to install: the forge uses
only the Node standard library.

```sh
node main.ts
```

The entry point binds an ephemeral port, registers it with the suite through
`$MAKEFUN_ENV_URL`, and exits when the suite reports the run is done. For a
local smoke test, start it with a token and query it directly:

```sh
MAKEFUN_SHOP_TOKEN=test-token MAKEFUN_ENV_URL=http://127.0.0.1:1 node main.ts
```

(The run above exits 1 once registration fails, which is expected without a
suite; use the local runner in the kit to drive the forge properly.)

## Layout

- `main.ts` — entry lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — HTTP server and routing: `/healthz`, git smart HTTP,
  `/api/graphql`, `/mcp`, `/api/v3/*`.
- `store.ts` — the one in-memory model: repositories, git objects, refs,
  issues, pull requests, comments, labels. Deterministic: fixed timestamps,
  counter ids, no clock and no randomness in any response.
- `git.ts` — pkt-line framing, packfiles (read with delta resolution, write
  as full objects with a deflate cache), protocol v2 upload-pack (ls-refs,
  fetch with shallow/deepen) and v0 receive-pack (push with report-status).
- `rest.ts` — REST v3: repositories, branches, commits, contents, labels,
  issues, comments and pull requests, including squash merge.
- `graphql.ts` — GraphQL v4: a hand-rolled parser and executor for viewer,
  repository, issues, pull requests, mutations, `node`, and `__type`
  introspection, plus JSON-array batching.
- `mcp.ts` — MCP over Streamable HTTP: the 2026-07-28 `server/discover` era
  and the legacy `initialize` eras, with six tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`).

## Design notes

- One store, four surfaces: a repository or issue created over MCP is the
  same object over REST, GraphQL and git, because every surface reads and
  writes the same in-memory model.
- Git objects are stored byte-exact and hashed the way git hashes them
  (SHA-1 of `<type> <len>\0<data>`), so a clone returns exactly the bytes
  that were pushed.
- REST contents commits create real git objects and move branch refs, so a
  git clone after a contents write sees the same history, and vice versa.
- The viewer identity comes from the competition's scenario seed: the token
  owner is `adaiversen`, and any request bearing the suite token acts as
  that user.
- Everything is deterministic: two runs driven the same way leave the same
  state, because no response carries the wall clock or a random value.

## License

MIT — see [LICENSE](LICENSE).
