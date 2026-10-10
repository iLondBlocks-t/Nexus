import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createProject, makeTestApp, register, type Session, type TestApp, ORIGIN } from "../helpers.js";

/** Real HTTP listener so the SSE stream can be read as a stream (inject() buffers responses). */
let t: TestApp;
let s: Session;
let pid: string;
let base: string;

beforeAll(async () => {
  t = await makeTestApp();
  s = await register(t, "sse@example.test");
  pid = await createProject(t, s, "Stream");
  base = await t.app.listen({ port: 0, host: "127.0.0.1" });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function readUntil(res: Response, needle: string, timeoutMs = 8000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), remaining));
    const { value, done } = await Promise.race([reader.read(), timer]);
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text;
}

describe("project event stream (SSE)", () => {
  it("serves text/event-stream, replays persisted events, then delivers live events", async () => {
    const res = await fetch(`${base}/api/projects/${pid}/events`, { headers: { cookie: s.cookie, origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const replayed = readUntil(res, "event: project.created");
    const text = await replayed;
    expect(text).toContain("event: project.created");
    expect(text).toMatch(/id: \d+/);
  });

  it("resumes after Last-Event-ID without repeating earlier events", async () => {
    const all = (await api(t, s, "GET", `/api/projects/${pid}/events/replay?after=0`)).json() as { events: Array<{ seq: number }> };
    const last = all.events[all.events.length - 1]!.seq;
    const res = await fetch(`${base}/api/projects/${pid}/events`, {
      headers: { cookie: s.cookie, origin: ORIGIN, "last-event-id": String(last) },
    });
    const pending = readUntil(res, "live.txt", 8000);
    await new Promise((r) => setTimeout(r, 300)); // let the stream attach its live subscriber
    t.ctx.hub.append(pid, s.userId, "file.changed", { path: "live.txt", source: "test" });
    const text = await pending;
    expect(text).not.toContain("event: project.created");
    expect(text).toContain("event: file.changed");
    expect(text).toContain("live.txt");
  });

  it("refuses the stream to another user", async () => {
    const other = await register(t, "sse-other@example.test");
    const res = await fetch(`${base}/api/projects/${pid}/events`, { headers: { cookie: other.cookie, origin: ORIGIN } });
    expect([403, 404]).toContain(res.status);
    await res.body?.cancel().catch(() => undefined);
  });
});
