import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentMessageInput } from "@nexus/shared";
import type { AppContext } from "../context.js";
import { AppError, notFound } from "../errors.js";
import { requireUser } from "../auth.js";
import { newId, nowIso } from "../db/index.js";
import { projectPaths } from "../paths.js";
import { audit, recordUsage, usageToday } from "../services/events.js";
import { resolveProvider } from "../providers/settings.js";
import type { EngineContext } from "../engines/types.js";
import { loadProject } from "./projects.js";

const ProjectIdParams = z.object({ id: z.string().min(4).max(80) });

interface AgentSessionRow {
  id: string;
  project_id: string;
  engine: string;
  engine_session_id: string | null;
  title: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function registerAgentRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { db, config, hub, engine } = ctx;

  function activeSession(projectId: string): AgentSessionRow | undefined {
    return db
      .prepare("SELECT * FROM agent_sessions WHERE project_id = ? AND status != 'disposed' ORDER BY created_at DESC LIMIT 1")
      .get(projectId) as AgentSessionRow | undefined;
  }

  api.get("/projects/:id/agent", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const session = activeSession(p.id);
    const messages = session
      ? (db
          .prepare("SELECT id, role, mode, content, status, error, created_at FROM messages WHERE agent_session_id = ? ORDER BY created_at ASC LIMIT 300")
          .all(session.id) as Array<Record<string, string | null>>)
      : [];
    return {
      session: session
        ? { id: session.id, engine: session.engine, status: session.status, lastError: session.last_error, title: session.title, updatedAt: session.updated_at }
        : null,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        mode: m.mode,
        content: m.content,
        status: m.status,
        error: m.error,
        createdAt: m.created_at,
      })),
      engine: { id: engine.id, displayName: engine.displayName, running: engine.processes.get(p.id) !== undefined },
      quota: { agentMessagesToday: usageToday(db, req.user!.id, "agent_message"), agentMessagesPerDay: config.quotas.agentMessagesPerDay },
    };
  });

  api.post("/projects/:id/agent/messages", async (req, reply) => {
    const { id } = ProjectIdParams.parse(req.params);
    const input = AgentMessageInput.parse(req.body);
    const user = requireUser(req);
    const p = loadProject(ctx, req, id);
    if (usageToday(db, user.id, "agent_message") >= config.quotas.agentMessagesPerDay) {
      throw new AppError(429, "quota_exceeded", `Daily agent message quota reached (${config.quotas.agentMessagesPerDay})`);
    }
    const provider = resolveProvider(config, db, user.id, input.modelId);
    if (input.providerId && input.providerId !== provider.providerId) {
      throw new AppError(400, "provider_mismatch", "Switch the provider in Settings; a message can only use the configured provider");
    }
    const existing = activeSession(p.id);
    if (existing && (existing.status === "busy" || existing.status === "retry")) {
      throw new AppError(409, "agent_busy", "The agent is still working on the previous message");
    }
    const paths = projectPaths(config, p.workspace_rel, p.id);
    const engineCtx: EngineContext = {
      projectId: p.id,
      ownerId: user.id,
      root: paths.root,
      engineHome: paths.engineHome,
      provider,
    };

    let sessionRow = existing;
    if (!sessionRow) {
      const ref = await engine.createSession(engineCtx, p.name.slice(0, 80));
      const sid = newId("ags");
      const now = nowIso();
      db.prepare("INSERT INTO agent_sessions (id, project_id, owner_id, engine, engine_session_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)").run(
        sid,
        p.id,
        user.id,
        engine.id,
        ref.engineSessionId,
        p.name.slice(0, 80),
        now,
        now,
      );
      sessionRow = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sid) as unknown as AgentSessionRow;
    }
    const engineSessionId = sessionRow.engine_session_id;
    if (!engineSessionId) throw new AppError(500, "session_invalid", "Agent session has no engine id");

    const messageId = newId("msg");
    const now = nowIso();
    db.prepare("INSERT INTO messages (id, agent_session_id, project_id, role, mode, content, status, created_at) VALUES (?, ?, ?, 'user', ?, ?, 'complete', ?)").run(
      messageId,
      sessionRow.id,
      p.id,
      input.mode,
      input.text,
      now,
    );
    db.prepare("UPDATE agent_sessions SET status = 'busy', last_error = NULL, updated_at = ? WHERE id = ?").run(now, sessionRow.id);
    hub.append(p.id, user.id, "agent.user_message", { sessionId: sessionRow.id, messageId, mode: input.mode, text: input.text });
    recordUsage(db, user.id, "agent_message", 1, p.id);
    audit(db, user.id, "agent.message", messageId, { projectId: p.id, mode: input.mode, provider: provider.providerId, model: provider.modelId });

    try {
      await engine.sendMessage(engineCtx, { engineSessionId }, {
        text: input.text,
        mode: input.mode,
        model: { providerID: provider.providerId, modelID: provider.modelId },
      });
    } catch (err) {
      const message = err instanceof AppError ? err.message : (err as Error).message;
      db.prepare("UPDATE agent_sessions SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(message.slice(0, 1000), nowIso(), sessionRow.id);
      hub.append(p.id, user.id, "agent.error", { sessionId: sessionRow.id, message: message.slice(0, 1000) });
      if (err instanceof AppError) throw err;
      throw new AppError(502, "engine_error", "The agent engine rejected the message", { reason: message.slice(0, 300) });
    }
    return reply.status(202).send({ sessionId: sessionRow.id, messageId });
  });

  api.post("/projects/:id/agent/cancel", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const user = requireUser(req);
    const p = loadProject(ctx, req, id);
    const session = activeSession(p.id);
    if (!session?.engine_session_id) throw notFound("Agent session");
    const paths = projectPaths(config, p.workspace_rel, p.id);
    await engine.cancelSession({ projectId: p.id, ownerId: user.id, root: paths.root, engineHome: paths.engineHome }, { engineSessionId: session.engine_session_id });
    db.prepare("UPDATE agent_sessions SET status = 'idle', updated_at = ? WHERE id = ?").run(nowIso(), session.id);
    hub.append(p.id, user.id, "agent.status", { sessionId: session.id, status: "idle", cancelled: true });
    return { cancelled: true };
  });

  api.post("/projects/:id/agent/new-conversation", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const user = requireUser(req);
    const p = loadProject(ctx, req, id);
    const session = activeSession(p.id);
    if (session && (session.status === "busy" || session.status === "retry")) {
      throw new AppError(409, "agent_busy", "Cancel the running task before starting a new conversation");
    }
    if (session) db.prepare("UPDATE agent_sessions SET status = 'disposed', updated_at = ? WHERE id = ?").run(nowIso(), session.id);
    hub.append(p.id, user.id, "agent.status", { status: "new_conversation" });
    return { ok: true };
  });
}
