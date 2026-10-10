import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
export const GITHUB_OAUTH_TOKEN = "https://github.com/login/oauth/access_token";

export type GithubScopeLevel = "public" | "private";

export function oauthScopes(level: GithubScopeLevel): string {
  // Least privilege: public_repo covers public repositories; `repo` is needed only for private repositories.
  return level === "private" ? "repo read:user" : "public_repo read:user";
}

export function githubConfigured(config: Config): boolean {
  return Boolean(config.github.clientId && config.github.clientSecret);
}

export function authorizeUrl(config: Config, state: string, level: GithubScopeLevel): string {
  const url = new URL(GITHUB_OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", config.github.clientId ?? "");
  url.searchParams.set("redirect_uri", `${config.publicOrigin}/api/github/oauth/callback`);
  url.searchParams.set("scope", oauthScopes(level));
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export async function exchangeCode(config: Config, code: string): Promise<{ accessToken: string; scopes: string }> {
  const res = await fetch(GITHUB_OAUTH_TOKEN, {
    method: "POST",
    headers: { Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: `${config.publicOrigin}/api/github/oauth/callback`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error_description?: string };
  if (!body.access_token) throw new AppError(502, "github_oauth_failed", body.error_description ?? "GitHub did not return an access token");
  return { accessToken: body.access_token, scopes: body.scope ?? "" };
}

export async function githubApi<T>(token: string | undefined, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "NEXUS/0.1",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `GitHub API returned HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j.message) msg = `GitHub: ${j.message}`;
    } catch {
      /* keep generic */
    }
    throw new AppError(res.status === 404 ? 404 : 502, "github_error", msg);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Parses https://github.com/<owner>/<repo>[.git] into its parts. Input is validated by the schema first. */
export function parseRepoUrl(url: string): { owner: string; repo: string; fullName: string } {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new AppError(400, "invalid_repo_url", "Use an https://github.com/<owner>/<repo> URL");
  return { owner: m[1]!, repo: m[2]!, fullName: `${m[1]}/${m[2]}` };
}

/**
 * Clones a repository into an empty workspace. The token, when present, is passed through the
 * environment (GIT_CONFIG_*) as an HTTP header; it never appears in argv, the URL, or the remote config.
 */
export function cloneRepository(opts: { url: string; dest: string; gitHome: string; branch?: string; token?: string }): void {
  rmSync(opts.dest, { recursive: true, force: true });
  mkdirSync(opts.gitHome, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: opts.gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
  };
  if (opts.token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`;
  }
  const args = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "clone", "--quiet", "--no-tags", "--depth", "200"];
  if (opts.branch) args.push("--branch", opts.branch, "--single-branch");
  args.push(opts.url, opts.dest);
  const res = spawnSync("git", args, { env, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) {
    const stderr = (res.stderr || "").replace(/x-access-token:[^@\s]+/g, "[REDACTED]").slice(0, 600);
    rmSync(opts.dest, { recursive: true, force: true });
    throw new AppError(422, "clone_failed", `Clone failed${opts.token ? "" : " (private repositories need GitHub connected in Settings)"}`, { stderr });
  }
}

/** Scans added lines for credential-shaped strings before anything leaves the machine. */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

export function scanPatchForSecrets(patch: string): string[] {
  const hits = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) hits.add(p.name);
  }
  return [...hits];
}

export { join };
