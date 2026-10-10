import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { newId, nowIso } from "../db/index.js";
import { AppError } from "../errors.js";
import { walkFiles } from "./walk.js";
import type { ProjectRow } from "./jobs.js";

const EXCLUDED = [".git/", ".nexus/", "node_modules/", ".godot/", ".import/"];
const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

/** Packs the workspace (minus VCS metadata, dependencies and caches) into a ZIP artifact. */
export function exportProjectZip(opts: { db: Db; config: Config; project: ProjectRow; root: string; ownerId: string }) {
  const zip = new AdmZip();
  let total = 0;
  const files = walkFiles(opts.root, EXCLUDED);
  for (const rel of files) {
    const abs = join(opts.root, rel);
    const size = statSync(abs).size;
    total += size;
    if (total > MAX_EXPORT_BYTES) throw new AppError(413, "export_too_large", "The workspace is too large to export as a ZIP");
    zip.addFile(`${safeName(opts.project.name)}/${rel}`, readFileSync(abs));
  }
  const buffer = zip.toBuffer();
  const sha = createHash("sha256").update(buffer).digest("hex");
  const id = newId("art");
  const dir = join(opts.config.artifactsDir, opts.project.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileRel = `${opts.project.id}/${randomUUID()}.zip`;
  writeFileSync(join(opts.config.artifactsDir, fileRel), buffer, { mode: 0o600 });
  const name = `${safeName(opts.project.name)}-${new Date().toISOString().slice(0, 10)}.zip`;
  opts.db
    .prepare(
      "INSERT INTO artifacts (id, project_id, owner_id, kind, name, file_path, size_bytes, sha256, source, license, created_at) VALUES (?, ?, ?, 'project-zip', ?, ?, ?, ?, 'nexus-export', NULL, ?)",
    )
    .run(id, opts.project.id, opts.ownerId, name, fileRel, buffer.length, sha, nowIso());
  return opts.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, unknown> & { id: string; name: string; size_bytes: number; sha256: string; created_at: string };
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}
