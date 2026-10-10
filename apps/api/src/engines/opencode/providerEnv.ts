/**
 * Fallback API-key environment variable names, used only when the engine catalog does not report one.
 * The catalog returned by `GET /provider` is authoritative.
 */
const FALLBACK: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  deepinfra: "DEEPINFRA_API_KEY",
};

export function providerEnvFallback(providerId: string): string | undefined {
  return FALLBACK[providerId];
}
