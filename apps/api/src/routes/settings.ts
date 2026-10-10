import type { FastifyInstance } from "fastify";
import { ProviderSettingsInput } from "@nexus/shared";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { requireUser } from "../auth.js";
import { nowIso } from "../db/index.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";
import { audit } from "../services/events.js";
import { getSettingsRow, publicSettings } from "../providers/settings.js";

export function registerSettingsRoutes(api: FastifyInstance, ctx: AppContext): void {
  const { db, config, engine } = ctx;

  api.get("/settings", async (req) => {
    const user = requireUser(req);
    return { settings: publicSettings(getSettingsRow(db, user.id)), sandbox: { mode: config.sandboxMode } };
  });

  api.put("/settings", async (req) => {
    const user = requireUser(req);
    const input = ProviderSettingsInput.parse(req.body);
    const current = getSettingsRow(db, user.id);
    const sameProvider = current?.provider_id === input.providerId;
    let ciphertext: string | null = sameProvider ? (current?.api_key_ciphertext ?? null) : null;
    if (input.clearApiKey) ciphertext = null;
    if (input.apiKey !== undefined && input.apiKey.trim().length > 0) {
      ciphertext = encryptSecret(config.masterKey, input.apiKey.trim());
    }
    db.prepare(
      `INSERT INTO user_settings (user_id, language, theme, provider_id, model_id, api_key_ciphertext, auto_approve_edits, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET language = excluded.language, theme = excluded.theme, provider_id = excluded.provider_id,
         model_id = excluded.model_id, api_key_ciphertext = excluded.api_key_ciphertext, auto_approve_edits = excluded.auto_approve_edits, updated_at = excluded.updated_at`,
    ).run(user.id, input.language, input.theme, input.providerId, input.modelId, ciphertext, input.autoApproveEdits ? 1 : 0, nowIso());
    // Changing provider or key restarts engines on their next use; the key is never written to logs.
    audit(db, user.id, "settings.updated", user.id, { provider: input.providerId, model: input.modelId, keyChanged: input.apiKey !== undefined || input.clearApiKey });
    return { settings: publicSettings(getSettingsRow(db, user.id)) };
  });

  api.get("/providers", async (req) => {
    requireUser(req);
    try {
      const providers = await engine.getCatalog();
      return {
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          envVars: p.envVars,
          requiresApiKey: p.envVars.length > 0,
          connectedInEngine: p.connected,
          models: p.models,
        })),
        notice:
          "Costs and free status come from the engine's model catalog. 'Reported free' means the catalog lists zero price; check the provider's current terms and quotas before relying on it.",
      };
    } catch (err) {
      throw new AppError(503, "catalog_unavailable", `The agent engine could not list providers: ${(err as Error).message}`);
    }
  });

  api.post("/providers/test", async (req) => {
    const user = requireUser(req);
    const row = getSettingsRow(db, user.id);
    if (!row?.provider_id || !row.model_id) throw new AppError(409, "provider_not_configured", "Save a provider and model first");
    let apiKey: string | undefined;
    if (row.api_key_ciphertext) {
      apiKey = decryptSecret(config.masterKey, row.api_key_ciphertext);
    }
    try {
      const result = await engine.testProviderConfiguration(row.provider_id, row.model_id, apiKey);
      audit(db, user.id, "provider.test", row.provider_id, { ok: result.ok });
      return { provider: row.provider_id, model: row.model_id, ...result, liveRequestMade: false };
    } catch (err) {
      throw new AppError(503, "engine_unavailable", (err as Error).message);
    }
  });
}
