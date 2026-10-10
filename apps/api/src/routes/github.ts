import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ImportGithubInput } from "@nexus/shared";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { requireUser } from "../auth.js";
import { newId, nowIso } from "../db/index.js";
import { projectPaths } from "../paths.js";
import { randomToken, encryptSecret, decryptSecret } from "../security/crypto.js";
import { audit } from "../services/events.js";
import { detectProject } from "../services/detect.js";
import { githubApi, githubConfigured, authorizeUrl, exchangeCode, parseRepoUrl, cloneRepository, scanPatchForSecrets, type GithubScopeLevel } from "../services/github.js";
import { currentBranch, git, isGitRepo, workspaceChanges } from "../services/workspace.js";
import { loadProject, toPublicProject } from "./projects.js";
import type { ProjectRow } from "../services/jobs.js";

const ProjectIdParams = z.object({ id: z.string().min(4).max(80) });
const StartQuery = z.object({ scope: z.enum(["public", "private"]).default("public") });
const CallbackQuery = z.object({ code: z.string().min(1).max(200), state: z.string().min(10).max(200) });
const ReposQuery = z.object({ page: z.coerce.number().int().min(1).max(50).default(1) });
const PushInput = z.object({
  message: z.string().trim().min(1).max(200),
  branch: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  confirmPublish: z.literal(true),
});
const PrInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(5000).default(""),
  base: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._/-]+$/).default("main"),
  confirmPublish: z.literal(true),
});

interface Connection {
  user_id: string;
  login: string;
  token_ciphertext: string;
  scopes: string;
}

