import { randomUUID, createHash } from "node:crypto";
import { existsSync, createReadStream, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreateProjectInput, ApprovalDecisionInput, RunCommandInput, WriteFileInput } from "@nexus/shared";
import type { AppContext } from "../context.js";
import { AppError, notFound } from "../errors.js";
import { requireUser } from "../auth.js";
import { newId, nowIso } from "../db/index.js";
import { projectPaths } from "../paths.js";
import { audit } from "../services/events.js";
import type { ProjectRow } from "../services/jobs.js";
import {
  commitAll,
  currentBranch,
  deleteWorkspaceFile,
  initWorkspace,
  listDirectory,
  readWorkspaceFile,
  workspaceChanges,
  writeWorkspaceFile,
  isGitRepo,
  hasCommits,
  git,
} from "../services/workspace.js";
import { generateGodot2dArena } from "../gamebuilder/index.js";
import { exportProjectZip } from "../services/artifacts.js";
import { sendEventStream } from "./sse.js";

const ProjectIdParams = z.object({ id: z.string().min(4).max(80) });
const JobParams = z.object({ id: z.string().min(4).max(80), jobId: z.string().min(4).max(80) });
const ApprovalParams = z.object({ id: z.string().min(4).max(80), approvalId: z.string().min(4).max(80) });
const ArtifactParams = z.object({ id: z.string().min(4).max(80), artifactId: z.string().min(4).max(80) });
const PathQuery = z.object({ path: z.string().max(500).default("") });
const FileQuery = z.object({ path: z.string().min(1).max(500) });
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const CheckpointInput = z.object({ message: z.string().trim().min(1).max(200) });
const DeleteInput = z.object({ confirm: z.string().min(1).max(80) });

export function loadProject(ctx: AppContext, req: FastifyRequest, id: string): ProjectRow {
  const user = requireUser(req);
  const row = ctx.db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").get(id, user.id) as ProjectRow | undefined;
  if (!row) throw notFound("Project");
  return row;
}

