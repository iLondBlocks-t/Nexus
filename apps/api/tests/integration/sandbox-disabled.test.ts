import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createProject, makeTestApp, register, waitForJob, type Session, type TestApp } from "../helpers.js";

/** NEXUS_SANDBOX_MODE=disabled must fail closed for both commands and the agent. */
let t: TestApp;
let s: Session;
let pid: string;

beforeAll(async () => {
  t = await makeTestApp({ NEXUS_SANDBOX_MODE: "disabled" });
  s = await register(t, "nosandbox@example.test");
  pid = await createProject(t, s, "No Sandbox");
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe("NEXUS_SANDBOX_MODE=disabled", () => {
  it("does not execute an allowed command", async () => {
    const res = await api(t, s, "POST", `/api/projects/${pid}/commands`, { command: "echo SHOULD_NOT_RUN" });
    expect(res.statusCode).toBe(201);
    const jobId = (res.json() as { job: { id: string } }).job.id;
    const done = await waitForJob(t, s, pid, jobId);
    expect(done.job.status).toBe("failed");
    const out = (await api(t, s, "GET", `/api/projects/${pid}/jobs/${jobId}`)).json() as { output: Array<{ text: string }> };
    expect(out.output.map((o) => o.text).join("")).not.toContain("SHOULD_NOT_RUN");
  });

  it("does not start the agent engine, even with a provider configured", async () => {
    const put = await api(t, s, "PUT", "/api/settings", { providerId: "openai", modelId: "gpt-4.1", apiKey: "sk-test-NOSANDBOX-000000000000000000", language: "en", theme: "midnight" });
    expect(put.statusCode).toBe(200);
    const res = await api(t, s, "POST", `/api/projects/${pid}/agent/messages`, { text: "hello", mode: "build" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("sandbox_disabled");
  });
});
