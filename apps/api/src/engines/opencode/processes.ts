import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Config } from "../../config.js";
import { defaultHideList, detectSandbox, spawnSandboxed } from "../../sandbox/sandbox.js";
import { OpenCodeClient, forEachSseEvent } from "./client.js";

export interface EngineProcess {
  key: string;
  child: ChildProcess;
  client: OpenCodeClient;
  baseUrl: string;
  fingerprint: string;
  startedAt: number;
  lastUsed: number;
  stopping: boolean;
  sseAbort: AbortController;
  autoApproveEdits: boolean;
}

export interface ProcessHooks {
  onEvent: (key: string, event: Record<string, unknown>) => void;
  onExit: (key: string, reason: string) => void;
}

export interface SpawnOptions {
  key: string;
  root: string;
  engineHome: string;
  /** Environment for the engine process (provider keys, feature flags). */
  env: Record<string, string>;
  fingerprint: string;
  autoApproveEdits: boolean;
}

/** Permissions NEXUS enforces on every OpenCode server. The repository's own config is ignored. */
export function permissionConfig(autoApproveEdits: boolean): Record<string, unknown> {
  return {
    permission: {
      bash: "ask",
      edit: autoApproveEdits ? "allow" : "ask",
      webfetch: "ask",
      external_directory: "deny",
    },
    share: "disabled",
    autoupdate: false,
  };
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not allocate a port"));
      }
    });
  });
}

