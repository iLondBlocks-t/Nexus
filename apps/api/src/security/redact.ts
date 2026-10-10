/** Removes credential-shaped values from strings before they are logged, stored in events, or shown to users. */
const PATTERNS: Array<[RegExp, string]> = [
  [/(authorization:\s*(?:basic|bearer|token)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(x-access-token:)[^@\s"']+/gi, "$1[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]"],
  [/("(?:apiKey|api_key|token|secret|password|access|refresh|clientSecret|accessToken)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2"],
  [/\b((?:[A-Z0-9]+_)*(?:API_KEY|TOKEN|SECRET|PASSWORD)=)\S+/g, "$1[REDACTED]"],
];

export function redact(input: string, extraSecrets: string[] = []): string {
  let out = input;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
