import { lstatSync, realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { AppError } from "../errors.js";

/** Directory names that users and agents may not create, read, or write through the file API. */
const PROTECTED_SEGMENTS = new Set([".git", ".nexus"]);

/**
 * Resolve a user-supplied relative path inside a workspace root.
 * Rejects absolute paths, traversal, NUL bytes, protected segments, and symlinks that escape the root.
 * Returns the absolute path and the normalized relative path (posix separators).
 */
export function resolveWorkspacePath(root: string, input: string, opts: { allowRoot?: boolean } = {}): { abs: string; rel: string } {
  if (typeof input !== "string" || input.length > 500 || (input.length === 0 && !opts.allowRoot)) {
    throw new AppError(400, "invalid_path", "Path is empty or too long");
  }
  if (input.includes("\0") || input.includes("\\") || isAbsolute(input) || /^[A-Za-z]:/.test(input)) {
    throw new AppError(400, "invalid_path", "Absolute paths and backslashes are not allowed");
  }
  const segments = input.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) throw new AppError(400, "invalid_path", "Path traversal is not allowed");
  if (segments.some((s) => PROTECTED_SEGMENTS.has(s))) throw new AppError(403, "protected_path", "This path is managed by NEXUS");
  const rel = segments.join("/");
  if (rel.length === 0 && !opts.allowRoot) throw new AppError(400, "invalid_path", "A file path is required");

  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, rel);
  const check = (candidate: string) => {
    const r = relative(rootReal, candidate);
    if (r.startsWith("..") || isAbsolute(r)) throw new AppError(400, "invalid_path", "Path escapes the workspace");
  };
  check(abs);
  // Walk existing ancestors and make sure no symlink points outside the workspace.
  let probe = abs;
  while (!existsSync(probe) && probe !== rootReal) probe = dirname(probe);
  check(realpathSync(probe));
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
    throw new AppError(403, "symlink_blocked", "Symbolic links cannot be edited through NEXUS");
  }
  return { abs, rel: rel.length === 0 ? "" : normalize(rel).split(sep).join("/") };
}

export function joinRel(...parts: string[]): string {
  return join(...parts).split(sep).join("/");
}
