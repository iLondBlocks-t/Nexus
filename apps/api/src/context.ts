import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { OpenCodeEngine } from "./engines/opencode/adapter.js";
import type { JobRunner } from "./services/jobs.js";
import type { EventHub } from "./services/events.js";

/** Everything route handlers need. Constructed once in server.ts or in tests. */
export interface AppContext {
  config: Config;
  db: Db;
  hub: EventHub;
  runner: JobRunner;
  engine: OpenCodeEngine;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
}

export interface AuthSession {
  id: string;
  csrfToken: string;
}
