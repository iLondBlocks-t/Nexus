import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { newId, nowIso, type Db } from "../db/index.js";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { projectPaths, type ProjectPaths } from "../paths.js";
import { evaluateCommand } from "../sandbox/policy.js";
import { defaultHideList, detectSandbox, spawnSandboxed } from "../sandbox/sandbox.js";
import { redact } from "../security/redact.js";
import { audit, EventHub, recordUsage, usageToday } from "./events.js";

export const MAX_JOB_OUTPUT_BYTES = 1024 * 1024;

export interface JobRow {
  id: string;
  project_id: string;
  owner_id: string;
  kind: string;
  status: string;
  command: string | null;
  network: number;
  policy: string;
  policy_reason: string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  output_bytes: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  workspace_rel: string;
  github_repo: string | null;
  github_branch: string | null;
  created_at: string;
  updated_at: string;
}

interface Running {
  child: ChildProcess;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  outputBytes: number;
  outputTruncated: boolean;
  finishReason?: "cancelled" | "timed_out";
}

/**
 * Runs user-approved or policy-allowed commands inside the namespace sandbox.
 * Lifecycle: awaiting_approval -> queued -> running -> succeeded | failed | timed_out | cancelled.
 * Each transition is persisted and emitted as a project event.
 */
export class JobRunner {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly hub: EventHub,
  ) {}

  get(jobId: string, ownerId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ?").get(jobId, ownerId) as JobRow | undefined;
  }

  list(projectId: string, ownerId: string): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100")
      .all(projectId, ownerId) as unknown as JobRow[];
  }

  paths(project: ProjectRow): ProjectPaths {
    return projectPaths(this.config, project.workspace_rel, project.id);
  }

  /** Creates a job, applies the command policy and quota, and starts it when allowed. */
  submit(project: ProjectRow, ownerId: string, command: string, network: boolean): JobRow {
    const today = usageToday(this.db, ownerId, "command");
    if (today >= this.config.quotas.commandsPerDay) {
      throw new AppError(429, "quota_exceeded", `Daily command quota reached (${this.config.quotas.commandsPerDay})`);
    }
    if (this.hasActiveJob(project.id)) {
      throw new AppError(409, "job_active", "Another command is already running in this project");
    }
    const verdict = evaluateCommand(command);
    const id = newId("job");
    const now = nowIso();
    let status: string;
    if (verdict.decision === "deny") status = "denied";
    else if (verdict.decision === "approval" || network) status = "awaiting_approval";
    else status = "queued";
    const reason = network && verdict.decision === "allow" ? "network access requested" : verdict.reason;
    this.db
      .prepare(
        "INSERT INTO jobs (id, project_id, owner_id, kind, status, command, network, policy, policy_reason, created_at) VALUES (?, ?, ?, 'command', ?, ?, ?, ?, ?, ?)",
      )
      .run(id, project.id, ownerId, status, command, network ? 1 : 0, verdict.decision, reason, now);
    recordUsage(this.db, ownerId, "command", 1, project.id);
    audit(this.db, ownerId, "job.submitted", id, { projectId: project.id, status, policy: verdict.decision, network });
    this.emit(project.id, ownerId, "job.updated", id, { status, command: redactCommand(command), reason });

    if (status === "awaiting_approval") {
      this.db
        .prepare(
          "INSERT INTO approvals (id, project_id, owner_id, kind, title, detail, status, ref_job_id, created_at) VALUES (?, ?, ?, 'command', ?, ?, 'pending', ?, ?)",
        )
        .run(newId("apr"), project.id, ownerId, network ? "Run command with network access" : "Run command", `${redactCommand(command)}\n\nReason: ${reason}`, id, now);
      this.emit(project.id, ownerId, "approval.requested", id, { title: "Command approval required", reason });
    } else if (status === "queued") {
      this.start(project, ownerId, id, command, network);
    }
    return this.get(id, ownerId)!;
  }

  decide(project: ProjectRow, ownerId: string, jobId: string, decision: "approve" | "deny"): JobRow {
    const job = this.get(jobId, ownerId);
    if (!job || job.project_id !== project.id) throw new AppError(404, "not_found", "Job not found");
    if (job.status !== "awaiting_approval") throw new AppError(409, "invalid_state", `Job is ${job.status}`);
    const approvedAt = nowIso();
    this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE ref_job_id = ? AND owner_id = ? AND status = 'pending'").run(
      decision === "approve" ? "approved" : "denied",
      approvedAt,
      jobId,
      ownerId,
    );
    audit(this.db, ownerId, `job.${decision === "approve" ? "approved" : "denied"}`, jobId, { projectId: project.id });
    if (decision === "deny") {
      this.setStatus(jobId, "denied", { finished_at: approvedAt });
      this.emit(project.id, ownerId, "job.updated", jobId, { status: "denied" });
    } else {
      if (this.hasActiveJob(project.id)) throw new AppError(409, "job_active", "Another command is already running in this project");
      this.setStatus(jobId, "queued");
      this.start(project, ownerId, jobId, job.command ?? "", job.network === 1);
    }
    return this.get(jobId, ownerId)!;
  }

  cancel(project: ProjectRow, ownerId: string, jobId: string): JobRow {
    const job = this.get(jobId, ownerId);
    if (!job || job.project_id !== project.id) throw new AppError(404, "not_found", "Job not found");
    const run = this.running.get(jobId);
    if (run) {
      run.finishReason = "cancelled";
      this.killGroup(run);
      audit(this.db, ownerId, "job.cancel_requested", jobId, { projectId: project.id });
    } else if (job.status === "awaiting_approval" || job.status === "queued") {
      this.setStatus(jobId, "cancelled", { finished_at: nowIso() });
      this.db.prepare("UPDATE approvals SET status = 'denied', decided_at = ? WHERE ref_job_id = ? AND status = 'pending'").run(nowIso(), jobId);
      this.emit(project.id, ownerId, "job.updated", jobId, { status: "cancelled" });
    } else {
      throw new AppError(409, "invalid_state", `Job is ${job.status}`);
    }
    return this.get(jobId, ownerId)!;
  }

  /** Emergency stop for every running job of a user. */
  stopAll(ownerId: string): number {
    let count = 0;
    for (const [jobId] of this.running) {
      const job = this.get(jobId, ownerId);
      if (!job) continue;
      const run = this.running.get(jobId)!;
      run.finishReason = "cancelled";
      this.killGroup(run);
      count++;
    }
    audit(this.db, ownerId, "job.emergency_stop", null, { stopped: count });
    return count;
  }

  /** On process start, jobs that were running are marked interrupted: their processes did not survive. */
  recoverInterrupted(): number {
    const rows = this.db.prepare("SELECT id, project_id, owner_id FROM jobs WHERE status = 'running'").all() as Array<{ id: string; project_id: string; owner_id: string }>;
    for (const r of rows) {
      this.setStatus(r.id, "failed", { finished_at: nowIso(), error: "Interrupted by a NEXUS server restart" });
      this.emit(r.project_id, r.owner_id, "job.updated", r.id, { status: "failed", error: "Interrupted by a NEXUS server restart" });
    }
    return rows.length;
  }

  hasActiveJob(projectId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND status IN ('queued', 'running')")
      .get(projectId) as { n: number };
    return Number(row.n) > 0;
  }

  shutdown(): void {
    for (const run of this.running.values()) this.killGroup(run);
  }

  private start(project: ProjectRow, ownerId: string, jobId: string, command: string, network: boolean): void {
    const caps = detectSandbox();
    if (this.config.sandboxMode === "disabled" || !caps.namespace) {
      const reason = this.config.sandboxMode === "disabled" ? "command execution is disabled by NEXUS_SANDBOX_MODE" : `Sandbox unavailable: ${caps.reason}`;
      this.setStatus(jobId, "failed", { finished_at: nowIso(), error: reason });
      this.emit(project.id, ownerId, "job.updated", jobId, { status: "failed", error: "Sandbox unavailable" });
      return;
    }
    const paths = this.paths(project);
    mkdirSync(paths.jobHome, { recursive: true, mode: 0o700 });
    mkdirSync(paths.root, { recursive: true });
    const startedAt = nowIso();
    this.setStatus(jobId, "running", { started_at: startedAt });
    this.emit(project.id, ownerId, "job.updated", jobId, { status: "running", startedAt, network });

    let child: ChildProcess;
    try {
      child = spawnSandboxed({
        argv: ["sh", "-c", command],
        cwd: paths.root,
        network,
        keep: [paths.root, paths.jobHome],
        hide: defaultHideList(this.config.dataDir),
        env: {
          HOME: paths.jobHome,
          TMPDIR: paths.jobHome,
          NODE_ENV: "development",
        },
        cpuSeconds: Math.ceil(this.config.jobTimeoutMs / 1000) + 30,
        memoryMb: this.config.jobMemoryMb,
      });
    } catch (err) {
      this.setStatus(jobId, "failed", { finished_at: nowIso(), error: (err as Error).message.slice(0, 500) });
      this.emit(project.id, ownerId, "job.updated", jobId, { status: "failed", error: (err as Error).message });
      return;
    }
    const run: Running = { child, outputBytes: 0, outputTruncated: false };
    this.running.set(jobId, run);
    run.timer = setTimeout(() => {
      run.finishReason = "timed_out";
      this.emit(project.id, ownerId, "job.output", jobId, { stream: "system", text: `Timed out after ${this.config.jobTimeoutMs / 1000}s; stopping.\n` });
      this.killGroup(run);
    }, this.config.jobTimeoutMs);

    const onChunk = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (run.outputTruncated) return;
      const text = chunk.toString("utf8");
      run.outputBytes += chunk.length;
      if (run.outputBytes > MAX_JOB_OUTPUT_BYTES) {
        run.outputTruncated = true;
        this.emit(project.id, ownerId, "job.output", jobId, { stream: "system", text: "\n[output limit reached; further output discarded]\n" });
        this.killGroup(run);
        return;
      }
      this.emit(project.id, ownerId, "job.output", jobId, { stream, text });
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));

    child.on("error", (err) => {
      this.finish(project, ownerId, jobId, run, null, null, `spawn error: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      this.finish(project, ownerId, jobId, run, code, signal, null);
    });
  }

  private finish(project: ProjectRow, ownerId: string, jobId: string, run: Running, code: number | null, signal: NodeJS.Signals | null, error: string | null): void {
    if (!this.running.has(jobId)) return;
    this.running.delete(jobId);
    if (run.timer) clearTimeout(run.timer);
    if (run.killTimer) clearTimeout(run.killTimer);
    let status: string;
    if (run.finishReason === "cancelled") status = "cancelled";
    else if (run.finishReason === "timed_out") status = "timed_out";
    else if (error) status = "failed";
    else status = code === 0 ? "succeeded" : "failed";
    const finishedAt = nowIso();
    this.db
      .prepare("UPDATE jobs SET status = ?, exit_code = ?, signal = ?, error = ?, finished_at = ?, output_bytes = ? WHERE id = ?")
      .run(status, code, signal, error ? redact(error).slice(0, 1000) : null, finishedAt, run.outputBytes, jobId);
    this.emit(project.id, ownerId, "job.updated", jobId, { status, exitCode: code, signal, finishedAt, error });
  }

  private killGroup(run: Running): void {
    const pid = run.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    if (!run.killTimer) {
      run.killTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3000);
      run.killTimer.unref();
    }
  }

  private setStatus(jobId: string, status: string, extra: Partial<Record<"started_at" | "finished_at" | "error", string | null>> = {}): void {
    const sets = ["status = ?"];
    const vals: Array<string | null> = [status];
    for (const [k, v] of Object.entries(extra)) {
      sets.push(`${k} = ?`);
      vals.push(v ?? null);
    }
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, jobId);
  }

  private emit(projectId: string, ownerId: string, type: string, jobId: string, payload: Record<string, unknown>): void {
    this.hub.append(projectId, ownerId, type, { jobId, ...payload });
  }
}

export function redactCommand(command: string): string {
  return redact(command).slice(0, 500);
}

