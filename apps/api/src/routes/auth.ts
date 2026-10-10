import { usageToday } from "../services/events.js";
import type { FastifyInstance } from "fastify";
import { LoginInput, RegisterInput } from "@nexus/shared";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { clearSessionCookie, createSession, destroySession, requireUser, setSessionCookie, SESSION_COOKIE } from "../auth.js";
import { hashPassword, verifyPassword } from "../security/passwords.js";
import { newId, nowIso } from "../db/index.js";
import { audit } from "../services/events.js";

const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export function registerAuthRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const secure = config.publicOrigin.startsWith("https://");

  api.post("/auth/register", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!config.allowRegistration) throw new AppError(403, "registration_closed", "Registration is disabled on this server");
    const input = RegisterInput.parse(req.body);
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(input.email);
    if (existing) throw new AppError(409, "email_taken", "An account with this email already exists");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const id = newId("usr");
    const role = count === 0 ? "admin" : "user";
    db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      input.email,
      input.displayName,
      await hashPassword(input.password),
      role,
      nowIso(),
    );
    db.prepare("INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)").run(id, nowIso());
    audit(db, id, "auth.register", id, { role });
    const session = createSession(db, id);
    setSessionCookie(reply, session.token, secure);
    return reply.status(201).send({
      user: { id, email: input.email, displayName: input.displayName, role },
      csrfToken: session.csrfToken,
    });
  });

  api.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const row = db.prepare("SELECT id, email, display_name, password_hash, role FROM users WHERE email = ?").get(input.email) as
      | { id: string; email: string; display_name: string; password_hash: string; role: "admin" | "user" }
      | undefined;
    // Always run one hash verification so response timing does not reveal whether the email exists.
    const ok = await verifyPassword(input.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      audit(db, row?.id ?? null, "auth.login_failed", input.email);
      throw new AppError(401, "invalid_credentials", "Email or password is incorrect");
    }
    const session = createSession(db, row.id);
    setSessionCookie(reply, session.token, secure);
    audit(db, row.id, "auth.login", row.id);
    return {
      user: { id: row.id, email: row.email, displayName: row.display_name, role: row.role },
      csrfToken: session.csrfToken,
    };
  });

  api.post("/auth/logout", async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    if (req.user) audit(db, req.user.id, "auth.logout", req.user.id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  api.get("/auth/me", async (req) => {
    const user = req.user;
    if (!user || !req.authSession) return { user: null, csrfToken: null, registrationOpen: config.allowRegistration };
    return { user, csrfToken: req.authSession.csrfToken, registrationOpen: config.allowRegistration };
  });

  api.get("/me/usage", async (req) => {
    const user = requireUser(req);
    return {
      today: {
        agentMessages: usageToday(db, user.id, "agent_message"),
        commands: usageToday(db, user.id, "command"),
        agentCostUsd: usageToday(db, user.id, "agent_cost"),
      },
      limits: {
        agentMessagesPerDay: config.quotas.agentMessagesPerDay,
        commandsPerDay: config.quotas.commandsPerDay,
      },
      note: "Agent cost is reported by the model provider through the engine. It is informational and is not a billing record.",
    };
  });
}
