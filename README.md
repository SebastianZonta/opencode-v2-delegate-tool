# delegate

An [OpenCode](https://opencode.ai) plugin that lets any session — including subagents — spawn its own subagent for one self-contained subtask. Resumable, depth-limited, with background dispatch.

## What it gives you

- A `delegate` tool in every session's catalog: pass a complete brief as `task`, get back a summary plus a `childSessionID` for follow-ups.
- **Resume**: call again with that `sessionID` plus a follow-up — the child keeps full context.
- **Background**: `background: true` dispatches fire-and-forget and notifies you when the child finishes (like `ctrl+b` tasks); `waitOnly: true` collects manually.
- **Safety rails**: max nesting depth (default 3), per-subtask timeout (default 300s, child is interrupted and its partial result returned), and result truncation (default 4000 chars) so a verbose child can't flood the parent.
- A bundled `delegate` skill with usage rules, plus a one-line context hint so subagents discover the tool.

## Install

No dependencies, no build step — plain TypeScript run by OpenCode.

**From npm** (after `npm publish`; OpenCode 2 installs it automatically at startup):

```json
{
  "plugins": [{ "package": "opencode-v2-delegate-tool", "options": { "maxDepth": 3 } }]
}
```

**From local files**: copy this folder to `~/.config/opencode/plugins/delegate`
(global) or `.opencode/plugins/delegate` (project-level). Files in those
directories load automatically at startup.

> Note: the `opencode plugin <name>` CLI belongs to OpenCode 1. On OpenCode 2
> plugins are declared with the `plugins` list as above; this package exposes
> the `./server` entry point that v2 loads (there is no TUI part).

## Configure

All options are optional:

```json
{
  "plugins": [{ "package": "./plugins/delegate", "options": { "maxDepth": 3, "timeoutSeconds": 300, "maxResultChars": 4000 } }]
}
```

Or via env: `DELEGATE_MAX_DEPTH`, `DELEGATE_TIMEOUT_SECONDS`, `DELEGATE_MAX_RESULT_CHARS`.

## Use

```json
{ "task": "Explore how auth tokens refresh. Return: files involved, trigger, expiry handling. Under 20 lines." }
```

```json
{ "sessionID": "<childSessionID>", "task": "You found no refresh call — check background jobs and update your verdict." }
```

```json
{ "task": "Research X in the background.", "background": true }
```

## Develop

Layout: `index.ts` (orchestration), `src/types.ts` (context types), `src/pure.ts` (pure helpers), `index.test.ts` (suite).

```sh
node --test index.test.ts
```

Stdlib only — `node:test` + `node:assert`, no framework. The suite covers pure helpers and the `execute` paths (ownership, nesting limit, happy path, timeout) with a mocked context.

## License

Apache-2.0 — see [LICENSE](LICENSE).
