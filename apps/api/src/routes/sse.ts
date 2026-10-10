import type { FastifyReply, FastifyRequest } from "fastify";
import type { EventHub, StoredEvent } from "../services/events.js";

/**
 * Server-sent events for a project. Clients resume with the Last-Event-ID header (or ?after=):
 * missed events are replayed from the persisted log before live delivery begins.
 */
export function sendEventStream(req: FastifyRequest, reply: FastifyReply, hub: EventHub, projectId: string, afterSeq: number): void {
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  let cursor = afterSeq;
  const write = (e: StoredEvent) => {
    if (closed || e.seq <= cursor) return;
    cursor = e.seq;
    raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, payload: e.payload, createdAt: e.createdAt })}\n\n`);
  };
  // Subscribe first so nothing is missed between replay and live delivery; duplicates are dropped by cursor.
  const unsubscribe = hub.subscribe(projectId, write);
  for (let batch = hub.replay(projectId, cursor, 500); batch.length > 0; batch = hub.replay(projectId, cursor, 500)) {
    batch.forEach(write);
    if (batch.length < 500) break;
  }
  raw.write(`retry: 2000\n: connected cursor=${cursor}\n\n`);
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    raw.end();
  };
  req.raw.on("close", close);
  raw.on("error", close);
}