export function registerGithubRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { db, config, hub } = ctx;

  function connectionFor(userId: string): { login: string; token: string; scopes: string } | undefined {
    const row = db.prepare("SELECT * FROM github_connections WHERE user_id = ?").get(userId) as Connection | undefined;
    if (!row) return undefined;
    return { login: row.login, token: decryptSecret(config.masterKey, row.token_ciphertext), scopes: row.scopes };
  }

  api.get("/github/status", async (req) => {
    const user = requireUser(req);
    const conn = db.prepare("SELECT login, scopes, created_at FROM github_connections WHERE user_id = ?").get(user.id) as
      | { login: string; scopes: string; created_at: string }
      | undefined;
    return {
      configured: githubConfigured(config),
      connected: Boolean(conn),
      login: conn?.login ?? null,
      scopes: conn ? conn.scopes.split(/[ ,]+/).filter(Boolean) : [],
      connectedAt: conn?.created_at ?? null,
      note: githubConfigured(config)
        ? "Public repositories can be imported without connecting GitHub. Connecting enables private repositories, pushes and pull requests."
        : "GitHub OAuth is not configured on this server (NEXUS_GITHUB_CLIENT_ID / NEXUS_GITHUB_CLIENT_SECRET). Public repository import still works.",
    };
  });

  api.get("/github/oauth/start", async (req, reply) => {
    const user = requireUser(req);
    if (!githubConfigured(config)) throw new AppError(503, "github_not_configured", "GitHub OAuth is not configured on this server");
    const q = StartQuery.parse(req.query);
    const state = randomToken(24);
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(nowIso());
    db.prepare("INSERT INTO oauth_states (state, user_id, scope_level, expires_at) VALUES (?, ?, ?, ?)").run(
      state,
      user.id,
      q.scope,
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    return reply.redirect(authorizeUrl(config, state, q.scope as GithubScopeLevel), 302);
  });

  api.get("/github/oauth/callback", async (req, reply) => {
    const q = CallbackQuery.parse(req.query);
    if (!req.user) throw new AppError(401, "unauthenticated", "Sign in to NEXUS before connecting GitHub");
    const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(q.state) as
      | { state: string; user_id: string; scope_level: string; expires_at: string }
      | undefined;
    db.prepare("DELETE FROM oauth_states WHERE state = ?").run(q.state);
    if (!row || row.user_id !== req.user.id || Date.parse(row.expires_at) < Date.now()) {
      throw new AppError(400, "oauth_state_invalid", "The GitHub authorization expired or does not match this session. Try again.");
    }
    const { accessToken, scopes } = await exchangeCode(config, q.code);
    const profile = await githubApi<{ login: string }>(accessToken, "/user");
    const now = nowIso();
    db.prepare(
      `INSERT INTO github_connections (user_id, login, token_ciphertext, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET login = excluded.login, token_ciphertext = excluded.token_ciphertext, scopes = excluded.scopes, updated_at = excluded.updated_at`,
    ).run(req.user.id, profile.login, encryptSecret(config.masterKey, accessToken), scopes || row.scope_level, now, now);
    audit(db, req.user.id, "github.connected", profile.login, { scopes });
    return reply.redirect("/settings?github=connected", 302);
  });

  api.delete("/github/connection", async (req) => {
    const user = requireUser(req);
    db.prepare("DELETE FROM github_connections WHERE user_id = ?").run(user.id);
    audit(db, user.id, "github.disconnected", user.id);
    return { connected: false };
  });

  api.get("/github/repos", async (req) => {
    const user = requireUser(req);
    const q = ReposQuery.parse(req.query);
    const conn = connectionFor(user.id);
    if (!conn) throw new AppError(409, "github_not_connected", "Connect GitHub in Settings to list your repositories");
    const repos = await githubApi<Array<{ full_name: string; private: boolean; default_branch: string; description: string | null; html_url: string; pushed_at: string; language: string | null }>>(
      conn.token,
      `/user/repos?per_page=30&page=${q.page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    );
    return {
      login: conn.login,
      repos: repos.map((r) => ({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        url: r.html_url,
        pushedAt: r.pushed_at,
        language: r.language,
      })),
    };
  });

  api.post("/projects/import-github", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = requireUser(req);
    const input = ImportGithubInput.parse(req.body);
    const parsed = parseRepoUrl(input.repoUrl.replace(/\/$/, ""));
    const conn = connectionFor(user.id);
    const id = newId("prj");
    const workspaceRel = randomUUID();
    const paths = projectPaths(config, workspaceRel, id);
    const cloneUrl = `https://github.com/${parsed.fullName}.git`;
    // A token is used only when the user connected GitHub. Public repositories are cloned anonymously.
    cloneRepository({ url: cloneUrl, dest: paths.root, gitHome: paths.gitHome, branch: input.branch, token: conn?.token });
    const detection = detectProject(paths.root);
    const now = nowIso();
    const name = input.name ?? parsed.repo;
    db.prepare(
      "INSERT INTO projects (id, owner_id, name, description, kind, status, workspace_rel, github_repo, github_branch, created_at, updated_at) VALUES (?, ?, ?, ?, 'github-import', 'ready', ?, ?, ?, ?, ?)",
    ).run(id, user.id, name, `Imported from github.com/${parsed.fullName}`, workspaceRel, parsed.fullName, currentBranch(paths.root, paths.gitHome), now, now);
    audit(db, user.id, "project.imported_github", id, { repo: parsed.fullName, private: Boolean(conn) });
    hub.append(id, user.id, "project.imported", { repo: parsed.fullName, detection });
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow;
    return reply.status(201).send({ project: toPublicProject(row), detection });
  });

  api.get("/projects/:id/detect", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const p = loadProject(ctx, req, id);
    const paths = projectPaths(config, p.workspace_rel, p.id);
    return { detection: detectProject(paths.root) };
  });

  /**
   * Publishes the workspace to a NEW branch on the connected GitHub repository. Requires explicit
   * confirmation, refuses to push when the diff contains credential-shaped strings, and never
   * force-pushes or pushes to the default branch.
   */
  api.post("/projects/:id/github/push", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const input = PushInput.parse(req.body);
    const user = requireUser(req);
    const p = loadProject(ctx, req, id);
    if (!p.github_repo) throw new AppError(409, "not_github_project", "This project is not linked to a GitHub repository");
    const conn = connectionFor(user.id);
    if (!conn) throw new AppError(409, "github_not_connected", "Connect GitHub in Settings before publishing");
    const paths = projectPaths(config, p.workspace_rel, p.id);
    if (!isGitRepo(paths.root)) throw new AppError(409, "not_a_repo", "The workspace is not a git repository");
    const branch = input.branch ?? `nexus/changes-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
    if (branch === "main" || branch === "master" || branch === p.github_branch) {
      throw new AppError(400, "protected_branch", "Publish to a new branch; default and source branches are not written directly");
    }
    if (!validBranchName(paths.root, paths.gitHome, branch)) throw new AppError(400, "invalid_branch", "That is not a valid git branch name");
    // Nothing is created or switched until we know there is something to publish.
    const changes = workspaceChanges(paths.root, paths.gitHome, paths.tmpDir);
    if (changes.length === 0) throw new AppError(409, "nothing_to_publish", "There are no changes to publish");
    const hits = changes.flatMap((c) => scanPatchForSecrets(c.patch).map((h) => `${h} in ${c.path}`));
    if (hits.length > 0) throw new AppError(422, "secret_detected", "Publishing was blocked: credential-shaped values were found", { findings: hits });
    if (localBranchExists(paths.root, paths.gitHome, branch)) {
      throw new AppError(409, "branch_exists", "A local branch with that name already exists. Choose another name.");
    }
    // Create the new branch only now, then commit onto it. Existing branches are never reset.
    git(paths.root, paths.gitHome, ["checkout", "-q", "-b", branch]);
    git(paths.root, paths.gitHome, ["add", "-A"]);
    git(paths.root, paths.gitHome, ["commit", "-q", "--no-verify", "-m", input.message]);
    const sha = git(paths.root, paths.gitHome, ["rev-parse", "HEAD"]).trim();
    const url = `https://github.com/${p.github_repo}.git`;
    // Token travels in the environment as an HTTP header (see cloneRepository); it is not stored in .git/config.
    const res = pushBranch(paths.root, paths.gitHome, url, branch, conn.token);
    if (!res.ok) throw new AppError(502, "push_failed", "Push to GitHub failed", { stderr: res.stderr });
    db.prepare("UPDATE projects SET github_branch = ?, updated_at = ? WHERE id = ?").run(branch, nowIso(), p.id);
    audit(db, user.id, "github.push", branch, { repo: p.github_repo, sha });
    hub.append(p.id, user.id, "git.pushed", { branch, sha, repo: p.github_repo });
    return { branch, sha, repo: p.github_repo };
  });

  api.post("/projects/:id/github/pull-request", async (req) => {
    const { id } = ProjectIdParams.parse(req.params);
    const input = PrInput.parse(req.body);
    const user = requireUser(req);
    const p = loadProject(ctx, req, id);
    if (!p.github_repo || !p.github_branch) throw new AppError(409, "not_published", "Publish a branch before opening a pull request");
    const conn = connectionFor(user.id);
    if (!conn) throw new AppError(409, "github_not_connected", "Connect GitHub in Settings first");
    const pr = await githubApi<{ html_url: string; number: number }>(conn.token, `/repos/${p.github_repo}/pulls`, {
      method: "POST",
      body: { title: input.title, body: input.body, head: p.github_branch, base: input.base },
    });
    audit(db, user.id, "github.pull_request", String(pr.number), { repo: p.github_repo });
    hub.append(p.id, user.id, "git.pull_request", { number: pr.number, url: pr.html_url });
    return { number: pr.number, url: pr.html_url, confirmed: input.confirmPublish };
  });

}

function validBranchName(root: string, gitHome: string, branch: string): boolean {
  if (branch.startsWith("-") || branch.includes("..")) return false;
  try {
    git(root, gitHome, ["check-ref-format", "--branch", branch]);
    return true;
  } catch {
    return false;
  }
}

function localBranchExists(root: string, gitHome: string, branch: string): boolean {
  try {
    git(root, gitHome, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function pushBranch(root: string, gitHome: string, url: string, branch: string, token: string): { ok: boolean; stderr: string } {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
  const res = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "push", url, `HEAD:refs/heads/${branch}`],
    { cwd: root, env, encoding: "utf8", timeout: 180_000 },
  );
  return { ok: res.status === 0, stderr: (res.stderr || "").replace(/x-access-token:[^@\s]+/g, "[REDACTED]").slice(0, 800) };
}
