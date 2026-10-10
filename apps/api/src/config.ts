import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..", "..");

const Env = z.object({
  NEXUS_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXUS_HOST: z.string().default("127.0.0.1"),
  NEXUS_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  NEXUS_PUBLIC_ORIGIN: z.string().url().default("http://localhost:8787"),
  NEXUS_DATA_DIR: z.string().default("./data"),
  NEXUS_ENCRYPTION_KEY: z.string().optional(),
  NEXUS_ALLOW_REGISTRATION: z.enum(["true", "false"]).default("true"),
  NEXUS_OPENCODE_BIN: z.string().optional(),
  NEXUS_MAX_ENGINES: z.coerce.number().int().min(1).max(16).default(2),
  NEXUS_ENGINE_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  NEXUS_SANDBOX_MODE: z.enum(["namespace", "disabled"]).default("namespace"),
  NEXUS_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  NEXUS_JOB_MEMORY_MB: z.coerce.number().int().min(256).max(65536).default(4096),
  NEXUS_QUOTA_AGENT_MESSAGES_PER_DAY: z.coerce.number().int().min(0).default(200),
  NEXUS_QUOTA_COMMANDS_PER_DAY: z.coerce.number().int().min(0).default(500),
  NEXUS_GITHUB_CLIENT_ID: z.string().optional(),
  NEXUS_GITHUB_CLIENT_SECRET: z.string().optional(),
});

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  publicOrigin: string;
  dataDir: string;
  dbPath: string;
  workspacesDir: string;
  enginesDir: string;
  artifactsDir: string;
  masterKey: Buffer;
  allowRegistration: boolean;
  opencodeBin: string;
  maxEngines: number;
  engineIdleMs: number;
  sandboxMode: "namespace" | "disabled";
  jobTimeoutMs: number;
  jobMemoryMb: number;
  quotas: { agentMessagesPerDay: number; commandsPerDay: number };
  github: { clientId?: string; clientSecret?: string };
  webDistDir: string;
  isProduction: boolean;
}

function loadMasterKey(dataDir: string, env: string, provided?: string): Buffer {
  if (provided) {
    const key = Buffer.from(provided, "base64");
    if (key.length !== 32) throw new Error("NEXUS_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  if (env === "production") {
    throw new Error("NEXUS_ENCRYPTION_KEY is required in production");
  }
  const keyFile = join(dataDir, ".secret-key");
  if (existsSync(keyFile)) {
    const key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${keyFile} does not contain a 32-byte key`);
    return key;
  }
  // Development convenience: generate a key once and keep it readable only by the owner.
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString("base64") + "\n", { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return key;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const dataDir = resolve(REPO_ROOT, e.NEXUS_DATA_DIR);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const sub of ["workspaces", "engines", "artifacts"]) mkdirSync(join(dataDir, sub), { recursive: true, mode: 0o700 });

  const opencodeBin =
    e.NEXUS_OPENCODE_BIN && e.NEXUS_OPENCODE_BIN.length > 0
      ? e.NEXUS_OPENCODE_BIN
      : resolve(REPO_ROOT, "node_modules", ".bin", "opencode");

  const isProduction = e.NEXUS_ENV === "production";
  if (isProduction && e.NEXUS_PUBLIC_ORIGIN.startsWith("http://")) {
    throw new Error("NEXUS_PUBLIC_ORIGIN must use https in production");
  }
  return {
    env: e.NEXUS_ENV,
    host: e.NEXUS_HOST,
    port: e.NEXUS_PORT,
    publicOrigin: e.NEXUS_PUBLIC_ORIGIN.replace(/\/$/, ""),
    dataDir,
    dbPath: join(dataDir, "nexus.db"),
    workspacesDir: join(dataDir, "workspaces"),
    enginesDir: join(dataDir, "engines"),
    artifactsDir: join(dataDir, "artifacts"),
    masterKey: loadMasterKey(dataDir, e.NEXUS_ENV, e.NEXUS_ENCRYPTION_KEY),
    allowRegistration: e.NEXUS_ALLOW_REGISTRATION === "true",
    opencodeBin,
    maxEngines: e.NEXUS_MAX_ENGINES,
    engineIdleMs: e.NEXUS_ENGINE_IDLE_MINUTES * 60_000,
    sandboxMode: e.NEXUS_SANDBOX_MODE,
    jobTimeoutMs: e.NEXUS_JOB_TIMEOUT_SECONDS * 1000,
    jobMemoryMb: e.NEXUS_JOB_MEMORY_MB,
    quotas: {
      agentMessagesPerDay: e.NEXUS_QUOTA_AGENT_MESSAGES_PER_DAY,
      commandsPerDay: e.NEXUS_QUOTA_COMMANDS_PER_DAY,
    },
    github: { clientId: e.NEXUS_GITHUB_CLIENT_ID || undefined, clientSecret: e.NEXUS_GITHUB_CLIENT_SECRET || undefined },
    webDistDir: resolve(REPO_ROOT, "apps", "web", "dist"),
    isProduction,
  };
}
