# NEXUS task checklist

Status key: **[x]** done and verified · **[~]** built, partly verified (see note) · **[ ]** not done · **[-]** deliberately deferred

Last updated: 2026-10-10. Verification evidence is in the README ("What is verified and what is not").

## Phase 1: Audit, README, ADR, checklist
- [x] Audit the repository and its history (single initial commit; `main` and the working branch)
- [x] Architecture decision record: `docs/adr/0001-architecture.md`
- [x] README with quick start, security model, configuration, verification status
- [x] This checklist
- [x] `.env.example` with placeholders only; `.gitignore` covers `.env`, databases, data, keys, and build output

## Phase 2: Runnable foundation
- [x] npm workspaces: shared contracts, API, web
- [x] Strict TypeScript, ESLint, production build, `npm audit` clean
- [x] Fastify API with validated config, security headers, CSRF, Origin checks, error envelope
- [x] Register, login, logout, session, rate limits, first account becomes admin
- [x] SQLite migrations (WAL, foreign keys), audit log, usage records
- [x] Web app: sign-in, projects, workspace, settings, English and Arabic with RTL, midnight and light themes
- [~] Responsive and accessible layout: CSS for narrow screens and focus styles written; not checked in a real browser
- [x] API serves the built web app (verified over HTTP)

## Phase 3: Real agent engine (OpenCode)
- [x] `AgentEngine` interface and OpenCode adapter behind it
- [x] Per-project `opencode serve` on 127.0.0.1 with random password, idle stop, concurrency cap
- [x] Permission policy injected (bash and edit ask, webfetch deny, external directory deny); `OPENCODE_DISABLE_*` flags verified in the binary
- [x] Engine started inside the sandbox; catalog (226 providers); provider test (no live call); session creation; message acceptance; honest failure reporting
- [x] Key injected as an environment variable only; verified not written to disk
- [~] Agent turn that edits files: **not verified** (no provider network in the build environment)
- [x] Agent state, messages, cancel, new conversation, busy guard
- [-] OpenHands adapter: deferred. SDK availability not verified from the build environment

## Phase 4: Workspace isolation and execution
- [x] Per-project workspaces with git metadata outside the workspace
- [x] Path validation (traversal, absolute, backslash, NUL, protected segments, symlink escape)
- [x] Command policy (deny, approval, allow), recorded denials, approvals
- [x] Namespace sandbox: network off unless approved, secrets hidden, scrubbed environment, ulimits, timeout, output cap
- [x] Cancellation and emergency stop
- [x] Daily quotas for commands and agent messages
- [~] Container or VM hardening: **not verified** (no Docker in the build environment); documented as a deployment requirement

## Phase 5: GitHub and persistence
- [x] OAuth start and callback with minimum scopes; token encrypted; never returned to the browser
- [x] Import of public repositories and project detection (read-only)
- [x] Publish to a new branch with confirmation, default-branch refusal, branch-name validation, existing-branch refusal, secret scan
- [x] Pull request creation with confirmation
- [x] Guard tests (no network)
- [ ] Live OAuth round trip, live push, and live pull request: **not verified** (no GitHub writes made during development)
- [x] Refresh-safe state: projects, messages, jobs, approvals, events and artifacts are persisted; SSE resumes from the last sequence number

## Phase 6: Game Builder
- [x] Godot 4 2D "Arena Brawler" template: project, main menu, arena, player, enemy, HUD, autoload, headless smoke test, scenes, and documentation
- [x] Generated placeholder PNG and WAV assets with provenance in `ASSETS.md`; no third-party or scraped assets
- [x] Static Godot validator (`npm run validate:godot`); passes on the template, fails on a broken node path (tested)
- [ ] Headless Godot run of the smoke test: **not verified** (no Godot binary in the build environment)
- [ ] Human playtest for feel and balance
- [-] 3D game template: deferred (scoped to a later phase)

## Phase 7: Reliability, CI and deployment
- [x] Automated tests: 76 across 7 files (auth, authorization, paths, policy, sandbox, secrets, quotas, SSE, artifacts, GitHub guards, OpenCode engine, Godot validator)
- [~] Graceful shutdown (verified by code review and the server start/stop run); recovery of interrupted jobs and agent sessions on restart (implemented, startup logs zero recovered jobs in the run; not exercised by a test)
- [x] `docs/DEPLOYMENT.md`
- [~] CI workflow `.github/workflows/ci.yml`: written, **not yet run on GitHub**
- [ ] Reverse proxy and TLS configuration tested on a real host
- [ ] Backup and restore procedure exercised

## Phase 8: Final verification and report
- [x] `npm run typecheck`, `npm run lint`, `npm test` (76 pass), `npm run build`
- [x] HTTP smoke test of the built server: register with CSRF, Godot template project, file write and read, command allow / approval / deny (no browser)
- [x] `NEXUS_SANDBOX_MODE=disabled` refuses command jobs and agent start (`sandbox-disabled.test.ts`)
- [x] Live server check over HTTP (SPA, assets, auth, CSRF, file writes)
- [ ] End-to-end demo in a real browser: create project, real agent session, file edits, permitted command, logs in UI, diagnose and repair an error, diff review, download or push. **The browser and model-driven parts are not verified**
- [ ] Owner decision: licence (currently `UNLICENSED`)
- [ ] Owner decision: production hosting, public exposure and any paid service (none chosen)

## Known issues and follow-ups
- The web bundle is about 830 kB before gzip; split it with dynamic imports when it matters.
- The job output query filters JSON text with `LIKE`; move to a structured column when job volume grows.
- Arabic copy is unreviewed by a native speaker.
- `npm test` takes about 30 seconds and needs user namespaces on the host.
