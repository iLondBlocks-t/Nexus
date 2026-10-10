/**
 * Typed API contracts shared by the NEXUS API and web client.
 * Every request body accepted by the API is validated with one of these schemas.
 */
import { z } from "zod";

export const ProjectKinds = ["blank", "web", "node", "godot-2d-arena", "github-import"] as const;
export type ProjectKind = (typeof ProjectKinds)[number];

export const ProviderIds = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i);

export const RegisterInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(256),
  displayName: z.string().trim().min(1).max(80),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(""),
  kind: z.enum(["blank", "web", "node", "godot-2d-arena"]).default("blank"),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const ImportGithubInput = z.object({
  repoUrl: z
    .string()
    .trim()
    .max(300)
    .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?\/?$/, "Use an https://github.com/<owner>/<repo> URL"),
  name: z.string().trim().min(1).max(80).optional(),
  branch: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._/-]+$/).optional(),
});
export type ImportGithubInput = z.infer<typeof ImportGithubInput>;

export const WriteFileInput = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(1_000_000),
});
export type WriteFileInput = z.infer<typeof WriteFileInput>;

export const RunCommandInput = z.object({
  command: z.string().trim().min(1).max(2000),
  network: z.boolean().default(false),
});
export type RunCommandInput = z.infer<typeof RunCommandInput>;

export const AgentMessageInput = z.object({
  text: z.string().trim().min(1).max(20_000),
  mode: z.enum(["plan", "build"]).default("build"),
  providerId: ProviderIds.optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
});
export type AgentMessageInput = z.infer<typeof AgentMessageInput>;

export const ApprovalDecisionInput = z.object({
  decision: z.enum(["approve", "deny"]),
  remember: z.boolean().default(false),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;

export const ProviderSettingsInput = z.object({
  providerId: ProviderIds,
  modelId: z.string().trim().min(1).max(200),
  // Write-only. Never returned by the API.
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().default(false),
  autoApproveEdits: z.boolean().default(false),
  language: z.enum(["en", "ar"]).default("en"),
  theme: z.enum(["midnight", "light"]).default("midnight"),
});
export type ProviderSettingsInput = z.infer<typeof ProviderSettingsInput>;

export const GithubRepoQuery = z.object({
  page: z.coerce.number().int().min(1).max(100).default(1),
});

export const SafeRelativePath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0"), "Invalid path");

/** Public API shapes (never contain secrets). */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
}

export interface PublicProject {
  id: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  githubRepo: string | null;
  githubBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export const CommandPolicyDecisions = ["allow", "approval", "deny"] as const;
export type CommandPolicyDecision = (typeof CommandPolicyDecisions)[number];

export const JobStatuses = [
  "awaiting_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "denied",
] as const;
export type JobStatus = (typeof JobStatuses)[number];
