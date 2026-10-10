import { loadConfig } from "./config.js";
import { openDatabase, nowIso } from "./db/index.js";
import { buildApp } from "./app.js";
import { EventHub } from "./services/events.js";
import { JobRunner } from "./services/jobs.js";
import { OpenCodeEngine } from "./engines/opencode/adapter.js";
import { detectSandbox } from "./sandbox/sandbox.js";
import type { AppContext } from "./context.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const hub = new EventHub(db);
  const runner = new JobRunner(config, db, hub);
  const engine = new OpenCodeEngine(config, db, hub);
  const ctx: AppContext = { config, db, hub, runner, engine };

  const recovered = runner.recoverInterrupted();
  const interruptedSessions = db
    .prepare("UPDATE agent_sessions SET status = 'interrupted', last_error = 'NEXUS restarted while the agent was working', updated_at = ? WHERE status IN ('busy', 'retry')")
    .run(nowIso());
  const caps = detectSandbox();
  const app = await buildApp(ctx, { logger: true });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    runner.shutdown();
    await engine.stopAll();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      url: config.publicOrigin,
      env: config.env,
      sandbox: caps,
      recoveredJobs: recovered,
      interruptedSessions: interruptedSessions.changes,
    },
    "NEXUS API listening",
  );
}

main().catch((err: unknown) => {
  console.error("NEXUS failed to start:", (err as Error).message);
  process.exit(1);
});
