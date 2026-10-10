import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));
// Source layout (tsx dev/tests): src/db -> apps/api/migrations. Built layout: dist/db -> dist/migrations.
const MIGRATION_DIRS = [join(here, "..", "..", "migrations"), join(here, "..", "migrations")];

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

/** Applies numbered SQL migrations exactly once, in order, each inside its own transaction. */
export function migrate(db: Db): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  );
  const dir = MIGRATION_DIRS.find((d) => existsSync(d));
  if (!dir) throw new Error("Migration directory not found");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map((r) => r.id),
  );
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(file);
      db.exec("COMMIT");
      ran.push(file);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
