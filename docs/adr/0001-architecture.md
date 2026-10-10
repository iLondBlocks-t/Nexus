# ADR 0001: NEXUS architecture

- **Status:** Accepted (Phase 1). Revisit when a Phase 7 item or a verification gap changes a premise below.
- **Date:** 2026-10-10
- **Scope:** Backend, frontend, coding-agent engine integration, workspace isolation, GitHub, Game Builder.

## Context

NEXUS lets a user describe a project in natural language. A real coding agent works in an isolated workspace to create, edit, run, test and debug it. Results must be downloadable or publishable to GitHub, and the state must survive a page refresh. The product is on a single developer machine or a small self-hosted server, with a zero-paid-service default.

Constraints that shape the design (from the project brief): prefer free and open-source components; no paid subscription in the core path; never expose an unauthenticated agent server to the internet; never execute generated code inside the public web server; keep model providers and engines behind adapters; all secrets encrypted at rest and never sent to the browser; minimum-scope GitHub OAuth.

## Decision

### 1. Monorepo, TypeScript end to end
- npm workspaces: `packages/shared` (Zod request/response contracts), `apps/api` (Node 22 + Fastify 5), `apps/web` (Vite + React 19).
- Zod validates every request body on the server; the same schemas are shared with the web client.
- TypeScript pinned to 5.9.x. Exact versions are pinned for the web app and the security-relevant API dependencies.

*Alternative considered:* Next.js. Rejected for the MVP: the agent and job runner need long-lived processes, SSE and a separate sandboxed child process model, which fit a plain Node server better than serverless-shaped routes. Next.js 16 is MIT but adds a framework surface we do not need.

### 2. SQLite via `node:sqlite`, numbered SQL migrations
- No native dependency to compile. WAL mode, foreign keys on, idempotent migrations in `apps/api/migrations`.
- A Postgres migration path is documented, not implemented. Move when there is more than one API process.

### 3. Persisted event log with resumable SSE
- Every project event is written to the `events` table (sequence number, redacted payload) before it is published.
- `GET /api/projects/:id/events` replays from `Last-Event-ID` (or `?after=`), then streams live. Clients refetch state on events rather than trusting a stream as the source of truth.
- Verified with a live HTTP listener (replay, resume without duplicates, live delivery, cross-user refusal).

### 4. Agent engine: OpenCode behind an adapter
- `AgentEngine` interface (`apps/api/src/engines/types.ts`). The only implementation is OpenCode (`engines/opencode/`), using its documented HTTP server and SDK types. OpenHands is deferred (see below).
- One `opencode serve` process per project, bound to `127.0.0.1` with a random per-process password (HTTP basic). Idle engines stop. A maximum concurrency is enforced (`NEXUS_MAX_ENGINES`).
- The engine process runs inside the same namespace sandbox as jobs, with network enabled (a model call needs it), with the NEXUS data directory hidden and only its own workspace and engine home visible.
- Engine state (`XDG_*`, `HOME`) is isolated under the NEXUS data directory so the host's OpenCode configuration and credentials are never read.
- `OPENCODE_DISABLE_*` flags stop a repository's own configuration, plugins, share links, auto-update and model fetching from changing NEXUS's policy. Permission config is injected via `OPENCODE_CONFIG_CONTENT`: `bash` and `edit` are `ask`, `webfetch` is `deny`, and `external_directory` is `deny`. Each permission request becomes a NEXUS approval record.
- Verified: OpenCode 1.18.35 starts inside the sandbox, lists 226 providers, recognises an injected key, confirms a model, creates sessions, accepts messages, and reports provider failures as data (this sandbox has no provider network access).
- **Not verified:** a complete model-driven turn that edits files. It needs provider network access.

*Alternative considered:* running OpenCode outside the sandbox. Rejected: its shell tool would run on the host with access to the NEXUS database and keys.

### 5. Provider keys: encrypted at rest, injected per engine process
- Keys are encrypted with AES-256-GCM using a server master key (`NEXUS_ENCRYPTION_KEY`, or a generated `NEXUS_DATA_DIR/.secret-key` with mode 0600 in development; required in production).
- Keys are write-only in the API and UI. They are injected as an environment variable into the engine process, never written to disk (verified by scanning engine and workspace files for the key).
- **Known limitation:** the engine process can read its own environment, so a model can in principle read the key through an approved shell command. Mitigation: `bash` approval is required by default, and keys should be scoped and revocable at the provider.

### 6. Command execution: policy, approval, and a namespace sandbox
- `evaluateCommand` (`sandbox/policy.ts`) returns `deny`, `approval`, or `allow`. Denied commands are recorded as denied jobs; approval-required jobs wait for an explicit decision. The policy is a guard rail, not the boundary.
- The boundary is `unshare -rmn` (user, mount and network namespaces). The workspace and engine home are bind-mounted; NEXUS secrets and the data directory are replaced by an empty tmpfs; network is off unless the job is approved with `network: true`; limits use `ulimit` (CPU time, data segment, file size) and a wall-clock timeout; the environment is scrubbed; output is capped at 1 MiB; jobs can be cancelled or emergency-stopped.
- Fail closed: the sandbox script runs with `set -e`, so a failed mount aborts the job. If namespaces are unavailable, or `NEXUS_SANDBOX_MODE=disabled` is set, command jobs fail and the agent engine refuses to start.
- Verified: network blocked inside the sandbox; NEXUS key file not readable from a job; data directory empty; cancellation and emergency stop terminate running jobs; the policy denies `rm -rf /` and paths such as `/root`.
- **Limitation:** namespaces are not a container. A determined kernel exploit or a misconfigured host is out of scope. Production deployments should run NEXUS in a dedicated VM or container with the sandbox as a second layer (see `docs/DEPLOYMENT.md`). Docker is absent in the build environment, so container-based hardening is unverified.
- **Policy decision:** node, python3, npm, pnpm, git, make, tsc, vitest and godot run automatically inside the sandbox (projects need tests and builds to work). Installs, `curl`/`wget`, `npx`, `gh`, and `git push`/`remote`/`config` require approval. Sleep-like or unknown programs require approval.

