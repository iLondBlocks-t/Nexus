import { EventEmitter } from "node:events";
import type { Db } from "../db/index.js";
import { newId, nowIso } from "../db/index.js";
import { redact } from "../security/redact.js";

export interface StoredEvent {
  seq: number;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Append-only project event log with in-process fan-out. Events are persisted before they are
 * published, so a browser that reconnects can replay everything after its last seen `seq`.
 */
export class EventHub {
  private readonly emitter = new EventEmitter();
  constructor(private readonly db: Db) {
    this.emitter.setMaxListeners(0);
  }

  append(projectId: string, ownerId: string, type: string, payload: Record<string, unknown>): StoredEvent {
    const createdAt = nowIso();
    const safePayload = JSON.parse(redact(JSON.stringify(payload))) as Record<string, unknown>;
    const body = JSON.stringify(safePayload);
    const row = this.db
      .prepare("INSERT INTO events (project_id, owner_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING seq")
      .get(projectId, ownerId, type, body, createdAt) as { seq: number };
    const event: StoredEvent = { seq: Number(row.seq), projectId, type, payload: safePayload, createdAt };
    this.emitter.emit(`project:${projectId}`, event);
    return event;
  }

  replay(projectId: string, afterSeq: number, limit = 500): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, project_id, type, payload, created_at FROM events WHERE project_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(projectId, afterSeq, limit) as Array<{ seq: number; project_id: string; type: string; payload: string; created_at: string }>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      projectId: r.project_id,
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  subscribe(projectId: string, listener: (e: StoredEvent) => void): () => void {
    const key = `project:${projectId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }
}

export function audit(db: Db, userId: string | null, action: string, target: string | null, detail?: Record<string, unknown>): void {
  db.prepare("INSERT INTO audit_log (user_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    action,
    target,
    detail ? redact(JSON.stringify(detail)) : null,
    nowIso(),
  );
}

export function recordUsage(db: Db, userId: string, kind: "agent_message" | "command" | "agent_cost", amount: number, projectId?: string): void {
  db.prepare("INSERT INTO usage_records (id, user_id, project_id, kind, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId("use"),
    userId,
    projectId ?? null,
    kind,
    amount,
    nowIso(),
  );
}

/** Usage counted since the start of the current UTC day. */
export function usageToday(db: Db, userId: string, kind: string): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM usage_records WHERE user_id = ? AND kind = ? AND created_at >= ?")
    .get(userId, kind, start.toISOString()) as { total: number };
  return Number(row.total);
}