const SAFE_NODE_PATH = `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;

/**
 * Owns OpenCode server processes. One process per project keeps each agent confined to its own
 * workspace and private engine state. Processes run inside the namespace sandbox with the network
 * enabled (required for model providers), but with NEXUS secrets hidden.
 */
export class OpenCodeProcessManager {
  private readonly procs = new Map<string, EngineProcess>();
  private readonly starting = new Map<string, Promise<EngineProcess>>();
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly hooks: ProcessHooks,
    /** Reports whether a process has work in flight. Busy processes are never evicted or restarted. */
    private readonly isBusy: (key: string) => boolean = () => false,
  ) {}

  get(key: string): EngineProcess | undefined {
    return this.procs.get(key);
  }

  keys(): string[] {
    return [...this.procs.keys()];
  }

  async ensure(opts: SpawnOptions): Promise<EngineProcess> {
    const existing = this.procs.get(opts.key);
    if (existing && !existing.stopping && existing.fingerprint === opts.fingerprint) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing && existing.fingerprint !== opts.fingerprint) {
      if (this.isBusy(opts.key)) throw new Error("The agent is busy; wait for it to finish before changing provider settings");
      await this.stop(opts.key);
    }
    const pending = this.starting.get(opts.key);
    if (pending) return pending;
    const p = this.spawn(opts).finally(() => this.starting.delete(opts.key));
    this.starting.set(opts.key, p);
    return p;
  }

  private async spawn(opts: SpawnOptions): Promise<EngineProcess> {
    const caps = detectSandbox();
    if (!caps.namespace) throw new Error(`Agent sandbox unavailable: ${caps.reason}`);
    if (this.procs.size >= this.config.maxEngines) {
      // Evict the least recently used idle engine to make room.
      const idle = [...this.procs.values()].filter((p) => !this.isBusy(p.key)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new Error(`Engine capacity reached (${this.config.maxEngines}); try again shortly`);
      await this.stop(idle.key);
    }
    const port = await findFreePort();
    const password = randomBytes(24).toString("base64url");
    const home = join(opts.engineHome, "home");
    const xdg = join(opts.engineHome, "xdg");
    for (const d of [home, join(xdg, "config"), join(xdg, "data"), join(xdg, "cache"), join(xdg, "state"), opts.root]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    const child = spawnSandboxed({
      argv: [this.config.opencodeBin, "serve", "--hostname=127.0.0.1", `--port=${port}`],
      cwd: opts.root,
      network: true,
      keep: [opts.root, opts.engineHome],
      hide: defaultHideList(this.config.dataDir),
      env: {
        PATH: SAFE_NODE_PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(xdg, "config"),
        XDG_DATA_HOME: join(xdg, "data"),
        XDG_CACHE_HOME: join(xdg, "cache"),
        XDG_STATE_HOME: join(xdg, "state"),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(permissionConfig(opts.autoApproveEdits)),
        OPENCODE_DISABLE_SHARE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        ...opts.env,
      },
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new OpenCodeClient({ baseUrl, password });
    const proc: EngineProcess = {
      key: opts.key,
      child,
      client,
      baseUrl,
      fingerprint: opts.fingerprint,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      stopping: false,
      sseAbort: new AbortController(),
      autoApproveEdits: opts.autoApproveEdits,
    };
    let stderrTail = "";
    child.stderr?.on("data", (c: Buffer) => (stderrTail = (stderrTail + c.toString("utf8")).slice(-2000)));
    child.stdout?.on("data", () => undefined);
    let exited = false;
    child.on("exit", (code, signal) => {
      exited = true;
      const reason = `exit ${code ?? "?"}${signal ? ` (${signal})` : ""}`;
      const current = this.procs.get(opts.key);
      if (current === proc) this.procs.delete(opts.key);
      proc.sseAbort.abort();
      if (!proc.stopping) this.hooks.onExit(opts.key, reason);
    });

    try {
      await this.waitHealthy(client, () => exited, () => stderrTail);
    } catch (err) {
      proc.stopping = true;
      this.killGroup(child);
      throw err;
    }
    this.procs.set(opts.key, proc);
    this.startEventPump(proc);
    this.ensureReaper();
    return proc;
  }

  private async waitHealthy(client: OpenCodeClient, exited: () => boolean, stderr: () => string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      if (exited()) throw new Error(`Agent engine exited during startup. ${redactTail(stderr())}`);
      try {
        const health = await client.request<{ healthy: boolean }>("GET", "/global/health", undefined, 2000);
        if (health?.healthy) return;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Agent engine did not become healthy in time (${lastErr})`);
  }

  private startEventPump(proc: EngineProcess): void {
    const run = async (): Promise<void> => {
      let attempts = 0;
      while (!proc.stopping && !proc.sseAbort.signal.aborted && attempts < 20) {
        try {
          const res = await proc.client.openEventStream(proc.sseAbort.signal);
          attempts = 0;
          await forEachSseEvent(res.body!, (ev) => {
            if (ev && typeof ev === "object") this.hooks.onEvent(proc.key, ev as Record<string, unknown>);
          });
        } catch {
          /* reconnect below */
        }
        if (proc.stopping || proc.sseAbort.signal.aborted) return;
        attempts++;
        await new Promise((r) => setTimeout(r, Math.min(5000, 300 * attempts)));
      }
    };
    void run();
  }

  async stop(key: string): Promise<void> {
    const proc = this.procs.get(key);
    if (!proc) return;
    proc.stopping = true;
    proc.sseAbort.abort();
    this.procs.delete(key);
    this.killGroup(proc.child);
    await new Promise<void>((resolve) => {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) return resolve();
      const t = setTimeout(() => {
        try {
          if (proc.child.pid) process.kill(-proc.child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
        resolve();
      }, 4000);
      proc.child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async stopAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await Promise.all([...this.procs.keys()].map((k) => this.stop(k)));
  }

  /** Stops engines idle for longer than the configured window and that are not busy. */
  reapIdle(now = Date.now()): string[] {
    const stopped: string[] = [];
    for (const proc of this.procs.values()) {
      if (now - proc.lastUsed > this.config.engineIdleMs && !this.isBusy(proc.key)) {
        stopped.push(proc.key);
        void this.stop(proc.key);
      }
    }
    return stopped;
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  private killGroup(child: ChildProcess): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

function redactTail(s: string): string {
  return s.replace(/[A-Za-z0-9_-]{32,}/g, "[REDACTED]").slice(-600);
}
