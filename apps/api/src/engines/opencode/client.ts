/** Minimal typed HTTP client for the documented `opencode serve` API (https://opencode.ai/docs/server/). */
export interface OpenCodeClientOptions {
  baseUrl: string;
  password: string;
  username?: string;
}

export class OpenCodeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`OpenCode ${path} returned HTTP ${status}`);
    this.name = "OpenCodeHttpError";
  }
}

export class OpenCodeClient {
  private readonly auth: string;
  constructor(private readonly opts: OpenCodeClientOptions) {
    this.auth = "Basic " + Buffer.from(`${opts.username ?? "opencode"}:${opts.password}`).toString("base64");
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(this.opts.baseUrl + path, {
      method,
      headers: {
        Authorization: this.auth,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new OpenCodeHttpError(res.status, path, text.slice(0, 2000));
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** Opens the server-sent event stream. Caller reads `body` and must abort via `signal`. */
  async openEventStream(signal: AbortSignal): Promise<Response> {
    const res = await fetch(this.opts.baseUrl + "/event", {
      headers: { Authorization: this.auth, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new OpenCodeHttpError(res.status, "/event", "");
    return res;
  }
}

/** Parses an SSE byte stream into JSON `data:` payloads. Non-JSON payloads are skipped. */
export async function forEachSseEvent(body: ReadableStream<Uint8Array>, onEvent: (event: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}
