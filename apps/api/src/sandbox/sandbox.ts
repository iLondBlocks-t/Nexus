import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SandboxSpec {
  /** Program and arguments to run inside the sandbox (argv[0] is the program). */
  argv: string[];
  /** Working directory inside the sandbox. Must be one of the `keep` paths or inside one. */
  cwd: string;
  /** Extra environment variables. The NEXUS process environment is never inherited. */
  env: Record<string, string>;
  /** Allow outbound network. Default false. */
  network: boolean;
  /** Directories that must stay visible and writable inside the sandbox (e.g., the workspace). */
  keep: string[];
  /** Directories hidden inside the sandbox (replaced by an empty tmpfs). NEXUS secrets live here. */
  hide: string[];
  cpuSeconds?: number;
  memoryMb?: number;
  /** Run in a new process group so the whole tree can be signalled. Default true. */
  detached?: boolean;
}

export interface SandboxCapabilities {
  namespace: boolean;
  reason: string;
}

let cached: SandboxCapabilities | undefined;

/** Probes whether unprivileged user, mount and network namespaces work on this host. Cached. */
export function detectSandbox(): SandboxCapabilities {
  if (cached) return cached;
  if (process.platform !== "linux") {
    cached = { namespace: false, reason: "namespace sandbox requires Linux" };
    return cached;
  }
  const probe = spawnSync("unshare", ["-rmn", "--propagation", "private", "sh", "-c", "mount -t tmpfs tmpfs /tmp && echo ok"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (probe.status === 0 && probe.stdout.includes("ok")) {
    cached = { namespace: true, reason: "unprivileged user, mount and network namespaces available" };
  } else {
    const why = (probe.stderr || probe.error?.message || "unknown error").trim().slice(0, 200);
    cached = { namespace: false, reason: `namespaces unavailable: ${why}` };
  }
  return cached;
}

/** Test seam: clears the cached capability probe. */
export function resetSandboxProbe(): void {
  cached = undefined;
}

const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * Runs inside the new namespaces with `set -e`, so any failed mount aborts the job (fail closed).
 * Paths arrive via NEXUS_KEEP_<i> / NEXUS_HIDE_<i> variables that NEXUS computes; they are never
 * built from user input.
 *  1. bind-mount each keep directory to a staging area outside the hidden tree,
 *  2. replace each hide directory with an empty tmpfs (secrets become invisible),
 *  3. re-create each keep directory inside the tmpfs and bind the staged copy back,
 *  4. apply ulimits, enter the working directory, and exec the target program.
 */
const SANDBOX_SCRIPT = [
  "set -e",
  'STG="$(mktemp -d /tmp/nexus-stage.XXXXXX)"',
  'i=0; while [ "$i" -lt "${NEXUS_KEEP_N:-0}" ]; do eval "p=\\${NEXUS_KEEP_$i}"; mkdir -p "$STG/$i"; mount --bind "$p" "$STG/$i"; i=$((i+1)); done',
  'i=0; while [ "$i" -lt "${NEXUS_HIDE_N:-0}" ]; do eval "p=\\${NEXUS_HIDE_$i}"; if [ -d "$p" ]; then mount -t tmpfs -o mode=0700 tmpfs "$p"; fi; i=$((i+1)); done',
  'i=0; while [ "$i" -lt "${NEXUS_KEEP_N:-0}" ]; do eval "p=\\${NEXUS_KEEP_$i}"; mkdir -p "$p"; mount --bind "$STG/$i" "$p"; i=$((i+1)); done',
  'if [ -n "${NEXUS_CPU_SECONDS:-}" ]; then ulimit -t "$NEXUS_CPU_SECONDS"; fi',
  // RLIMIT_DATA, not RLIMIT_AS: V8 reserves large virtual ranges (WebAssembly, heap cage), so an
  // address-space cap makes Node itself fail. RLIMIT_DATA caps private writable memory (Linux >= 4.7).
  'if [ -n "${NEXUS_MEMORY_KB:-}" ]; then ulimit -d "$NEXUS_MEMORY_KB"; fi',
  "ulimit -f 262144",
  'cd "$NEXUS_CWD"',
  'exec "$@"',
].join("\n");

/** Builds the unshare command line that runs the sandbox script around the target program. */
export function buildSandboxArgv(spec: SandboxSpec): { file: string; args: string[] } {
  const flags = ["-rm", "--propagation", "private"];
  if (!spec.network) flags.push("-n");
  return {
    file: "unshare",
    args: [...flags, "--", "sh", "-c", SANDBOX_SCRIPT, "nexus-sandbox", ...spec.argv],
  };
}

/** Environment variables that describe the mounts and limits to the sandbox script. */
export function sandboxEnvFor(spec: SandboxSpec): Record<string, string> {
  const hide = spec.hide.filter((p) => existsSync(p));
  const env: Record<string, string> = {
    NEXUS_KEEP_N: String(spec.keep.length),
    NEXUS_HIDE_N: String(hide.length),
    NEXUS_CWD: spec.cwd,
  };
  spec.keep.forEach((p, i) => (env[`NEXUS_KEEP_${i}`] = p));
  hide.forEach((p, i) => (env[`NEXUS_HIDE_${i}`] = p));
  if (spec.cpuSeconds) env.NEXUS_CPU_SECONDS = String(spec.cpuSeconds);
  if (spec.memoryMb) env.NEXUS_MEMORY_KB = String(spec.memoryMb * 1024);
  return env;
}

/** Spawns a process inside the namespace sandbox. Throws if the sandbox is unavailable. */
export function spawnSandboxed(spec: SandboxSpec): ChildProcess {
  const caps = detectSandbox();
  if (!caps.namespace) throw new Error(`Sandbox unavailable: ${caps.reason}`);
  for (const k of spec.keep) if (!existsSync(k)) mkdirSync(k, { recursive: true, mode: 0o700 });
  const built = buildSandboxArgv(spec);
  // Only whitelisted variables reach the child process.
  const env: Record<string, string> = {
    PATH: SAFE_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    ...sandboxEnvFor(spec),
    ...spec.env,
  };
  return spawn(built.file, built.args, {
    cwd: spec.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: spec.detached ?? true,
  });
}

/** Paths that must be hidden from sandboxed code: NEXUS data (keys, DB, other workspaces) and user secrets. */
export function defaultHideList(dataDir: string): string[] {
  const home = homedir();
  return [dataDir, join(home, ".config"), join(home, ".ssh"), join(home, ".local", "share", "opencode"), join(home, ".cache")];
}
