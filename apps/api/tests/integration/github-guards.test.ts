import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { api, createProject, makeTestApp, register, type Session, type TestApp } from "../helpers.js";
import { encryptSecret } from "../../src/security/crypto.js";
import { nowIso } from "../../src/db/index.js";

/**
 * Push guards are checked before any network call. These tests link a project to a fake GitHub
 * repository and a fake connection, then verify every refusal path. No request reaches GitHub.
 */
let t: TestApp;
let s: Session;
let pid: string;
let root: string;
let gitHome: string;

const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, HOME: gitHome } }).trim();

beforeAll(async () => {
  t = await makeTestApp();
  s = await register(t, "push@example.test");
  pid = await createProject(t, s, "Publish Guards");
  const row = t.db.prepare("SELECT workspace_rel FROM projects WHERE id = ?").get(pid) as { workspace_rel: string };
  root = join(t.config.workspacesDir, row.workspace_rel);
  gitHome = join(t.config.dataDir, "homes", pid);
  t.db.prepare("UPDATE projects SET github_repo = ?, github_branch = ? WHERE id = ?").run("octo/demo", "main", pid);
  const now = nowIso();
  t.db
    .prepare("INSERT INTO github_connections (user_id, login, token_ciphertext, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(s.userId, "octo", encryptSecret(t.config.masterKey, "gho_FAKE_TEST_TOKEN_NOT_REAL"), "public_repo read:user", now, now);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const push = (body: Record<string, unknown>) =>
  api(t, s, "POST", `/api/projects/${pid}/github/push`, { message: "test", confirmPublish: true, ...body });

describe("GitHub publish guards (no network)", () => {
  it("refuses to publish when there are no changes, and leaves the branch untouched", async () => {
    const before = git("rev-parse", "--abbrev-ref", "HEAD");
    const res = await push({});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("nothing_to_publish");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe(before);
  });

  it("requires explicit confirmation", async () => {
    writeFileSync(join(root, "change.txt"), "hello\n");
    const res = await api(t, s, "POST", `/api/projects/${pid}/github/push`, { message: "x", confirmPublish: false });
    expect(res.statusCode).toBe(400);
  });

  it("never writes to the default branch", async () => {
    const res = await push({ branch: "main" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("protected_branch");
  });

  it("rejects invalid branch names before touching git", async () => {
    const res = await push({ branch: "bad..name" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_branch");
  });

  it("blocks publishing when a credential-shaped value is present", async () => {
    const before = git("rev-parse", "--abbrev-ref", "HEAD");
    writeFileSync(join(root, "leak.txt"), "token=ghp_" + "a".repeat(36) + "\n");
    const res = await push({ branch: "nexus/secret-test" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("secret_detected");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe(before);
    expect(() => git("show-ref", "--verify", "--quiet", "refs/heads/nexus/secret-test")).toThrow();
  });

  it("refuses to reset an existing local branch", async () => {
    execFileSync("rm", ["-f", join(root, "leak.txt")]);
    git("branch", "nexus/already-here");
    const res = await push({ branch: "nexus/already-here" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("branch_exists");
  });
});
