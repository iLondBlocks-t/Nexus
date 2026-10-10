# NEXUS

NEXUS is a browser-based AI development platform. You describe a project in plain language. A coding agent (OpenCode, behind an adapter) works in an isolated workspace to create, edit, run, test and debug it. You watch the agent's messages, approve risky actions, read the diffs, run commands with logs, and download the result or publish it to a new GitHub branch.

It also includes a **Game Builder** that generates a complete **Godot 4 2D** project (a small top-down arena brawler) from a template.

> **Status: working end-to-end backend and web app, with honest gaps.** The backend, security checks, sandbox, agent engine startup, SSE, GitHub guards and Godot template are verified by 76 automated tests and by running the server. Some flows cannot be verified in the build environment: a real model-driven agent turn, a live GitHub OAuth/push/PR, a Godot headless run, and interaction in a real browser. See [What is verified](#what-is-verified-and-what-is-not).

## Quick start

Requirements: Node.js 22.13 or newer, npm 10, git, and a Linux host that allows unprivileged user namespaces (needed by the command sandbox).

```sh
npm install
npm run build                      # shared package, web app, API
cp .env.example .env               # then edit values; never commit .env
set -a; . ./.env; set +a           # NEXUS reads its configuration from the environment
npm start -w @nexus/api            # API + built web app on NEXUS_HOST:NEXUS_PORT (default 127.0.0.1:8787)
```

Open `http://localhost:8787`, create an account (the first account becomes admin), add a model provider in **Settings**, then create a project.

Development with hot reload:

```sh
npm run dev:api     # API on 127.0.0.1:8787
npm run dev:web     # Vite on 0.0.0.0:5173, proxies /api to the API
```

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript strict check for shared, API and web |
| `npm run lint` | ESLint (typescript-eslint, react-hooks) |
| `npm test` | 76 API tests (unit and integration, real sandbox and real OpenCode engine) |
| `npm run build` | Builds shared, web and API (copies migrations into `apps/api/dist`) |
| `npm run validate:godot -w @nexus/api -- <project-dir>` | Static check of a Godot project (see Game Builder) |

## Architecture

```
packages/shared     Zod request schemas and public response shapes (shared by API and web)
apps/api            Fastify 5 API, SQLite (node:sqlite), SSE event log, job runner, GitHub, Game Builder
  src/engines/      AgentEngine interface; OpenCode adapter (one `opencode serve` per project)
  src/sandbox/      Command policy and the namespace sandbox (unshare -rmn)
  src/services/     Workspaces, git, events, jobs, artifacts, project detection
  src/gamebuilder/  Godot 4 2D template, procedural PNG/WAV placeholders, static validator
apps/web            Vite + React 19 single-page app (EN/AR, RTL, midnight/light themes)
docs/adr/           Architecture decision records
docs/TASKS.md       Task checklist and status
docs/DEPLOYMENT.md  Deployment and operations guide
```

The full rationale and alternatives are in [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md).

### How a request flows

1. You send a message. The API validates it, checks your daily quota, and records the message.
2. The API ensures an OpenCode server is running for this project. It runs inside the sandbox, bound to `127.0.0.1` with a random password, and receives your provider key as an environment variable.
3. The agent works in the project workspace. Each action that needs permission (a shell command or an edit, depending on settings) becomes an **approval** you can accept or refuse.
4. Everything that happens is written to the project's event log, then streamed to the browser over SSE. If the page refreshes or the network drops, the browser reconnects and the server replays what it missed.
5. Commands you run from the Terminal go through the command policy and the sandbox, and their output is stored and capped.

## Security model

NEXUS treats repository contents, README files, generated scripts, downloaded assets and model output as untrusted.

- **Authentication:** scrypt password hashes. Session tokens are random, stored only as SHA-256 hashes, expire after 7 days, and live in an `HttpOnly`, `SameSite=Lax` cookie.
- **Authorization:** every project route checks ownership on the server. Another user's project returns 404.
- **CSRF and origin:** state-changing requests need a matching `X-CSRF-Token` header and a same-origin `Origin`. Cross-site and `null` origins are refused.
- **Headers:** a strict Content-Security-Policy, `frame-ancestors 'none'`, `nosniff`, a referrer policy, and HSTS in production. Rate limits apply to sign-in, registration, project creation and imports.
- **Paths:** workspace paths are validated server-side. Absolute paths, backslashes, `..`, `.git` and `.nexus` segments, NUL bytes, and symlinks that escape the workspace are refused.
- **Secrets:** provider keys and GitHub tokens are encrypted at rest (AES-256-GCM with a master key). They are write-only in the API, never returned to the browser, never written to the workspace or logs, and redacted from events. Keys are passed to the engine as environment variables.
- **Commands:** the policy returns *allow*, *approval* or *deny*. Denied commands are recorded. Network access and installs need approval. Commands run in a namespace sandbox with the network off (unless approved), the NEXUS data directory hidden, scrubbed environment, CPU and memory limits, a timeout, and capped output.
- **Engine isolation:** the OpenCode server is never reachable from the network. It runs with its own HOME and XDG directories, so your host's OpenCode settings are not read, and repository configuration cannot switch on sharing or plugin installs.
- **GitHub:** minimum OAuth scopes (`public_repo read:user` by default). Publishing always creates a new branch, requires an explicit confirmation, refuses the default branch, and blocks the push if the diff contains credential-shaped values.

**Known limits.** Namespaces are a strong layer but not a container or a virtual machine. The agent engine can read its own provider key, and an approved agent shell command can reach the network, because the engine needs network access for model calls. Do not expose NEXUS to untrusted users on the open internet without a reviewed deployment (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Configuration

All configuration comes from environment variables. [`.env.example`](.env.example) lists them with safe placeholder values. The API does not load `.env` by itself; export the variables or use `set -a; . ./.env`.

Important variables:

- `NEXUS_ENV` (`development`, `test`, `production`), `NEXUS_HOST`, `NEXUS_PORT`, `NEXUS_PUBLIC_ORIGIN`
- `NEXUS_DATA_DIR` (database, workspaces, engine state, artifacts, generated secret key in development)
- `NEXUS_ENCRYPTION_KEY` (32 random bytes, base64; **required in production**)
- `NEXUS_ALLOW_REGISTRATION`, `NEXUS_OPENCODE_BIN`, `NEXUS_MAX_ENGINES`, `NEXUS_ENGINE_IDLE_MINUTES`
- `NEXUS_SANDBOX_MODE` (`namespace` or `disabled`; `disabled` refuses all command execution and does not start the agent), `NEXUS_JOB_TIMEOUT_SECONDS`, `NEXUS_JOB_MEMORY_MB`
- `NEXUS_QUOTA_AGENT_MESSAGES_PER_DAY` (default 200), `NEXUS_QUOTA_COMMANDS_PER_DAY` (default 500), per user per UTC day
- `NEXUS_GITHUB_CLIENT_ID`, `NEXUS_GITHUB_CLIENT_SECRET` (optional; OAuth App callback is `${NEXUS_PUBLIC_ORIGIN}/api/github/oauth/callback`)

## Model providers

Providers come from OpenCode's catalog, which lists about 226 providers. Choose one in **Settings**, paste a key, and use **Test configuration**. The test checks that the engine recognises the key and the model, and it does **not** make a live model call (the response says so).

The catalog marks a model as *reported free* when its listed price is zero. That is the catalog's claim, not a guarantee. Check the provider's current terms, quotas and rate limits before relying on any model. NEXUS does not promise free inference or unlimited usage, and it never switches to a paid provider on its own.

## Game Builder (Godot 4, 2D)

Create a project with the template **Godot 4 · 2D arena**. It contains:

- `project.godot` (Godot 4 config), a main menu, an arena, a player, a slime enemy, a HUD, a game autoload, and a headless smoke test script
- text scenes (`.tscn`) and GDScript, so every file is reviewable in git
- generated placeholder sprites and sound effects (PNG and WAV), described in `ASSETS.md` with their provenance. They are **placeholders**, not finished art, and no third-party or scraped assets are included

To check a project without Godot:

```sh
npm run validate:godot -w @nexus/api -- /path/to/project
```

The validator checks `project.godot` entries, every `res://` reference and `ext_resource`, node paths that scripts use with `$` against the scene that owns them, bracket balance, indentation style and PNG/WAV headers. It is **static**: it does not run the game.

To run the game, open the project folder in Godot 4.x and press Play. A headless test is included in `scripts/tests/smoke_test.gd`. **This has not been run** in the build environment (no Godot binary there). Gameplay feel and visual quality need a human playtest.

3D is not implemented yet. It is scoped to a later phase.

## GitHub

Connect GitHub in **Settings** (requires `NEXUS_GITHUB_CLIENT_ID` and `NEXUS_GITHUB_CLIENT_SECRET` on the server). Public repositories can be imported without connecting. Publishing:

1. Review the diff in the **Changes** tab (the server also runs a secret scan).
2. In **GitHub**, enter a message, optionally a branch name, and tick the confirmation box.
3. NEXUS creates a **new branch**, commits, and pushes. Default and source branches are never written directly.
4. Optionally open a pull request with the same confirmation step.

## What is verified and what is not

**Verified by automated tests (76 tests, run repeatedly):**

- Authentication, session tokens at rest, wrong password, duplicate registration, logout, CSRF, Origin and null-origin refusal, security headers.
- Cross-user access (404), path traversal and protected paths, symlink escape, root listing.
- Command policy (deny, approval, allow), approvals, cancellation, emergency stop.
- Sandbox: network blocked, secret key and data directory hidden from job processes; `NEXUS_SANDBOX_MODE=disabled` refuses commands and the agent.
- Settings: key never returned, stored encrypted, never written to the engine home or the workspace.
- Real OpenCode 1.18.35 engine started inside the sandbox: catalog, provider configuration test, session creation, message acceptance, and honest reporting of a provider failure. Agent busy-guard.
- Event log: persisted replay, live SSE stream, resume without duplicates, cross-user refusal.
- Artifacts: ZIP export excludes `.git` and `node_modules`-style build folders, records a SHA-256 checksum, and downloads are scoped to the owner.
- GitHub publishing guards (refusals and the secret scan, with no network access).
- Godot template generation and the static validator (passes on the project, fails on a broken node path).

**Verified by build and run checks:** typecheck, lint, production build, `npm audit` (zero advisories at the time of writing), and the built server run over HTTP: the web shell, deep link and JSON 404; registration with a CSRF token; a write without a CSRF token refused (403); Godot template project creation; file write and read; command policy (`node -e` ran and printed 42, `curl` waited for approval, `rm -rf ~` was denied). This is an HTTP check, not a browser check.

**Not verified (and why):**

- A **model-driven agent turn** that edits files. The build environment cannot reach model providers.
- **GitHub OAuth, live push and pull request.** No GitHub writes were made during development.
- **Godot headless run.** No Godot binary in the build environment, and the official release host is unreachable from it.
- **Interaction in a real browser** (clicking through the UI, RTL layout, mobile widths). No browser is available in the build environment, so only the build and the served assets were checked.
- **Container or VM isolation**, and performance under load.
- **Arabic copy review.** The Arabic strings are written but have not been reviewed by a native speaker.
- **CI run.** The workflow is written but has not been executed on GitHub yet.

## Licence

No licence has been chosen yet; the package is marked `UNLICENSED`. The project owner needs to pick one before the code is shared more widely.

Third-party components include OpenCode (MIT), Fastify (MIT), Zod (MIT), React (MIT), Vite (MIT), CodeMirror (MIT), and adm-zip (MIT). Check each package's licence in `node_modules` before distribution.
