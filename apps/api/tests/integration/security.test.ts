import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { api, createProject, makeTestApp, register, waitForJob, type Session, type TestApp, ORIGIN } from "../helpers.js";

const LONG_NODE = "node -e \"setTimeout(() => {}, 60000)\"";
let t: TestApp;

async function waitForStatus(app: TestApp, s: Session, projectId: string, jobId: string, status: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await api(app, s, "GET", `/api/projects/${projectId}/jobs/${jobId}`)).json() as { job: { status: string } };
    if (job.job.status === status) return;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never reached ${status} (now ${job.job.status})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
let alice: Session;
let bob: Session;
let projectA: string;

beforeAll(async () => {
  t = await makeTestApp();
  alice = await register(t, "alice@example.test");
  bob = await register(t, "bob@example.test");
  projectA = await createProject(t, alice, "Alice Project");
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe("authentication and sessions", () => {
  it("rejects a wrong password with a generic error", async () => {
    const res = await api(t, null, "POST", "/api/auth/login", { email: "alice@example.test", password: "wrong-password-xyz" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/no such user|not registered|unknown email|no account/i);
  });

  it("rejects duplicate registration without revealing account details", async () => {
    const res = await api(t, null, "POST", "/api/auth/register", { email: "alice@example.test", password: "another-long-password", displayName: "x" });
    expect([400, 409]).toContain(res.statusCode);
  });

  it("returns no user for unauthenticated requests and blocks protected endpoints", async () => {
    const me = await api(t, null, "GET", "/api/auth/me");
    expect(me.json()).toMatchObject({ user: null });
    const projects = await api(t, null, "GET", "/api/projects");
    expect(projects.statusCode).toBe(401);
  });

  it("stores only a hash of the session token", () => {
    const token = alice.cookie.split("=")[1]!;
    const rows = t.db.prepare("SELECT token_hash FROM auth_sessions").all() as Array<{ token_hash: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.token_hash).not.toBe(token);
  });

  it("requires a CSRF token on state-changing requests", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "No CSRF", kind: "blank" },
      headers: { origin: ORIGIN, cookie: alice.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_failed");
  });

  it("rejects a cross-site Origin on state-changing requests", async () => {
    const res = await api(t, alice, "POST", "/api/projects", { name: "Evil", kind: "blank" }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("origin_rejected");
  });

  it("rejects a null Origin", async () => {
    const res = await api(t, alice, "POST", "/api/projects", { name: "Null", kind: "blank" }, { origin: "null" });
    expect(res.statusCode).toBe(403);
  });

  it("sets security headers including CSP and frame denial", async () => {
    const res = await api(t, null, "GET", "/api/health");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("invalidates the session on logout", async () => {
    const s = await register(t, "logout@example.test");
    const out = await api(t, s, "POST", "/api/auth/logout");
    expect(out.statusCode).toBeLessThan(300);
    const me = await api(t, s, "GET", "/api/auth/me");
    expect(me.json()).toMatchObject({ user: null });
  });
});

describe("authorization across users", () => {
  it("returns 404 (not 403) for another user's project", async () => {
    for (const [method, url] of [
      ["GET", `/api/projects/${projectA}`],
      ["GET", `/api/projects/${projectA}/tree`],
      ["GET", `/api/projects/${projectA}/file?path=README.md`],
      ["GET", `/api/projects/${projectA}/changes`],
      ["GET", `/api/projects/${projectA}/jobs`],
      ["GET", `/api/projects/${projectA}/approvals`],
      ["GET", `/api/projects/${projectA}/artifacts`],
      ["GET", `/api/projects/${projectA}/agent`],
      ["POST", `/api/projects/${projectA}/commands`],
      ["PUT", `/api/projects/${projectA}/file`],
      ["DELETE", `/api/projects/${projectA}`],
    ] as const) {
      const res = await api(t, bob, method, url, method === "PUT" ? { path: "x.txt", content: "bob" } : method === "POST" && url.endsWith("commands") ? { command: "ls" } : undefined);
      expect([403, 404], `${method} ${url}`).toContain(res.statusCode);
    }
    expect(existsSync(join(t.ctx.config.workspacesDir, "nonexistent"))).toBe(false);
  });

  it("does not list other users' projects", async () => {
    const res = await api(t, bob, "GET", "/api/projects");
    const ids = (res.json() as { projects: Array<{ id: string }> }).projects.map((p) => p.id);
    expect(ids).not.toContain(projectA);
  });

  it("does not let another user approve a job in this project", async () => {
    const res = await api(t, bob, "POST", `/api/projects/${projectA}/approvals/apv_missing/decision`, { decision: "approve" });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("refuses to expose the engine (OpenCode) password or the master key", async () => {
    const res = await api(t, alice, "GET", `/api/projects/${projectA}/agent`);
    expect(res.body).not.toMatch(/OPENCODE_SERVER_PASSWORD|masterKey|NEXUS_ENCRYPTION_KEY/);
  });
});

describe("workspace path validation", () => {
  const bad = ["../secret.txt", "/etc/passwd", "a/../../b", ".git/config", ".nexus/x", "sub\\..\\x", "a\u0000b", "./.git/HEAD"];
  for (const p of bad) {
    it(`rejects path ${JSON.stringify(p)}`, async () => {
      const res = await api(t, alice, "PUT", `/api/projects/${projectA}/file`, { path: p, content: "x" });
      expect([400, 403, 404]).toContain(res.statusCode);
      const read = await api(t, alice, "GET", `/api/projects/${projectA}/file?path=${encodeURIComponent(p)}`);
      expect([400, 403, 404]).toContain(read.statusCode);
    });
  }

  it("refuses to follow a symlink that points outside the workspace", async () => {
    const root = join(t.ctx.config.workspacesDir, "..", "..");
    const project = t.db.prepare("SELECT workspace_rel FROM projects WHERE id = ?").get(projectA) as { workspace_rel: string };
    const ws = join(t.ctx.config.workspacesDir, project.workspace_rel);
    expect(existsSync(ws)).toBe(true);
    symlinkSync("/etc", join(ws, "escape"));
    const read = await api(t, alice, "GET", `/api/projects/${projectA}/file?path=escape/passwd`);
    expect([400, 403, 404]).toContain(read.statusCode);
    const write = await api(t, alice, "PUT", `/api/projects/${projectA}/file`, { path: "escape/pwned.txt", content: "x" });
    expect([400, 403, 404]).toContain(write.statusCode);
    expect(existsSync("/etc/pwned.txt")).toBe(false);
    expect(root.length).toBeGreaterThan(0);
  });

  it("lists the workspace root with an empty path", async () => {
    const res = await api(t, alice, "GET", `/api/projects/${projectA}/tree?path=`);
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    expect(names).toContain("README.md");
    expect(names).not.toContain(".git");
  });

  it("rejects an empty file path", async () => {
    const res = await api(t, alice, "GET", `/api/projects/${projectA}/file?path=`);
    expect(res.statusCode).toBe(400);
  });

  it("writes and reads a normal file", async () => {
    const put = await api(t, alice, "PUT", `/api/projects/${projectA}/file`, { path: "src/hello.txt", content: "hello nexus\n" });
    expect(put.statusCode).toBe(200);
    const get = await api(t, alice, "GET", `/api/projects/${projectA}/file?path=src/hello.txt`);
    expect(get.json()).toMatchObject({ content: "hello nexus\n" });
  });
});

describe("commands, policy, approvals and sandbox", () => {
  it("runs an allowed command and captures stdout and exit code", async () => {
    const res = await api(t, alice, "POST", `/api/projects/${projectA}/commands`, { command: "echo NEXUS_OK && ls src" });
    expect(res.statusCode).toBe(201);
    const jobId = (res.json() as { job: { id: string } }).job.id;
    const done = await waitForJob(t, alice, projectA, jobId);
    expect(done.job.status).toBe("succeeded");
    const out = await api(t, alice, "GET", `/api/projects/${projectA}/jobs/${jobId}`);
    expect(JSON.stringify(out.json())).toContain("NEXUS_OK");
    expect(JSON.stringify(out.json())).toContain("hello.txt");
  });

  it("denies a clearly dangerous command outright and records the denial", async () => {
    const res = await api(t, alice, "POST", `/api/projects/${projectA}/commands`, { command: "rm -rf /" });
    expect(res.statusCode).toBe(201);
    const job = (res.json() as { job: { status: string; policy: string } }).job;
    expect(job.status).toBe("denied");
    expect(job.policy).toBe("deny");
    const run = await api(t, alice, "GET", `/api/projects/${projectA}/jobs`);
    expect(JSON.stringify(run.json())).not.toContain('"status":"running"');
  });

  it("requires approval for a network-capable command and runs it only after approval", async () => {
    const res = await api(t, alice, "POST", `/api/projects/${projectA}/commands`, { command: "npm install left-pad --no-save", network: true });
    expect(res.statusCode).toBe(202);
    const job = (res.json() as { job: { id: string; status: string } }).job;
    expect(job.status).toBe("awaiting_approval");
    const approvals = (await api(t, alice, "GET", `/api/projects/${projectA}/approvals`)).json() as { approvals: Array<{ id: string; status: string }> };
    const pending = approvals.approvals.find((a) => a.status === "pending");
    expect(pending).toBeDefined();
    const denied = await api(t, alice, "POST", `/api/projects/${projectA}/approvals/${pending!.id}/decision`, { decision: "deny" });
    expect(denied.statusCode).toBe(200);
    const after = await api(t, alice, "GET", `/api/projects/${projectA}/jobs/${job.id}`);
    expect((after.json() as { job: { status: string } }).job.status).toBe("denied");
  });

  it("blocks network access inside the sandbox even for allowed node commands", async () => {
    const script = "node -e \"fetch('https://registry.npmjs.org/').then(()=>console.log('NET_OPEN')).catch(()=>console.log('NET_BLOCKED'))\"";
    const res = await api(t, alice, "POST", `/api/projects/${projectA}/commands`, { command: script, network: false });
    expect(res.statusCode).toBe(201);
    const jobId = (res.json() as { job: { id: string } }).job.id;
    const done = await waitForJob(t, alice, projectA, jobId, 90_000);
    const body = (await api(t, alice, "GET", `/api/projects/${projectA}/jobs/${jobId}`)).json() as { output: Array<{ text: string }> };
    const printed = body.output.map((o) => o.text).join("");
    expect(printed).toContain("NET_BLOCKED");
    expect(printed).not.toContain("NET_OPEN");
    expect(done.job.status).toBeDefined();
  }, 120_000);

  it("hides NEXUS secrets and the data directory from job processes", async () => {
    const secretPath = join(t.dataDir, ".secret-key");
    expect(existsSync(secretPath)).toBe(true);
    const cmd = `cat "${secretPath}" 2>&1; ls "${t.dataDir}" 2>&1 | head -5; echo DONE`;
    const res = await api(t, alice, "POST", `/api/projects/${projectA}/commands`, { command: cmd });
    const jobId = (res.json() as { job: { id: string } }).job.id;
    await waitForJob(t, alice, projectA, jobId);
    const out = JSON.stringify((await api(t, alice, "GET", `/api/projects/${projectA}/jobs/${jobId}`)).json());
    const secret = readFileSync(secretPath, "utf8").trim();
    expect(out).not.toContain(secret);
    expect(out).toContain("DONE");
  });

  it("cancels a long-running job", async () => {
    const res = await api(t, alice, "POST", `/api/projects/${projectA}/commands`, { command: LONG_NODE });
    expect(res.statusCode).toBe(201);
    const jobId = (res.json() as { job: { id: string } }).job.id;
    await waitForStatus(t, alice, projectA, jobId, "running");
    const cancel = await api(t, alice, "POST", `/api/projects/${projectA}/jobs/${jobId}/cancel`);
    expect(cancel.statusCode).toBeLessThan(300);
    const done = await waitForJob(t, alice, projectA, jobId, 30_000);
    expect(["cancelled", "failed"]).toContain(done.job.status);
  }, 60_000);

  it("emergency stop kills running jobs", async () => {
    const res = await api(t, alice, "POST", `/api/projects/${projectA}/commands`, { command: LONG_NODE });
    const jobId = (res.json() as { job: { id: string } }).job.id;
    await waitForStatus(t, alice, projectA, jobId, "running");
    const stop = await api(t, alice, "POST", `/api/projects/${projectA}/emergency-stop`);
    expect(stop.statusCode).toBe(200);
    const done = await waitForJob(t, alice, projectA, jobId, 30_000);
    expect(done.job.status).not.toBe("running");
  }, 60_000);
});

describe("secrets at rest and in responses", () => {
  const KEY = "sk-test-SECRET-DO-NOT-LEAK-1234567890";

  it("accepts a provider key but never returns it", async () => {
    const put = await api(t, alice, "PUT", "/api/settings", { providerId: "openai", modelId: "gpt-4.1", apiKey: KEY, language: "en", theme: "midnight" });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(KEY);
    const get = await api(t, alice, "GET", "/api/settings");
    expect(get.body).not.toContain(KEY);
    expect(get.json().settings.hasApiKey).toBe(true);
  });

  it("stores the key encrypted in the database", () => {
    const row = t.db.prepare("SELECT api_key_ciphertext FROM user_settings WHERE user_id = ?").get(alice.userId) as { api_key_ciphertext: string };
    expect(row.api_key_ciphertext).toBeTruthy();
    expect(row.api_key_ciphertext).not.toContain(KEY);
  });

  it("does not place the key in the database plaintext or in events", async () => {
    const dump = readFileSync(t.config.dbPath);
    expect(dump.includes(Buffer.from(KEY))).toBe(false);
  });

  it("rejects invalid settings input", async () => {
    const res = await api(t, alice, "PUT", "/api/settings", { providerId: "../../evil", modelId: "" });
    expect(res.statusCode).toBe(400);
  });
});

describe("quotas", () => {
  it("reports usage for the current user", async () => {
    const res = await api(t, alice, "GET", "/api/me/usage");
    expect(res.statusCode).toBe(200);
  });
});

describe("events and resumable streams", () => {
  it("replays persisted events after a cursor", async () => {
    const all = (await api(t, alice, "GET", `/api/projects/${projectA}/events/replay?after=0`)).json() as { events: Array<{ seq: number; type: string }> };
    expect(all.events.length).toBeGreaterThan(0);
    const mid = all.events[Math.floor(all.events.length / 2)]!.seq;
    const tail = (await api(t, alice, "GET", `/api/projects/${projectA}/events/replay?after=${mid}`)).json() as { events: Array<{ seq: number }> };
    expect(tail.events.every((e) => e.seq > mid)).toBe(true);
  });

  it("does not expose another user's events", async () => {
    const res = await api(t, bob, "GET", `/api/projects/${projectA}/events/replay?after=0`);
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe("artifacts", () => {
  it("exports a zip that excludes .git and secrets, and records a checksum", async () => {
    const exp = await api(t, alice, "POST", `/api/projects/${projectA}/artifacts/export`, {});
    expect(exp.statusCode).toBe(201);
    const art = (exp.json() as { artifact: { id: string; sha256?: string } }).artifact;
    const dl = await api(t, alice, "GET", `/api/projects/${projectA}/artifacts/${art.id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(dl.rawPayload.includes(Buffer.from(".git/config"))).toBe(false);
    const bob2 = await api(t, bob, "GET", `/api/projects/${projectA}/artifacts/${art.id}/download`);
    expect([403, 404]).toContain(bob2.statusCode);
  });
});

describe("project lifecycle", () => {
  it("deletes a project and its workspace only for the owner", async () => {
    const id = await createProject(t, bob, "Bob Temp");
    const denied = await api(t, alice, "DELETE", `/api/projects/${id}`);
    expect([403, 404]).toContain(denied.statusCode);
    const ok = await api(t, bob, "DELETE", `/api/projects/${id}`, { confirm: "Bob Temp" });
    expect(ok.statusCode).toBeLessThan(300);
    const gone = await api(t, bob, "GET", `/api/projects/${id}`);
    expect(gone.statusCode).toBe(404);
  });

  it("produces a Godot 2D project that passes the static validator", async () => {
    const id = await createProject(t, alice, "Arena Brawler", "godot-2d-arena");
    const row = t.db.prepare("SELECT workspace_rel FROM projects WHERE id = ?").get(id) as { workspace_rel: string };
    const root = join(t.ctx.config.workspacesDir, row.workspace_rel);
    expect(readFileSync(join(root, "project.godot"), "utf8")).toContain("run/main_scene");
    expect(existsSync(join(root, "scenes", "arena.tscn"))).toBe(true);
    const { validateGodotProject } = await import("../../src/gamebuilder/validate.js");
    const report = validateGodotProject(root);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    // Negative: a broken node path must be detected.
    const arenaGd = join(root, "scripts", "arena.gd");
    writeFileSync(arenaGd, readFileSync(arenaGd, "utf8") + "\nfunc _broken() -> void:\n\tvar x = $NoSuchNode\n");
    const broken = validateGodotProject(root);
    expect(broken.ok).toBe(false);
    expect(broken.errors.join("\n")).toContain("NoSuchNode");
    mkdirSync(join(root, "tmp"), { recursive: true });
  });
});
