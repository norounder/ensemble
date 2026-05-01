# Ensemble — Release Checklist

## Resolved Since Last Update

- LICENSE present (MIT)
- README.md present
- CI workflow exists at `.github/workflows/ci.yml` (typecheck + lint; `npm test` step added in this group)
- CORS hardened: defaults to localhost-only, no `*`, configurable via `ENSEMBLE_CORS_ORIGIN` (`server.ts:13,16-20,40-52`)
- Rate limiting added: 100 req/60s per IP (`server.ts:14-15,94-105`)
- `tsconfig.json` already has `strict: true` (the prior P0 claim was false)
- `execAsync` is safe — `agent-runtime.ts:65-70` uses `sanitizeName()` allowlist
- `ensemble-bridge.sh` Python is safe — uses urllib + `json.loads`, no shell eval
- `CONTRIBUTING.md` added
- `.gitignore` added (this group additionally adds `.codex`)

## P0 — Release Blockers

| # | Issue | Location |
|---|-------|----------|
| 1 | Permissive agent flag defaults remain in `agents.json` (`--full-auto`, `--dangerously-skip-permissions`, `--yolo`); env override exists via `ENSEMBLE_AGENT_FLAGS` but defaults are unchanged | `agents.json` |
| 2 | No authentication on the HTTP API; only mitigated by 127.0.0.1 binding | `server.ts` |
| 3 | Secret env var leakage: spawner echoes `ANTHROPIC_*`, `OPENAI_*`, `NVIDIA_*` into tmux pane via `export KEY="$VALUE"` — visible to `tmux capture-pane` and replay HTML | `lib/agent-spawner.ts:58-62` |

## P1 — High Priority

| # | Issue | Location |
|---|-------|----------|
| 1 | JSONL message file has asymmetric locking — TS uses no lock for `appendMessage`, while `scripts/team-say.sh` uses Python fcntl. Two writers, two lock strategies — race condition under load. | `lib/ensemble-registry.ts:139` vs `scripts/team-say.sh` |
| 2 | `apiGet`/`apiPost` duplicated (~35 lines) | `cli/ensemble.ts:42-66`, `cli/monitor.ts:105-139` |
| 3 | `services/ensemble-service.ts` is 841 LoC with 6 mixed responsibilities (TeamMgr / MessageRouter / IdleDetector / Watchdog / AgentMgr / WorktreeMgr) | `services/ensemble-service.ts` |
| 4 | ~40 silent `.catch(() => {})` blocks across services and lib — failures invisible to users | services/, lib/ |
| 5 | Brittle prompt injection: relies on `readyMarker` string match in pane output; failure mode is silent 60s timeout | `lib/agent-spawner.ts` |
| 6 | Test files exist (~45 cases under `tests/`) but had no `npm test` script and weren't run in CI (fixed in this group) | `tests/`, `package.json` |
| 7 | AgentRuntime is advertised as pluggable but only `TmuxRuntime` exists; zsh-specific and tmux-specific commands leak across spawner and shell scripts | `lib/agent-spawner.ts`, `scripts/` |

## P2 — Medium Priority

- HTML replay generator XSS: `scripts/generate-replay.py` regex replacements wrap content in `<span>` after but bypass `html.escape` for severity tags / markdown-link substitutions
- CORS env var match uses `Array.includes()` exact match — not URL-aware, suffix-confusion risk if admin sets a bare hostname (`server.ts:40-52`)
- `X-Forwarded-For` trusted unconditionally — rate limit bypass when reachable directly (`server.ts:84-92`)
- No structured logging (75 `console.log` calls); no trace IDs; hard to correlate cross-agent failures
- `cli/monitor.ts` is 953 LoC — TUI rendering, HTTP polling, replay HTML generation all in one file
- API docs (OpenAPI/Swagger)
- Plugin/extensibility system for custom agent programs
- Persistent storage beyond JSONL (SQLite etc.)
- Health check endpoint improvements (more diagnostics)
- Configurable agent timeout/retry

## P3 — Low Priority

- `.env.example` was missing API key placeholders (fixed in this group)
- `.codex` zero-byte marker file unignored (fixed in this group)
- No `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, `dependabot.yml`
- Missing `X-Content-Type-Options: nosniff` header
- `workingDirectory` API parameter not validated against path traversal (mitigated by git boundary)

## Architecture & Code Quality

**Strengths:**
- Clean separation: types/ lib/ services/ cli/ scripts/ — well layered
- AgentRuntime abstraction is solid (though only one impl exists today)
- `sanitizeName` input sanitization in place
- TypeScript types well defined; `strict: true` on
- Tmux-based agent orchestration is differentiating vs. competitors

**Feature Gaps vs Competitors (CrewAI/AutoGen/LangGraph/Swarm):**
- No built-in tool/function calling framework
- No memory/context sharing between agents
- No workflow graphs or DAG support
- No observability/tracing
- No agent-to-agent protocol standard (only tmux messaging)

## Decided / Notes

- **Repo name:** `ensemble`
- **GitHub description (SEO):** Multi-agent collaboration engine for real-time team orchestration
- **README hero tagline:** Multi-agent collaboration engine — AI agents that work as one
- **License:** MIT
- **Position as:** "experimental developer tool", not "production framework"
- iTerm2 split-pane visibility for parallel agents shipped (see commits `9633491`, `c8c14dc`)

## Features to Borrow from Other Frameworks

| From | Feature |
|------|---------|
| CrewAI | Role definitions with goals, task decomposition, HITL |
| LangGraph | Checkpointing, state machines, conditional routing |
| AutoGen | Structured conversation patterns, sandboxing |
| Swarm | Handoff pattern, shared context variables, routines |
