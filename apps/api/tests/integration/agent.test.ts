import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, createProject, makeTestApp, register, type Session, type TestApp } from "../helpers.js";

/**
 * Real OpenCode engine, real sandbox-free engine server on 127.0.0.1 with basic auth.
 * This sandbox has NO route to model providers, so a model turn cannot succeed here. The test
 * verifies everything up to and including honest failure reporting, and labels that limitation.
 */
const FAKE_KEY = "sk-test-AGENT-FAKE-KEY-0000000000000000";
let t: TestApp;
let s: Session;
let projectId: string;

beforeAll(async () => {
  t = await makeTestApp();
  s = await register(t, "agent@example.test");
  projectId = await createProject(t, s, "Agent Project");
  const put = await api(t, s, "PUT", "/api/settings", { providerId: "openai", modelId: "gpt-4.1", apiKey: FAKE_KEY, language: "en", theme: "midnight" });
  expect(put.statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("OpenCode agent integration", () => {
  it("reports the engine catalog and key recognition without a model call", async () => {
    const res = await api(t, s, "GET", "/api/providers");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Array<{ id: string; models: unknown[] }>; notice: string };
    expect(body.providers.length).toBeGreaterThan(50);
    expect(body.providers.find((p) => p.id === "openai")?.models.length).toBeGreaterThan(0);
    expect(body.notice).toMatch(/free|price/i);
  }, 120_000);

  it("tests a provider configuration through the engine", async () => {
    const res = await api(t, s, "POST", "/api/providers/test", { providerId: "openai", modelId: "gpt-4.1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; keyRecognized: boolean; modelFound: boolean };
    expect(body.keyRecognized).toBe(true);
    expect(body.modelFound).toBe(true);
    expect(res.body).not.toContain(FAKE_KEY);
  }, 120_000);

  it("accepts a message, starts the engine, and surfaces the outcome without leaking the key", async () => {
    const res = await api(t, s, "POST", `/api/projects/${projectId}/agent/messages`, { text: "Create hello.txt containing hi", mode: "build" });
    expect([202, 502]).toContain(res.statusCode);
    const deadline = Date.now() + 120_000;
    let state: { session: { status: string; lastError: string | null } | null; engine: { running: boolean } };
    for (;;) {
      state = (await api(t, s, "GET", `/api/projects/${projectId}/agent`)).json();
      if (state.session && state.session.status !== "busy") break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(state!.session).not.toBeNull();
    expect(state!.engine.running).toBe(true);
    expect(["idle", "error"]).toContain(state!.session!.status);
    expect(JSON.stringify(state!)).not.toContain(FAKE_KEY);
    const events = (await api(t, s, "GET", `/api/projects/${projectId}/events/replay?after=0`)).json() as { events: Array<{ type: string }> };
    expect(events.events.map((e) => e.type)).toContain("agent.user_message");
  }, 150_000);

  it("never writes the provider key to the engine home or the workspace", () => {
    const roots = [t.config.enginesDir, t.config.workspacesDir, join(t.dataDir, "homes")];
    for (const root of roots) {
      for (const file of filesUnder(root)) {
        if (file.endsWith(".sqlite") || file.endsWith(".db")) continue;
        let content: Buffer;
        try {
          content = readFileSync(file);
        } catch {
          continue; // transient temp file removed while scanning
        }
        expect(content.includes(Buffer.from(FAKE_KEY)), file).toBe(false);
      }
    }
    expect(filesUnder(t.config.enginesDir).length).toBeGreaterThan(0);
  });

  it("refuses a second message while the agent is still working", async () => {
    // A separate project with a session row we control, so no live engine event can race the state.
    const busyProject = await createProject(t, s, "Busy Guard");
    const { nowIso } = await import("../../src/db/index.js");
    const now = nowIso();
    t.db
      .prepare("INSERT INTO agent_sessions (id, project_id, owner_id, engine, engine_session_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'opencode', 'fake-engine-session', 'Busy', 'busy', ?, ?)")
      .run("ags_guard_test", busyProject, s.userId, now, now);
    const res = await api(t, s, "POST", `/api/projects/${busyProject}/agent/messages`, { text: "again", mode: "build" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("agent_busy");
  });

  it("cancels cleanly and starts a new conversation", async () => {
    const cancel = await api(t, s, "POST", `/api/projects/${projectId}/agent/cancel`);
    expect(cancel.statusCode).toBeLessThan(300);
    const fresh = await api(t, s, "POST", `/api/projects/${projectId}/agent/new-conversation`);
    expect(fresh.statusCode).toBeLessThan(300);
    const state = (await api(t, s, "GET", `/api/projects/${projectId}/agent`)).json() as { session: unknown };
    expect(state.session).toBeNull();
  });
});
