import { join } from "node:path";
import type { Config } from "./config.js";

/** Every filesystem location a project uses, derived from server config and the project's random id. */
export interface ProjectPaths {
  /** Workspace root that users and agents see. */
  root: string;
  /** HOME for git invocations run by NEXUS (kept outside the workspace). */
  gitHome: string;
  /** HOME/TMP for sandboxed commands. */
  jobHome: string;
  /** Scratch space for temporary git indexes. */
  tmpDir: string;
  /** Per-project OpenCode engine state (XDG dirs). Never inside the workspace. */
  engineHome: string;
}

export function projectPaths(config: Config, workspaceRel: string, projectId: string): ProjectPaths {
  const base = join(config.workspacesDir, workspaceRel);
  return {
    root: base,
    gitHome: join(config.dataDir, "homes", projectId, "git"),
    jobHome: join(config.dataDir, "homes", projectId, "job"),
    tmpDir: join(config.dataDir, "tmp", projectId),
    engineHome: join(config.enginesDir, projectId),
  };
}