### 7. Workspace isolation and path safety
- Each project has its own workspace directory (random id) under `NEXUS_DATA_DIR/workspaces`, with its git metadata kept outside the workspace (`gitHome`). The `.git` directory is not reachable through the API.
- `resolveWorkspacePath` rejects absolute paths, backslashes, NUL bytes, `..` segments, protected segments (`.git`, `.nexus`), and symlinks that resolve outside the workspace. Writes are atomic.
- Git runs with hardening flags (no hooks, no pager, no external diff, no fsmonitor) and a temporary index for diffs, so the real index is never touched.
- Verified by tests for traversal, absolute paths, backslashes, protected paths, a symlink escape, and cross-user access.

### 8. Authentication, sessions, CSRF
- Passwords: scrypt. Sessions: random tokens stored as SHA-256 hashes, 7-day TTL, `HttpOnly`, `SameSite=Lax` cookie.
- Every state-changing request needs a matching `X-CSRF-Token` and a same-origin `Origin` (or no `Origin` from non-browser clients). Cross-user access returns 404 (not 403) to avoid confirming existence.
- Security headers: CSP (`default-src 'self'`), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, HSTS in production. Rate limits on registration, login, project creation and imports.
- Verified by tests: wrong password, duplicate registration, CSRF rejection, cross-site Origin rejection, null Origin rejection, logout, and session token hashing at rest.

### 9. GitHub: minimum scopes, new branches only, secret scan
- OAuth scopes: `public_repo read:user` by default; `repo read:user` only for private repositories. Tokens are encrypted at rest and never returned to the browser.
- Cloning and pushing pass the token through a per-process `GIT_CONFIG_*` HTTP header, never in argv, the URL, or `.git/config`.
- Publishing always creates a new branch, requires `confirmPublish: true`, refuses `main`/`master` and the source branch, refuses existing local branches, validates names with `git check-ref-format`, and runs a credential-pattern scan over the diff before anything is committed or pushed. Nothing is created or switched until there is something to publish.
- Verified without network: all of the above refusal paths, plus the secret-scan refusal. **Not verified:** the live OAuth round trip, a real push, and a real pull request. No GitHub write was performed during development.

### 10. Frontend: small, accessible, bilingual
- React 19 with a hand-rolled i18n layer (English and Arabic). Arabic switches `dir="rtl"` on the document; styles use logical properties.
- CodeMirror 6 for editing (the packages are pinned to one version set to avoid duplicate copies). Diffs are rendered from the server's unified patch. No component library.
- Midnight theme by default with restrained purple and blue accents; a light theme is optional. Narrow screens stack the editor above the side panel.
- Verified: typecheck, lint, production build, and the SPA shell and assets served by the API. **Not verified:** interaction in a real browser (no browser is available in the build environment).

### 11. Game Builder: Godot 4, 2D first
- The "Godot 4 · 2D arena" template is plain text (`project.godot`, GDScript, text `.tscn`), so every file is reviewable and diffable in git.
- Placeholder sprites and sound effects are generated by NEXUS (PNG and WAV encoders) and documented in `ASSETS.md` as generated placeholders, with the licence stated. No third-party or scraped assets are used.
- A static validator (`gamebuilder/validate.ts`) checks `project.godot`, every `res://` reference, every `ext_resource` and `sub_resource`, node paths used by scripts against the scene that owns them, bracket balance, indentation style, and PNG/WAV headers. Verified on the generated project (passes) and against a deliberately broken node path (fails).
- **Not verified:** a headless Godot run. The Godot binary is not available in the build environment, and official release downloads are unreachable from it. The validator is a substitute, not a replacement, and the README says so.
- 3D is out of scope for this iteration.

## Consequences

- Positive: each boundary (engine, sandbox, GitHub, provider) is replaceable; security checks are testable without external services; the build has zero paid dependencies.
- Negative: namespaces are weaker than containers or VMs; SQLite limits horizontal scaling; the agent engine can read its own provider key; approved agent shell commands have network access.
- Operational: the sandbox requires unprivileged user namespaces on the host. Ubuntu 24.04 restricts them by default (`kernel.apparmor_restrict_unprivileged_userns`); the CI workflow and deployment guide say how to handle this.

## Deferred and rejected

- **OpenHands adapter (deferred).** Its SDK package availability was not verified from the build environment (`openhands-sdk` was not found on PyPI there). The `AgentEngine` interface is the seam for it.
- **Paid hosting, managed databases, object storage (rejected for the default path).** SQLite and the local data directory are the default. Any paid service requires explicit owner consent.
- **Public multi-tenant hosting (not recommended yet).** Use a single-owner or trusted-team deployment until the sandbox has been reviewed in a VM or container.
- **Licence (open decision).** The repository is `UNLICENSED` until the owner picks one.