export function toPublicProject(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    kind: p.kind,
    status: p.status,
    githubRepo: p.github_repo,
    githubBranch: p.github_branch,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

const READMES: Record<string, (name: string, description: string) => string> = {
  blank: (name, d) => `# ${name}\n\n${d || "A project created with NEXUS."}\n`,
  web: (name, d) => `# ${name}\n\n${d || "A static web project created with NEXUS."}\n\nOpen \`index.html\` in a browser.\n`,
  node: (name, d) => `# ${name}\n\n${d || "A Node.js project created with NEXUS."}\n\n\`\`\`sh\nnpm test\n\`\`\`\n`,
};

export function registerProjectRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { db, config, hub, runner } = ctx;

  api.get("/projects", async (req) => {
    const user = requireUser(req);
    const rows = db.prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC").all(user.id) as unknown as ProjectRow[];
    return { projects: rows.map(toPublicProject) };
  });

  api.post("/projects", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = requireUser(req);
    const input = CreateProjectInput.parse(req.body);
    const id = newId("prj");
    const workspaceRel = randomUUID();
    const paths = projectPaths(config, workspaceRel, id);
    const now = nowIso();
    try {
      if (input.kind === "godot-2d-arena") {
        generateGodot2dArena(paths.root, paths.gitHome, input.name, input.description);
      } else {
        const readme = (READMES[input.kind] ?? READMES.blank!)(input.name, input.description);
        const extra: Record<string, string> = {};
        if (input.kind === "web") extra["index.html"] = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.name)}</title></head>\n<body><h1>${escapeHtml(input.name)}</h1></body>\n</html>\n`;
        if (input.kind === "node") {
          extra["package.json"] = JSON.stringify({ name: slug(input.name), version: "0.1.0", private: true, scripts: { test: "node --test" } }, null, 2) + "\n";
        }
        initWorkspace(paths.root, paths.gitHome, readme, extra);
      }
    } catch (err) {
      rmSync(paths.root, { recursive: true, force: true });
      throw err instanceof AppError ? err : new AppError(500, "workspace_failed", "Could not create the workspace");
    }
    db.prepare(
      "INSERT INTO projects (id, owner_id, name, description, kind, status, workspace_rel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)",
    ).run(id, user.id, input.name, input.description, input.kind, workspaceRel, now, now);
    audit(db, user.id, "project.created", id, { kind: input.kind });
    hub.append(id, user.id, "project.created", { name: input.name, kind: input.kind });
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow;
    return reply.status(201).send({ project: toPublicProject(row) });
  });

  api.get("/projects/:id", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    return {
      project: toPublicProject(p),
      git: gitSummary(paths.root, paths.gitHome, paths.tmpDir),
      engine: { id: ctx.engine.id, displayName: ctx.engine.displayName, running: ctx.engine.processes.get(p.id) !== undefined },
      sandbox: { mode: config.sandboxMode },
    };
  });

  api.delete("/projects/:id", async (req, reply) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const input = DeleteInput.parse(req.body);
    if (input.confirm !== p.name) throw new AppError(400, "confirmation_mismatch", "Type the project name to confirm deletion");
    if (runner.hasActiveJob(p.id)) throw new AppError(409, "job_active", "Stop running commands before deleting the project");
    await ctx.engine.stop(p.id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    rmSync(paths.root, { recursive: true, force: true });
    rmSync(join(config.dataDir, "homes", p.id), { recursive: true, force: true });
    rmSync(paths.engineHome, { recursive: true, force: true });
    rmSync(paths.tmpDir, { recursive: true, force: true });
    db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    audit(db, req.user!.id, "project.deleted", id, { name: p.name });
    return reply.status(200).send({ deleted: true });
  });

  // ------------------------------------------------------------- files

  api.get("/projects/:id/tree", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const { path } = PathQuery.parse(req.query);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    return { path, entries: listDirectory(paths.root, path) };
  });

  api.get("/projects/:id/file", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const { path } = FileQuery.parse(req.query);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    return readWorkspaceFile(paths.root, path);
  });

  api.put("/projects/:id/file", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const input = WriteFileInput.parse(req.body);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    const res = writeWorkspaceFile(paths.root, input.path, input.content);
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(), p.id);
    hub.append(p.id, req.user!.id, "file.changed", { path: res.path, source: "user", size: res.size });
    return res;
  });

  api.delete("/projects/:id/file", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const { path } = FileQuery.parse(req.query);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    deleteWorkspaceFile(paths.root, path);
    hub.append(p.id, req.user!.id, "file.changed", { path, source: "user", deleted: true });
    return { deleted: true };
  });

  // ------------------------------------------------------------- git

  api.get("/projects/:id/changes", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    return { branch: currentBranch(paths.root, paths.gitHome), changes: workspaceChanges(paths.root, paths.gitHome, paths.tmpDir) };
  });

  api.post("/projects/:id/checkpoint", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const input = CheckpointInput.parse(req.body);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    const sha = commitAll(paths.root, paths.gitHome, input.message);
    if (!sha) throw new AppError(409, "nothing_to_commit", "There are no changes to commit");
    audit(db, req.user!.id, "git.commit", sha, { projectId: p.id });
    hub.append(p.id, req.user!.id, "git.committed", { sha, message: input.message });
    return { sha };
  });

  // ------------------------------------------------------------- commands, jobs, approvals

  api.post("/projects/:id/commands", async (req, reply) => {
    const { id } = ProjectIdParams.parse(req.params);
    const input = RunCommandInput.parse(req.body);
    const p = loadProject(ctx, req, id);
    const job = runner.submit(p, req.user!.id, input.command, input.network);
    return reply.status(job.status === "awaiting_approval" ? 202 : 201).send({ job: publicJob(job) });
  });

  api.get("/projects/:id/jobs", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    return { jobs: runner.list(p.id, req.user!.id).map(publicJob) };
  });

  api.get("/projects/:id/jobs/:jobId", async (req) => {
    const { id, jobId } = JobParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const job = runner.get(jobId, req.user!.id);
    if (!job || job.project_id !== p.id) throw notFound("Job");
    const output = db
      .prepare("SELECT payload, created_at, seq FROM events WHERE project_id = ? AND type = 'job.output' AND payload LIKE ? ORDER BY seq ASC LIMIT 2000")
      .all(p.id, `%"jobId":"${job.id}"%`) as Array<{ payload: string; created_at: string; seq: number }>;
    return {
      job: publicJob(job),
      output: output.map((o) => {
        const pl = JSON.parse(o.payload) as { stream: string; text: string };
        return { seq: Number(o.seq), stream: pl.stream, text: pl.text, at: o.created_at };
      }),
    };
  });

  api.post("/projects/:id/jobs/:jobId/cancel", async (req) => {
    const { id, jobId } = JobParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    return { job: publicJob(runner.cancel(p, req.user!.id, jobId)) };
  });

  api.get("/projects/:id/approvals", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const rows = db.prepare("SELECT * FROM approvals WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 200").all(p.id, req.user!.id) as Array<Record<string, unknown>>;
    return { approvals: rows.map(publicApproval) };
  });

  api.post("/projects/:id/approvals/:approvalId/decision", async (req) => {
    const { id, approvalId } = ApprovalParams.parse(req.params);
    const input = ApprovalDecisionInput.parse(req.body);
    const p = loadProject(ctx, req, id);
    const row = db.prepare("SELECT * FROM approvals WHERE id = ? AND project_id = ? AND owner_id = ?").get(approvalId, p.id, req.user!.id) as
      | { id: string; kind: string; status: string; ref_job_id: string | null; engine_session_id: string | null; engine_permission_id: string | null }
      | undefined;
    if (!row) throw notFound("Approval");
    if (row.status !== "pending") throw new AppError(409, "invalid_state", `Approval is already ${row.status}`);
    if (row.kind === "command" && row.ref_job_id) {
      const job = runner.decide(p, req.user!.id, row.ref_job_id, input.decision);
      return { approval: { id: row.id, status: input.decision === "approve" ? "approved" : "denied" }, job: publicJob(job) };
    }
    if (row.kind === "agent-permission" && row.engine_session_id && row.engine_permission_id) {
      const response = input.decision === "approve" ? "once" : "reject";
      await ctx.engine.respondPermission({ projectId: p.id, ownerId: req.user!.id, root: "", engineHome: "", provider: undefined }, { engineSessionId: row.engine_session_id }, row.engine_permission_id, response);
      const status = input.decision === "approve" ? "approved" : "denied";
      db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(status, nowIso(), row.id);
      audit(db, req.user!.id, `approval.${status}`, row.id, { projectId: p.id });
      hub.append(p.id, req.user!.id, "approval.decided", { approvalId: row.id, status });
      return { approval: { id: row.id, status } };
    }
    throw new AppError(409, "invalid_state", "This approval cannot be decided");
  });

  api.post("/projects/:id/emergency-stop", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const jobsStopped = runner.stopAll(req.user!.id);
    await ctx.engine.stop(p.id);
    db.prepare("UPDATE agent_sessions SET status = 'idle', updated_at = ? WHERE project_id = ? AND status IN ('busy','retry')").run(nowIso(), p.id);
    db.prepare("UPDATE approvals SET status = 'denied', decided_at = ? WHERE project_id = ? AND status = 'pending'").run(nowIso(), p.id);
    hub.append(p.id, req.user!.id, "system.emergency_stop", { jobsStopped });
    audit(db, req.user!.id, "project.emergency_stop", p.id, { jobsStopped });
    return { jobsStopped, engineStopped: true };
  });

  // ------------------------------------------------------------- events

  api.get("/projects/:id/events", async (req, reply) => {
    const { id } = ProjectIdParams.parse(req.params);
    const q = EventsQuery.parse(req.query);
    const p = loadProject(ctx, req, id);
    const lastId = Number(req.headers["last-event-id"] ?? NaN);
    const after = Number.isFinite(lastId) && lastId > 0 ? lastId : q.after;
    sendEventStream(req, reply, hub, p.id, after);
    return reply;
  });

  api.get("/projects/:id/events/replay", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const q = EventsQuery.parse(req.query);
    const p = loadProject(ctx, req, id);
    return { events: hub.replay(p.id, q.after, 500) };
  });

  // ------------------------------------------------------------- artifacts

  api.get("/projects/:id/artifacts", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const rows = db.prepare("SELECT * FROM artifacts WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC").all(p.id, req.user!.id) as Array<Record<string, unknown>>;
    return { artifacts: rows.map(publicArtifact) };
  });

  api.post("/projects/:id/artifacts/export", async (req, reply) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    const artifact = exportProjectZip({ db, config, project: p, root: paths.root, ownerId: req.user!.id });
    hub.append(p.id, req.user!.id, "artifact.created", { artifactId: artifact.id, name: artifact.name, size: artifact.size_bytes });
    return reply.status(201).send({ artifact: publicArtifact(artifact as unknown as Record<string, unknown>) });
  });

  api.get("/projects/:id/artifacts/:artifactId/download", async (req, reply) => {
    const { id, artifactId } = ArtifactParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const row = db.prepare("SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND owner_id = ?").get(artifactId, p.id, req.user!.id) as
      | { file_path: string; name: string; sha256: string; size_bytes: number }
      | undefined;
    if (!row) throw notFound("Artifact");
    const abs = join(config.artifactsDir, row.file_path);
    if (!existsSync(abs)) throw notFound("Artifact file");
    const actual = sha256File(abs);
    if (actual !== row.sha256) throw new AppError(500, "artifact_corrupt", "Artifact checksum mismatch");
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${row.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    reply.header("Content-Length", String(statSync(abs).size));
    reply.header("X-Content-Sha256", row.sha256);
    return reply.send(createReadStream(abs));
  });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function publicJob(j: { id: string; kind: string; status: string; command: string | null; network: number; policy: string; policy_reason: string | null; exit_code: number | null; signal: string | null; error: string | null; output_bytes: number; created_at: string; started_at: string | null; finished_at: string | null; project_id: string }) {
  return {
    id: j.id,
    projectId: j.project_id,
    kind: j.kind,
    status: j.status,
    command: j.command,
    network: j.network === 1,
    policy: j.policy,
    policyReason: j.policy_reason,
    exitCode: j.exit_code,
    signal: j.signal,
    error: j.error,
    outputBytes: j.output_bytes,
    createdAt: j.created_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
  };
}

function publicApproval(a: Record<string, unknown>) {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    detail: a.detail,
    status: a.status,
    jobId: a.ref_job_id ?? null,
    createdAt: a.created_at,
    decidedAt: a.decided_at ?? null,
  };
}

function publicArtifact(a: Record<string, unknown>) {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    sizeBytes: a.size_bytes,
    sha256: a.sha256,
    source: a.source,
    license: a.license ?? null,
    createdAt: a.created_at,
  };
}

function gitSummary(root: string, gitHome: string, tmpDir: string) {
  if (!isGitRepo(root)) return { isRepo: false, branch: null, head: null, dirtyFiles: 0 };
  const head = hasCommits(root, gitHome) ? git(root, gitHome, ["rev-parse", "--short", "HEAD"]).trim() : null;
  const dirty = workspaceChanges(root, gitHome, tmpDir).length;
  return { isRepo: true, branch: currentBranch(root, gitHome), head, dirtyFiles: dirty };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "project";
}

