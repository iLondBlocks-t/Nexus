import type { FastifyReply, FastifyRequest } from "fastify";
import { nowIso, type Db } from "./db/index.js";
import { AppError } from "./errors.js";
import { randomToken, safeEqual, sha256 } from "./security/crypto.js";
import type { AuthSession, AuthUser } from "./context.js";

export const SESSION_COOKIE = "nexus_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    authSession?: AuthSession;
  }
}

export function createSession(db: Db, userId: string): { token: string; csrfToken: string; expiresAt: string } {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const id = `ses_${randomToken(12)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare("INSERT INTO auth_sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    userId,
    sha256(token),
    csrfToken,
    now.toISOString(),
    expiresAt,
    now.toISOString(),
  );
  return { token, csrfToken, expiresAt };
}

/** Resolves the session cookie to a user. Expired sessions are deleted on sight. */
export function resolveSession(db: Db, token: string | undefined): { user: AuthUser; session: AuthSession } | undefined {
  if (!token || token.length < 20) return undefined;
  const row = db
    .prepare(
      `SELECT s.id AS sid, s.csrf_token, s.expires_at, u.id, u.email, u.display_name, u.role
       FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as
    | { sid: string; csrf_token: string; expires_at: string; id: string; email: string; display_name: string; role: "admin" | "user" }
    | undefined;
  if (!row) return undefined;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(row.sid);
    return undefined;
  }
  db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), row.sid);
  return {
    user: { id: row.id, email: row.email, displayName: row.display_name, role: row.role },
    session: { id: row.sid, csrfToken: row.csrf_token },
  };
}

export function destroySession(db: Db, token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
}

/** Requires an authenticated user. Throws 401 otherwise. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new AppError(401, "unauthenticated", "Sign in to continue");
  return req.user;
}

/** Verifies the double-submit CSRF token for state-changing requests. */
export function assertCsrf(req: FastifyRequest): void {
  const expected = req.authSession?.csrfToken;
  const provided = req.headers["x-csrf-token"];
  if (!expected || typeof provided !== "string" || !safeEqual(provided, expected)) {
    throw new AppError(403, "csrf_failed", "Missing or invalid CSRF token");
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
