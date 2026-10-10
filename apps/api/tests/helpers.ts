import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import type { AppContext } from "../src/context.js";
import { EventHub } from "../src/services/events.js";
import { JobRunner } from "../src/services/jobs.js";
import { OpenCodeEngine } from "../src/engines/opencode/adapter.js";

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  config: Config;
  db: Db;
  dataDir: string;
  close(): Promise<void>;
}

/** Builds a fully wired app against a fresh temporary data directory. Each call is isolated. */
export async function makeTestApp(extraEnv: Record<string, string> = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "nexus-test-"));
  const env = {
    ...process.env,
    NEXUS_ENV: "test",
    NEXUS_DATA_DIR: dataDir,
    NEXUS_PUBLIC_ORIGIN: "http://localhost:8787",
    NEXUS_ENCRYPTION_KEY: "",
    NEXUS_JOB_TIMEOUT_SECONDS: "30",
    ...extraEnv,
  } as Record<string, string>;
  for (const key of ["NEXUS_ENCRYPTION_KEY"]) if (!env[key]) delete env[key];
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let config: Config;
  try {
    config = loadConfig();
  } finally {
    for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  const db = openDatabase(config.dbPath);
  const hub = new EventHub(db);
  const runner = new JobRunner(config, db, hub);
  const engine = new OpenCodeEngine(config, db, hub);
  const ctx: AppContext = { config, db, hub, runner, engine };
  const app = await buildApp(ctx, { logger: false });
  return {
    app,
    ctx,
    config,
    db,
    dataDir,
    async close() {
      runner.shutdown();
      await engine.stopAll();
      await app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

export const ORIGIN = "http://localhost:8787";

/** Registers a user through the real endpoint and returns cookie + CSRF token. */
export async function register(t: TestApp, email: string, password = "correct-horse-battery-1"): Promise<Session> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password, displayName: email.split("@")[0] },
    headers: { origin: ORIGIN },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { user: { id: string }; csrfToken: string };
  const setCookie = String(res.headers["set-cookie"]);
  return { cookie: setCookie.split(";")[0]!, csrf: body.csrfToken, userId: body.user.id };
}

export async function api(
  t: TestApp,
  s: Session | null,
  method: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const h: Record<string, string> = { origin: ORIGIN, ...headers };
  if (s) {
    h.cookie = s.cookie;
    if (method !== "GET") h["x-csrf-token"] = s.csrf;
  }
  return t.app.inject({ method: method as "GET", url, payload: payload as undefined, headers: h });
}

export async function createProject(t: TestApp, s: Session, name = "Test", kind = "blank"): Promise<string> {
  const res = await api(t, s, "POST", "/api/projects", { name, kind, description: "" });
  if (res.statusCode !== 201) throw new Error(`create project failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { project: { id: string } }).project.id;
}

/** Polls a job until it reaches a terminal state. */
export async function waitForJob(t: TestApp, s: Session, projectId: string, jobId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(t, s, "GET", `/api/projects/${projectId}/jobs/${jobId}`);
    const job = (res.json() as { job: { status: string } }).job;
    if (!["awaiting_approval", "queued", "running"].includes(job.status)) return res.json() as { job: Record<string, unknown> & { status: string } };
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job.status}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
