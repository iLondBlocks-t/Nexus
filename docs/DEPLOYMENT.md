# NEXUS deployment guide

This guide describes how to run NEXUS on a single host for one owner or a small trusted team. It is **not** a recipe for open public multi-tenant hosting. Read the security model and the known limits in the README first.

## 1. Host requirements

- Linux with unprivileged user namespaces. Check with `unshare -rmn true && echo ok`. On Ubuntu 24.04 and later, AppArmor may block them; if so, set `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (or write an AppArmor profile for NEXUS). If namespaces are unavailable, NEXUS fails closed: command jobs fail and the agent engine refuses to start. `NEXUS_SANDBOX_MODE=disabled` has the same effect on purpose, so the agent cannot run at all in that mode.
- Node.js 22.13 or newer, npm 10, git.
- Disk for the data directory: project workspaces, the database, engine state and exports. Plan for at least a few GB; exports are capped at 200 MB each.
- Memory: each active OpenCode engine is a separate Node process. Start with about 2 GB and `NEXUS_MAX_ENGINES=2`.

## 2. Build and install

```sh
git clone <your fork> nexus && cd nexus
npm ci
npm run build
```

Run `npm run typecheck`, `npm run lint` and `npm test` before you deploy. The tests need the host to allow user namespaces.

## 3. Configuration

Copy `.env.example` to `.env` **outside version control** or in a secrets manager, and set at least:

```sh
NEXUS_ENV=production
NEXUS_HOST=127.0.0.1                     # listen only on loopback; the reverse proxy is public
NEXUS_PORT=8787
NEXUS_PUBLIC_ORIGIN=https://nexus.example.com
NEXUS_DATA_DIR=/var/lib/nexus            # owned by the service user, mode 0700
NEXUS_ENCRYPTION_KEY=<32 random bytes, base64>   # required in production
NEXUS_ALLOW_REGISTRATION=false           # after creating the owner account
```

Generate the key once and back it up with the data directory:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**If you lose this key, stored provider keys and GitHub tokens cannot be decrypted.** Users must re-enter them. Rotating the key is not yet automated.

Production refuses an `http://` public origin (`NEXUS_PUBLIC_ORIGIN` must be `https://`).

## 4. Run as a service

Example systemd unit (adjust paths and user):

```ini
[Unit]
Description=NEXUS API and web app
After=network-online.target

[Service]
User=nexus
WorkingDirectory=/opt/nexus
EnvironmentFile=/etc/nexus/nexus.env
ExecStart=/usr/bin/node apps/api/dist/server.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Run `npm start -w @nexus/api` only for quick tests; it needs the same environment variables.

## 5. Reverse proxy and TLS

Put a TLS-terminating reverse proxy in front of NEXUS (Caddy, nginx or similar). Requirements:

- Forward `/` and `/api` to `127.0.0.1:8787`.
- **Disable buffering** for `/api/projects/*/events` (server-sent events), for example `proxy_buffering off;` in nginx.
- Pass the original `Host` header. NEXUS checks `Origin` against the public origin and the host header.
- Set a request body limit of at least 2 MB.
- Do not expose port 8787 directly.

Trust the proxy for client addresses only if you configure it; NEXUS enables `trustProxy` in production.

## 6. Backups

Back up `NEXUS_DATA_DIR` **and** the encryption key together. The SQLite database is in WAL mode, so use the SQLite backup command or stop the service before copying the files:

```sh
sqlite3 "$NEXUS_DATA_DIR/nexus.db" ".backup '/backup/nexus-$(date +%F).db'"
```

Workspaces are plain directories with their git metadata kept in `NEXUS_DATA_DIR`. Back them up with the database. Restore with the service stopped.

Restore has not been exercised yet (see the checklist).

## 7. Model providers and costs

- Add a provider key in **Settings** as a user, or set the provider's own environment variable on the server only if you understand that engines will read it. Keys are encrypted at rest in the database.
- Set per-user quotas with `NEXUS_QUOTA_AGENT_MESSAGES_PER_DAY` and `NEXUS_QUOTA_COMMANDS_PER_DAY`.
- Check each provider's terms, quotas and billing before you use it. "Reported free" in the catalog is not a guarantee. NEXUS does not use a paid provider without you configuring one.

## 8. GitHub OAuth (optional)

Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps):

- Homepage URL: `https://nexus.example.com`
- Authorization callback URL: `https://nexus.example.com/api/github/oauth/callback`

Set `NEXUS_GITHUB_CLIENT_ID` and `NEXUS_GITHUB_CLIENT_SECRET` on the server. Do not put the secret in any `VITE_*` or other browser-visible variable. NEXUS requests only `public_repo read:user` unless a user chooses private repositories, which needs `repo`.

## 9. Operations

- Logs are JSON on stdout (Fastify/pino). Secrets are redacted from events, but review logs before sharing them.
- Interrupted jobs are marked failed and interrupted agent sessions are marked interrupted when the server restarts.
- Use **Emergency stop** in a project to stop its running commands and its engine.
- Engines stop after `NEXUS_ENGINE_IDLE_MINUTES` of inactivity.
- Upgrade by pulling a new revision, running `npm ci && npm run build`, and restarting the service. Migrations run automatically at start and are idempotent.

## 10. What is not yet proven

Before you rely on NEXUS for anything important, verify these in your environment: a real model-driven agent turn, the GitHub OAuth round trip and publish flow, the backup and restore procedure, the reverse proxy's handling of server-sent events, and the sandbox on your host kernel. The checklist in [docs/TASKS.md](TASKS.md) lists the open items.
