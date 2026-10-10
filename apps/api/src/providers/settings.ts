import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { AppError } from "../errors.js";
import { decryptSecret } from "../security/crypto.js";

export interface ResolvedProvider {
  providerId: string;
  modelId: string;
  apiKey?: string;
  autoApproveEdits: boolean;
  language: "en" | "ar";
  theme: "midnight" | "light";
}

interface SettingsRow {
  provider_id: string | null;
  model_id: string | null;
  api_key_ciphertext: string | null;
  auto_approve_edits: number;
  language: string;
  theme: string;
}

export function getSettingsRow(db: Db, userId: string): SettingsRow | undefined {
  return db
    .prepare("SELECT provider_id, model_id, api_key_ciphertext, auto_approve_edits, language, theme FROM user_settings WHERE user_id = ?")
    .get(userId) as SettingsRow | undefined;
}

/**
 * Resolves the user's configured provider for an engine call. Decryption happens here, server-side,
 * and the result must never be returned to the browser.
 */
export function resolveProvider(config: Config, db: Db, userId: string, modelOverride?: string): ResolvedProvider {
  const row = getSettingsRow(db, userId);
  if (!row?.provider_id || !row.model_id) {
    throw new AppError(409, "provider_not_configured", "Choose a model provider and model in Settings before asking the agent");
  }
  let apiKey: string | undefined;
  if (row.api_key_ciphertext) {
    try {
      apiKey = decryptSecret(config.masterKey, row.api_key_ciphertext);
    } catch {
      throw new AppError(500, "secret_unreadable", "The saved API key cannot be decrypted. Enter it again in Settings.");
    }
  }
  return {
    providerId: row.provider_id,
    modelId: modelOverride ?? row.model_id,
    apiKey,
    autoApproveEdits: row.auto_approve_edits === 1,
    language: row.language === "ar" ? "ar" : "en",
    theme: row.theme === "light" ? "light" : "midnight",
  };
}

export function publicSettings(row: SettingsRow | undefined) {
  return {
    providerId: row?.provider_id ?? null,
    modelId: row?.model_id ?? null,
    hasApiKey: Boolean(row?.api_key_ciphertext),
    autoApproveEdits: row?.auto_approve_edits === 1,
    language: row?.language === "ar" ? "ar" : "en",
    theme: row?.theme === "light" ? "light" : "midnight",
    providerConfigured: Boolean(row?.provider_id && row?.model_id),
  };
}
