import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { resolveWorkspacePath } from "../security/paths.js";

export const MAX_READ_BYTES = 512 * 1024;
export const MAX_DIFF_BYTES = 400 * 1024;
const LIST_IGNORE = new Set([".git", ".nexus", "node_modules", ".godot", ".import"]);

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

/** Git invocation hardened against repository-supplied configuration (hooks, pagers, external diff, fsmonitor). */
const GIT_HARDENING = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.quotepath=off", "-c", "protocol.allow=never"];
const GIT_PROTOCOL_ALLOW = ["-c", "protocol.https.allow=always"];

export function gitEnv(gitHome: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "NEXUS",
    GIT_AUTHOR_EMAIL: "nexus@localhost",
    GIT_COMMITTER_NAME: "NEXUS",
    GIT_COMMITTER_EMAIL: "nexus@localhost",
    LANG: "C.UTF-8",
  };
}

export interface GitRunOptions {
  env?: NodeJS.ProcessEnv;
  allowNetworkProtocols?: boolean;
  input?: string;
}

/** Runs git in a workspace. Throws AppError with stderr (redacted by callers) on failure. */
export function git(root: string, gitHome: string, args: string[], opts: GitRunOptions = {}): string {
  const full = [...GIT_HARDENING, ...(opts.allowNetworkProtocols ? GIT_PROTOCOL_ALLOW : []), ...args];
  const res = spawnSync("git", full, {
    cwd: root,
    env: { ...gitEnv(gitHome), ...(opts.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
    timeout: 120_000,
  });
  if (res.error) throw new AppError(500, "git_failed", `git could not start: ${res.error.message}`);
  if (res.status !== 0) {
    throw new AppError(422, "git_failed", `git ${args[0]} failed`, { stderr: (res.stderr || "").slice(0, 2000) });
  }
  return res.stdout;
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

export function hasCommits(root: string, gitHome: string): boolean {
  const res = spawnSync("git", [...GIT_HARDENING, "rev-parse", "--verify", "-q", "HEAD"], { cwd: root, env: gitEnv(gitHome), encoding: "utf8" });
  return res.status === 0;
}

export const DEFAULT_GITIGNORE = `# NEXUS default ignores
node_modules/
dist/
build/
.env
.env.*
!.env.example
*.log
.DS_Store
.godot/
.import/
*.import
export/
`;

/** Initializes a workspace directory as a git repository with an initial commit. Idempotent. */
export function initWorkspace(root: string, gitHome: string, readme: string, extraFiles: Record<string, string | Buffer> = {}): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(gitHome, { recursive: true, mode: 0o700 });
  if (!isGitRepo(root)) {
    git(root, gitHome, ["init", "-q", "-b", "main"]);
  }
  if (!existsSync(join(root, ".gitignore"))) writeFileSync(join(root, ".gitignore"), DEFAULT_GITIGNORE);
  if (!existsSync(join(root, "README.md"))) writeFileSync(join(root, "README.md"), readme);
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    if (!existsSync(abs)) writeFileSync(abs, content);
  }
  if (!hasCommits(root, gitHome)) {
    git(root, gitHome, ["add", "-A"]);
    git(root, gitHome, ["commit", "-q", "-m", "Initial commit (created by NEXUS)", "--no-verify"]);
  }
}

export function listDirectory(root: string, relDir: string): TreeEntry[] {
  const { abs, rel } = resolveWorkspacePath(root, relDir, { allowRoot: true });
  if (!existsSync(abs)) throw new AppError(404, "not_found", "Directory not found");
  if (!statSync(abs).isDirectory()) throw new AppError(400, "not_a_directory", "Path is not a directory");
  const entries: TreeEntry[] = [];
  for (const name of readdirSync(abs).sort()) {
    if (LIST_IGNORE.has(name) || name === ".git") continue;
    const full = join(abs, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    entries.push({ name, path: childRel, type: st.isDirectory() ? "dir" : "file", size: st.isDirectory() ? 0 : st.size });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return entries;
}

function looksBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

export function readWorkspaceFile(root: string, relPath: string): { path: string; content: string; size: number } {
  const { abs, rel } = resolveWorkspacePath(root, relPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new AppError(404, "not_found", "File not found");
  const size = statSync(abs).size;
  if (size > MAX_READ_BYTES) throw new AppError(413, "file_too_large", `Files larger than ${MAX_READ_BYTES} bytes are not opened in the editor`);
  if (looksBinary(abs)) throw new AppError(415, "binary_file", "Binary files cannot be edited as text");
  return { path: rel, content: readFileSync(abs, "utf8"), size };
}

export function writeWorkspaceFile(root: string, relPath: string, content: string): { path: string; size: number } {
  const { abs, rel } = resolveWorkspacePath(root, relPath);
  if (existsSync(abs) && statSync(abs).isDirectory()) throw new AppError(400, "is_directory", "Path is a directory");
  mkdirSync(join(abs, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${abs}.${randomBytes(6).toString("hex")}.nexus-tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, abs);
  return { path: rel, size: Buffer.byteLength(content) };
}

export function deleteWorkspaceFile(root: string, relPath: string): void {
  const { abs } = resolveWorkspacePath(root, relPath);
  if (!existsSync(abs)) throw new AppError(404, "not_found", "File not found");
  if (statSync(abs).isDirectory()) throw new AppError(400, "is_directory", "Directories cannot be deleted from the editor");
  rmSync(abs);
}

export interface FileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
}

/**
 * Computes changes against HEAD without touching the real index: a temporary index file is
 * populated with `git add -A`, so untracked files appear in the diff and .gitignore is honoured.
 */
export function workspaceChanges(root: string, gitHome: string, tmpDir: string): FileChange[] {
  if (!isGitRepo(root) || !hasCommits(root, gitHome)) return [];
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const indexFile = join(tmpDir, `index-${randomBytes(6).toString("hex")}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    git(root, gitHome, ["read-tree", "HEAD"], { env });
    git(root, gitHome, ["add", "-A"], { env });
    const nameStatus = git(root, gitHome, ["diff", "--cached", "--name-status", "-M", "HEAD"], { env });
    const numstat = git(root, gitHome, ["diff", "--cached", "--numstat", "-M", "HEAD"], { env });
    const stats = new Map<string, { a: number; d: number }>();
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [a, d, ...rest] = line.split("\t");
      const file = rest.join("\t");
      stats.set(file, { a: a === "-" ? 0 : Number(a), d: d === "-" ? 0 : Number(d) });
    }
    const changes: FileChange[] = [];
    for (const line of nameStatus.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const status = (parts[0] ?? "M").charAt(0);
      const path = parts[parts.length - 1] ?? "";
      if (path.startsWith(".nexus/") || path.startsWith(".git/")) continue;
      let patch = git(root, gitHome, ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "HEAD", "--", path], { env });
      let truncated = false;
      if (Buffer.byteLength(patch) > MAX_DIFF_BYTES) {
        patch = patch.slice(0, MAX_DIFF_BYTES);
        truncated = true;
      }
      const s = stats.get(path) ?? { a: 0, d: 0 };
      changes.push({ path, status, additions: s.a, deletions: s.d, patch, truncated });
    }
    return changes;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Commit all current changes on the current branch. Returns the new commit id or null when clean. */
export function commitAll(root: string, gitHome: string, message: string): string | null {
  git(root, gitHome, ["add", "-A"]);
  const status = git(root, gitHome, ["status", "--porcelain"]);
  if (status.trim().length === 0) return null;
  git(root, gitHome, ["commit", "-q", "--no-verify", "-m", message]);
  return git(root, gitHome, ["rev-parse", "HEAD"]).trim();
}

export function currentBranch(root: string, gitHome: string): string {
  try {
    return git(root, gitHome, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return "main";
  }
}

export function dirSizeBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) total += st.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

