/**
 * Engine-agnostic contract for coding agents. Route handlers and the frontend depend only on this
 * interface; adapters (OpenCode now, OpenHands later) map it onto their real capabilities.
 * Capabilities an engine lacks must throw EngineCapabilityError instead of pretending to work.
 */
export interface EngineContext {
  projectId: string;
  ownerId: string;
  /** Workspace root (cwd of the engine process). */
  root: string;
  /** Private engine state directory (HOME/XDG), outside the workspace. */
  engineHome: string;
  /** Provider selection for this engine process. The API key is injected as an env var, never logged. */
  provider?: { providerId: string; modelId: string; apiKey?: string; autoApproveEdits: boolean };
}

export interface EngineSessionRef {
  engineSessionId: string;
}

export type EngineSessionStatus = "idle" | "busy" | "retry" | "unknown";

export interface EngineMessageInput {
  text: string;
  mode: "plan" | "build";
  model?: { providerID: string; modelID: string };
}

export interface AgentEngine {
  readonly id: string;
  readonly displayName: string;
  createSession(ctx: EngineContext, title: string): Promise<EngineSessionRef>;
  sendMessage(ctx: EngineContext, ref: EngineSessionRef, input: EngineMessageInput): Promise<void>;
  getSessionStatus(ctx: EngineContext, ref: EngineSessionRef): Promise<EngineSessionStatus>;
  cancelSession(ctx: EngineContext, ref: EngineSessionRef): Promise<void>;
  getDiff(ctx: EngineContext, ref: EngineSessionRef): Promise<unknown[]>;
  disposeSession(ctx: EngineContext, ref: EngineSessionRef): Promise<void>;
  respondPermission(ctx: EngineContext, ref: EngineSessionRef, permissionId: string, response: "once" | "reject"): Promise<void>;
  /** Stops the engine process for a project (idempotent). */
  stop(projectId: string): Promise<void>;
  stopAll(): Promise<void>;
}

export class EngineCapabilityError extends Error {
  constructor(
    public readonly engine: string,
    public readonly capability: string,
  ) {
    super(`Engine "${engine}" does not support "${capability}"`);
    this.name = "EngineCapabilityError";
  }
}
