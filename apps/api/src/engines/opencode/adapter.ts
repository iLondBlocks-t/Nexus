import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../config.js";
import type { Db } from "../../db/index.js";
import { newId, nowIso } from "../../db/index.js";
import { AppError } from "../../errors.js";
import { EventHub } from "../../services/events.js";
import type { AgentEngine, EngineContext, EngineMessageInput, EngineSessionRef, EngineSessionStatus } from "../types.js";
import { OpenCodeProcessManager, type EngineProcess } from "./processes.js";
import { providerEnvFallback } from "./providerEnv.js";

export interface CatalogModel {
  id: string;
  name: string;
  /** True only when the catalog reports zero input and output price. Verify provider terms before relying on it. */
  reportedFree: boolean;
  costInput: number;
  costOutput: number;
  contextLimit: number;
  status: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  envVars: string[];
  connected: boolean;
  models: CatalogModel[];
}

const CATALOG_KEY = "_catalog";
const CATALOG_TTL_MS = 5 * 60_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * OpenCode adapter. Maps the application-level AgentEngine contract onto the documented
 * `opencode serve` HTTP API and SSE event stream. Event mapping: https://opencode.ai/docs/server/
 */
export class OpenCodeEngine implements AgentEngine {
  readonly id = "opencode";
  readonly displayName = "OpenCode";
  readonly processes: OpenCodeProcessManager;
  private catalog?: { at: number; providers: CatalogProvider[] };
  private catalogInFlight?: Promise<CatalogProvider[]>;
  /** Assistant/user role per engine message id, so parts can be attributed correctly. */
  private readonly messageRoles = new Map<string, "user" | "assistant">();
  /** Accumulated text per message part, so the transcript can be rebuilt after reconnects. */
  private readonly partText = new Map<string, string>();
  private readonly ownerCache = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly hub: EventHub,
  ) {
    this.processes = new OpenCodeProcessManager(
      config,
      {
        onEvent: (key, ev) => this.handleEvent(key, ev),
        onExit: (key, reason) => this.handleExit(key, reason),
      },
      (key) => this.isBusy(key),
    );
  }

  // ---------------------------------------------------------------- lifecycle

  private ownerOf(projectId: string): string | undefined {
    const cached = this.ownerCache.get(projectId);
    if (cached) return cached;
    const row = this.db.prepare("SELECT owner_id FROM projects WHERE id = ?").get(projectId) as { owner_id: string } | undefined;
    if (row) this.ownerCache.set(projectId, row.owner_id);
    return row?.owner_id;
  }

  isBusy(projectId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE project_id = ? AND status IN ('busy', 'retry')")
      .get(projectId) as { n: number };
    return Number(row.n) > 0;
  }

  private fingerprint(ctx: EngineContext): string {
    const p = ctx.provider;
    return createHash("sha256")
      .update(JSON.stringify({ p: p?.providerId ?? "", k: p?.apiKey ? createHash("sha256").update(p.apiKey).digest("hex") : "", a: p?.autoApproveEdits ?? false }))
      .digest("hex");
  }

  private async envFor(ctx: EngineContext): Promise<Record<string, string>> {
    const p = ctx.provider;
    if (!p?.apiKey) return {};
    const envName = (await this.envVarFor(p.providerId)) ?? providerEnvFallback(p.providerId);
    if (!envName) throw new AppError(400, "provider_unsupported", `Provider "${p.providerId}" has no known API key variable`);
    return { [envName]: p.apiKey };
  }

  private async processFor(ctx: EngineContext): Promise<EngineProcess> {
    // Fail closed: the agent's shell and edits must never run without the sandbox.
    if (this.config.sandboxMode === "disabled") {
      throw new AppError(503, "sandbox_disabled", "The agent is disabled because NEXUS_SANDBOX_MODE is disabled");
    }
    const env = await this.envFor(ctx);
    mkdirSync(ctx.engineHome, { recursive: true, mode: 0o700 });
    try {
      return await this.processes.ensure({
        key: ctx.projectId,
        root: ctx.root,
        engineHome: ctx.engineHome,
        env,
        fingerprint: this.fingerprint(ctx),
        autoApproveEdits: ctx.provider?.autoApproveEdits ?? false,
      });
    } catch (err) {
      throw new AppError(503, "engine_unavailable", (err as Error).message);
    }
  }

  async stop(projectId: string): Promise<void> {
    await this.processes.stop(projectId);
  }

  async stopAll(): Promise<void> {
    await this.processes.stopAll();
  }

  // ---------------------------------------------------------------- catalog

  /** Provider and model catalog as reported by the engine. Cached briefly. */
  async getCatalog(): Promise<CatalogProvider[]> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.providers;
    if (this.catalogInFlight) return this.catalogInFlight;
    this.catalogInFlight = (async () => {
      const root = join(this.config.enginesDir, CATALOG_KEY, "workspace");
      const engineHome = join(this.config.enginesDir, CATALOG_KEY);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const proc = await this.processes.ensure({
        key: CATALOG_KEY,
        root,
        engineHome,
        env: {},
        fingerprint: "catalog",
        autoApproveEdits: false,
      });
      const body = await proc.client.request<{ all: unknown[]; connected: string[] }>("GET", "/provider", undefined, 20_000);
      const providers = parseCatalog(body);
      this.catalog = { at: Date.now(), providers };
      return providers;
    })().finally(() => (this.catalogInFlight = undefined));
    return this.catalogInFlight;
  }

  private async envVarFor(providerId: string): Promise<string | undefined> {
    try {
      const providers = await this.getCatalog();
      return providers.find((p) => p.id === providerId)?.envVars[0];
    } catch {
      return undefined;
    }
  }

  /**
   * Verifies that the engine accepts the provider/key pair and that the model exists in its catalog.
   * This does NOT make a billable model request, so it cannot prove live network access to the provider.
   */
  async testProviderConfiguration(providerId: string, modelId: string, apiKey: string | undefined): Promise<{ ok: boolean; message: string; keyRecognized: boolean; modelFound: boolean }> {
    const providers = await this.getCatalog();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return { ok: false, message: `Provider "${providerId}" is not in the engine catalog`, keyRecognized: false, modelFound: false };
    const modelFound = provider.models.some((m) => m.id === modelId);
    if (!modelFound) return { ok: false, message: `Model "${modelId}" is not listed for ${provider.name}`, keyRecognized: false, modelFound: false };
    if (provider.envVars.length === 0) {
      return { ok: true, message: "Provider needs no API key", keyRecognized: true, modelFound };
    }
    if (!apiKey) {
      return { ok: false, message: `No API key saved for ${provider.name}`, keyRecognized: false, modelFound };
    }
    const envName = provider.envVars[0]!;
    const probeKey = `_probe_${createHash("sha256").update(providerId + apiKey).digest("hex").slice(0, 12)}`;
    const root = join(this.config.enginesDir, probeKey, "workspace");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      const proc = await this.processes.ensure({
        key: probeKey,
        root,
        engineHome: join(this.config.enginesDir, probeKey),
        env: { [envName]: apiKey },
        fingerprint: `probe:${providerId}`,
        autoApproveEdits: false,
      });
      const body = await proc.client.request<{ connected: string[] }>("GET", "/provider", undefined, 20_000);
      const keyRecognized = Array.isArray(body?.connected) && body.connected.includes(providerId);
      return {
        ok: keyRecognized,
        message: keyRecognized
          ? "The engine recognises the saved key for this provider. Live reachability is only verified on the first agent message."
          : "The engine did not recognise the saved key for this provider",
        keyRecognized,
        modelFound,
      };
    } finally {
      await this.processes.stop(probeKey);
    }
  }

  // ---------------------------------------------------------------- AgentEngine

  async createSession(ctx: EngineContext, title: string): Promise<EngineSessionRef> {
    const proc = await this.processFor(ctx);
    const session = await proc.client.request<{ id: string }>("POST", "/session", { title }, 20_000);
    if (!session?.id) throw new AppError(502, "engine_error", "Engine did not return a session id");
    return { engineSessionId: session.id };
  }

  async sendMessage(ctx: EngineContext, ref: EngineSessionRef, input: EngineMessageInput): Promise<void> {
    const proc = await this.processFor(ctx);
    const body: Json = {
      agent: input.mode,
      parts: [{ type: "text", text: input.text }],
    };
    if (input.model) body.model = input.model;
    await proc.client.request("POST", `/session/${encodeURIComponent(ref.engineSessionId)}/prompt_async`, body, 30_000);
  }

  async getSessionStatus(ctx: EngineContext, ref: EngineSessionRef): Promise<EngineSessionStatus> {
    const proc = this.processes.get(ctx.projectId);
    if (!proc) return "unknown";
    const all = await proc.client.request<Record<string, { type?: string }>>("GET", "/session/status", undefined, 10_000);
    const t = all?.[ref.engineSessionId]?.type;
    return t === "busy" || t === "retry" || t === "idle" ? t : "idle";
  }

  async cancelSession(ctx: EngineContext, ref: EngineSessionRef): Promise<void> {
    const proc = this.processes.get(ctx.projectId);
    if (!proc) return;
    await proc.client.request("POST", `/session/${encodeURIComponent(ref.engineSessionId)}/abort`, undefined, 15_000);
  }

  async getDiff(ctx: EngineContext, ref: EngineSessionRef): Promise<unknown[]> {
    const proc = await this.processFor(ctx);
    const diff = await proc.client.request<unknown[]>("GET", `/session/${encodeURIComponent(ref.engineSessionId)}/diff`, undefined, 20_000);
    return Array.isArray(diff) ? diff : [];
  }

  async disposeSession(ctx: EngineContext, ref: EngineSessionRef): Promise<void> {
    const proc = this.processes.get(ctx.projectId);
    if (!proc) return;
    await proc.client.request("DELETE", `/session/${encodeURIComponent(ref.engineSessionId)}`, undefined, 15_000).catch(() => undefined);
  }

  async respondPermission(ctx: EngineContext, ref: EngineSessionRef, permissionId: string, response: "once" | "reject"): Promise<void> {
    const proc = this.processes.get(ctx.projectId);
    if (!proc) throw new AppError(409, "engine_stopped", "The agent engine is not running; the request can no longer be answered");
    await proc.client.request(
      "POST",
      `/session/${encodeURIComponent(ref.engineSessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      { response },
      15_000,
    );
  }

  // ---------------------------------------------------------------- events

  private handleExit(projectId: string, reason: string): void {
    const owner = this.ownerOf(projectId);
    if (!owner) return;
    const rows = this.db
      .prepare("SELECT id FROM agent_sessions WHERE project_id = ? AND status IN ('busy', 'retry')")
      .all(projectId) as Array<{ id: string }>;
    for (const r of rows) {
      this.db.prepare("UPDATE agent_sessions SET status = 'interrupted', last_error = ?, updated_at = ? WHERE id = ?").run("The agent engine stopped", nowIso(), r.id);
    }
    this.hub.append(projectId, owner, "agent.engine", { state: "stopped", reason });
  }

  /** Public for tests: maps one engine event into NEXUS state. */
  handleEvent(projectId: string, ev: Json): void {
    const owner = this.ownerOf(projectId);
    if (!owner) return;
    const type = str(ev.type);
    const props = isObj(ev.properties) ? ev.properties : {};
    try {
      switch (type) {
        case "session.status":
          this.onSessionStatus(projectId, owner, props);
          break;
        case "session.idle":
          this.setSessionStatus(projectId, owner, str(props.sessionID), "idle");
          break;
        case "session.error":
          this.onSessionError(projectId, owner, props);
          break;
        case "message.updated":
          this.onMessageUpdated(projectId, owner, props);
          break;
        case "message.part.updated":
          this.onPartUpdated(projectId, owner, props);
          break;
        case "file.edited":
          if (str(props.file)) this.hub.append(projectId, owner, "agent.file_edited", { file: str(props.file) });
          break;
        case "todo.updated":
          this.hub.append(projectId, owner, "agent.todos", { sessionId: str(props.sessionID), todos: Array.isArray(props.todos) ? props.todos : [] });
          break;
        case "permission.updated":
          this.onPermissionUpdated(projectId, owner, props);
          break;
        case "permission.replied":
          this.onPermissionReplied(projectId, owner, props);
          break;
        default:
          break;
      }
    } catch (err) {
      this.hub.append(projectId, owner, "system.error", { message: `Event mapping failed for ${type ?? "unknown"}: ${(err as Error).message}` });
    }
  }

  private sessionRowId(projectId: string, engineSessionId: string | undefined): string | undefined {
    if (!engineSessionId) return undefined;
    const row = this.db
      .prepare("SELECT id FROM agent_sessions WHERE project_id = ? AND engine_session_id = ?")
      .get(projectId, engineSessionId) as { id: string } | undefined;
    return row?.id;
  }

  private setSessionStatus(projectId: string, owner: string, engineSessionId: string | undefined, status: string): void {
    const rowId = this.sessionRowId(projectId, engineSessionId);
    if (!rowId) return;
    this.db.prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), rowId);
    this.hub.append(projectId, owner, "agent.status", { sessionId: rowId, status });
  }

  private onSessionStatus(projectId: string, owner: string, props: Json): void {
    const status = isObj(props.status) ? str(props.status.type) : undefined;
    if (!status) return;
    this.setSessionStatus(projectId, owner, str(props.sessionID), status);
  }

  private onSessionError(projectId: string, owner: string, props: Json): void {
    const rowId = this.sessionRowId(projectId, str(props.sessionID));
    const message = describeEngineError(props.error);
    if (rowId) {
      this.db.prepare("UPDATE agent_sessions SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").run(message, nowIso(), rowId);
    }
    this.hub.append(projectId, owner, "agent.error", { sessionId: rowId, message });
  }

  private onMessageUpdated(projectId: string, owner: string, props: Json): void {
    const info = isObj(props.info) ? props.info : undefined;
    if (!info) return;
    const id = str(info.id);
    const role = info.role === "user" ? "user" : "assistant";
    if (!id) return;
    this.messageRoles.set(id, role);
    if (role === "user") return;
    const rowId = this.sessionRowId(projectId, str(info.sessionID));
    if (!rowId) return;
    const err = info.error !== undefined ? describeEngineError(info.error) : null;
    const completed = isObj(info.time) && typeof info.time.completed === "number";
    const existing = this.db.prepare("SELECT id, status FROM messages WHERE engine_message_id = ?").get(id) as { id: string; status: string } | undefined;
    const wasFinal = existing !== undefined && (existing.status === "complete" || existing.status === "error");
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO messages (id, agent_session_id, project_id, role, mode, content, engine_message_id, status, error, created_at) VALUES (?, ?, ?, 'assistant', ?, '', ?, ?, ?, ?)",
        )
        .run(newId("msg"), rowId, projectId, str(info.mode) ?? "build", id, completed || err ? (err ? "error" : "complete") : "streaming", err, nowIso());
    } else {
      this.db
        .prepare("UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?")
        .run(err ? "error" : completed ? "complete" : "streaming", err, existing.id);
    }
    if ((completed || err) && !wasFinal) {
      if (err) this.hub.append(projectId, owner, "agent.error", { sessionId: rowId, messageId: id, message: err });
      const cost = num(info.cost);
      if (cost > 0) {
        this.db
          .prepare("INSERT INTO usage_records (id, user_id, project_id, kind, amount, created_at) VALUES (?, ?, ?, 'agent_cost', ?, ?)")
          .run(newId("use"), owner, projectId, cost, nowIso());
      }
      this.hub.append(projectId, owner, "agent.message", { sessionId: rowId, messageId: id, status: err ? "error" : "complete", cost });
    }
  }

  private onPartUpdated(projectId: string, owner: string, props: Json): void {
    const part = isObj(props.part) ? props.part : undefined;
    if (!part) return;
    const messageId = str(part.messageID);
    const sessionKey = str(part.sessionID);
    const role = messageId ? this.messageRoles.get(messageId) : undefined;
    if (role === "user") return;
    const partId = str(part.id) ?? "";
    const rowId = this.sessionRowId(projectId, sessionKey);
    if (part.type === "text" && messageId) {
      if (part.synthetic === true) return;
      const text = str(part.text) ?? "";
      this.partText.set(partId, text);
      const full = [...this.partText.entries()].filter(([k]) => k.length > 0).map(([, v]) => v).join("\n\n");
      if (rowId) {
        const existing = this.db.prepare("SELECT id FROM messages WHERE engine_message_id = ?").get(messageId) as { id: string } | undefined;
        if (existing) this.db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(full, existing.id);
      }
      this.hub.append(projectId, owner, "agent.text", { sessionId: rowId, messageId, partId, delta: typeof props.delta === "string" ? props.delta : undefined });
      return;
    }
    if (part.type === "tool") {
      const state = isObj(part.state) ? part.state : {};
      this.hub.append(projectId, owner, "agent.tool", {
        sessionId: rowId,
        messageId,
        callId: str(part.callID) ?? partId,
        tool: str(part.tool) ?? "tool",
        status: str(state.status) ?? "pending",
        title: str(state.title) ?? "",
        input: truncateJson(state.input, 1500),
        output: truncateText(typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : "", 4000),
      });
      return;
    }
    if (part.type === "patch") {
      const files = Array.isArray(part.files) ? part.files.filter((f): f is string => typeof f === "string") : [];
      this.hub.append(projectId, owner, "agent.patch", { sessionId: rowId, files });
    }
  }

  private onPermissionUpdated(projectId: string, owner: string, props: Json): void {
    const id = str(props.id);
    if (!id) return;
    const existing = this.db.prepare("SELECT id FROM approvals WHERE engine_permission_id = ?").get(id) as { id: string } | undefined;
    if (existing) return;
    const engineSessionId = str(props.sessionID);
    const type = str(props.type) ?? "permission";
    const title = str(props.title) ?? `Agent requests ${type} permission`;
    const pattern = Array.isArray(props.pattern) ? props.pattern.join(", ") : str(props.pattern) ?? "";
    const detail = truncateText(`${type}${pattern ? `: ${pattern}` : ""}`, 1000);
    const approvalId = newId("apr");
    this.db
      .prepare(
        "INSERT INTO approvals (id, project_id, owner_id, kind, title, detail, status, engine_session_id, engine_permission_id, created_at) VALUES (?, ?, ?, 'agent-permission', ?, ?, 'pending', ?, ?, ?)",
      )
      .run(approvalId, projectId, owner, title, detail, engineSessionId ?? null, id, nowIso());
    // Edits are auto-allowed by the engine policy only when the user enabled auto-approval (see permissionConfig).
    this.hub.append(projectId, owner, "approval.requested", { approvalId, title, detail, permission: type, kind: "agent-permission" });
  }

  private onPermissionReplied(projectId: string, owner: string, props: Json): void {
    const id = str(props.permissionID);
    if (!id) return;
    const response = str(props.response);
    const status = response === "reject" ? "denied" : "approved";
    const row = this.db.prepare("SELECT id FROM approvals WHERE engine_permission_id = ? AND status = 'pending'").get(id) as { id: string } | undefined;
    if (!row) return;
    this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(status, nowIso(), row.id);
    this.hub.append(projectId, owner, "approval.decided", { approvalId: row.id, status });
  }

}

export function parseCatalog(body: unknown): CatalogProvider[] {
  const b = isObj(body) ? body : {};
  const all = Array.isArray(b.all) ? b.all : [];
  const connected = new Set(Array.isArray(b.connected) ? b.connected.filter((c): c is string => typeof c === "string") : []);
  return all
    .filter(isObj)
    .map((p) => {
      const id = str(p.id) ?? "unknown";
      const modelsObj = isObj(p.models) ? p.models : {};
      const models: CatalogModel[] = Object.values(modelsObj)
        .filter(isObj)
        .map((m) => {
          const cost = isObj(m.cost) ? m.cost : {};
          const limit = isObj(m.limit) ? m.limit : {};
          const costInput = num(cost.input);
          const costOutput = num(cost.output);
          return {
            id: str(m.id) ?? "unknown",
            name: str(m.name) ?? str(m.id) ?? "unknown",
            reportedFree: costInput === 0 && costOutput === 0,
            costInput,
            costOutput,
            contextLimit: num(limit.context),
            status: str(m.status) ?? "active",
          };
        })
        .filter((m) => m.status !== "deprecated")
        .sort((a, b2) => a.name.localeCompare(b2.name));
      return {
        id,
        name: str(p.name) ?? id,
        envVars: Array.isArray(p.env) ? p.env.filter((e): e is string => typeof e === "string") : [],
        connected: connected.has(id),
        models,
      };
    })
    .sort((a, b2) => a.name.localeCompare(b2.name));
}

export function describeEngineError(err: unknown): string {
  if (typeof err === "string") return err.slice(0, 1000);
  if (isObj(err)) {
    const data = isObj(err.data) ? err.data : {};
    const msg = str(data.message) ?? str(err.message) ?? str(err.name) ?? "Unknown engine error";
    return msg.slice(0, 1000);
  }
  return "Unknown engine error";
}

function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function truncateJson(v: unknown, max: number): unknown {
  const s = JSON.stringify(v ?? null);
  if (s.length <= max) return v ?? null;
  return { truncated: s.slice(0, max) };
}

