import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { AppError } from "./errors.js";
import { assertCsrf, resolveSession, SESSION_COOKIE } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerGithubRoutes } from "./routes/github.js";
import { redact } from "./security/redact.js";

const PUBLIC_API = new Set(["/api/auth/login", "/api/auth/register", "/api/health"]);

/** Browsers always send Origin on cross-site state-changing requests. Reject any mismatched origin. */
export function assertSameOrigin(origin: string | undefined, host: string | undefined, publicOrigin: string): void {
  if (origin === undefined || origin === "null") {
    if (origin === "null") throw new AppError(403, "origin_rejected", "Cross-origin request rejected");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError(403, "origin_rejected", "Malformed Origin header");
  }
  if (origin === publicOrigin || (host !== undefined && parsed.host === host)) return;
  throw new AppError(403, "origin_rejected", "Cross-origin request rejected");
}

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: "info", redact: ["req.headers.authorization", "req.headers.cookie"] } : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: ctx.config.isProduction,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (ctx.config.isProduction) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/")) return;
    const method = req.method.toUpperCase();
    const stateChanging = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (stateChanging) assertSameOrigin(req.headers.origin, req.headers.host, ctx.config.publicOrigin);
    const token = req.cookies[SESSION_COOKIE];
    const resolved = resolveSession(ctx.db, token);
    if (resolved) {
      req.user = resolved.user;
      req.authSession = resolved.session;
      if (stateChanging && !PUBLIC_API.has(url)) assertCsrf(req);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "validation_failed", message: "Request validation failed", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: "bad_request", message: redact((err as Error).message).slice(0, 300) } });
    }
    const detail = redact(String((err as Error).stack ?? err)).slice(0, 2000);
    req.log.error({ err: detail }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Something went wrong. The error has been logged." } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.status(404).send({ error: { code: "not_found", message: "Endpoint not found" } });
    }
    const index = join(ctx.config.webDistDir, "index.html");
    if (req.method === "GET" && existsSync(index)) return reply.type("text/html").sendFile("index.html", ctx.config.webDistDir);
    return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
  });

  app.get("/api/health", async () => ({ ok: true, service: "nexus-api", version: "0.1.0" }));

  await app.register(async (api) => {
    registerAuthRoutes(api, ctx);
    registerProjectRoutes(api, ctx);
    registerAgentRoutes(api, ctx);
    registerSettingsRoutes(api, ctx);
    registerGithubRoutes(api, ctx);
  }, { prefix: "/api" });

  if (existsSync(ctx.config.webDistDir)) {
    await app.register(fastifyStatic, { root: ctx.config.webDistDir, prefix: "/", index: false, decorateReply: true, wildcard: false });
  }
  return app;
}
