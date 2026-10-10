import type { CommandPolicyDecision } from "@nexus/shared";

/**
 * Command policy. This is a guard-rail layer, NOT the security boundary: the sandbox (namespaces,
 * network cut-off, timeouts) is what contains a command. The policy decides whether a command runs
 * automatically, needs explicit user approval, or is refused outright.
 */
export interface PolicyVerdict {
  decision: CommandPolicyDecision;
  reason: string;
}

const DENY: Array<[RegExp, string]> = [
  [/(^|[;&|`(]\s*)sudo\b/, "privilege escalation is not permitted"],
  [/(^|[;&|`(]\s*)(su|doas|pkexec|chroot|mount|umount|nsenter|unshare)\b/, "privilege or namespace control is not permitted"],
  [/\b(docker|podman|kubectl|ctr|nerdctl)\b/, "container runtimes are not available to projects"],
  [/docker\.sock|\/var\/run\/|\/proc\/\d*\/|\/etc\/(shadow|passwd)|(^|[\s'"=:])(\/root|~root)(\/|\s|$|['"])/, "access to host system paths is not permitted"],
  [/\b(printenv|env)\s*($|[|;&>])/, "dumping the environment is not permitted"],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\.\.)(\s|$)/, "recursive deletion outside the workspace is not permitted"],
  [/\b(ssh|scp|sftp|nc|ncat|telnet)\b/, "raw network tools are not permitted"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bombs are not permitted"],
];

const NETWORK_OR_INSTALL: Array<[RegExp, string]> = [
  [/\b(curl|wget|git\s+(clone|fetch|pull|push|ls-remote))\b/, "network access requires approval"],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|create|exec|dlx|x)\b/, "dependency installation requires approval"],
  [/\bnpx\b/, "npx downloads packages and requires approval"],
  [/\b(pip|pip3|uv|poetry|apt|apt-get)\s+(install|add|update|upgrade)\b/, "dependency installation requires approval"],
  [/\bgh\b/, "external service access requires approval"],
];

/** Commands that run without an approval prompt. Everything else needs approval unless denied. */
const AUTO_ALLOWED_PROGRAMS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "grep", "find", "sort", "uniq", "diff", "cut", "tr",
  "mkdir", "touch", "cp", "mv", "rm", "sed", "awk", "test", "true", "false", "stat", "file", "tree",
  "node", "tsc", "vitest", "jest", "eslint", "python3", "python", "git", "make", "godot", "npm", "pnpm", "yarn",
]);

const DANGEROUS_GIT = /\bgit\s+(push|remote|config|credential|submodule)\b/;

export function evaluateCommand(command: string): PolicyVerdict {
  const cmd = command.trim();
  if (cmd.length === 0) return { decision: "deny", reason: "empty command" };
  for (const [re, reason] of DENY) if (re.test(cmd)) return { decision: "deny", reason };
  if (DANGEROUS_GIT.test(cmd)) return { decision: "approval", reason: "git remote and config operations require approval" };
  for (const [re, reason] of NETWORK_OR_INSTALL) if (re.test(cmd)) return { decision: "approval", reason };
  // npm/pnpm/yarn with run/test/build are fine; install-like verbs were caught above.
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const program = seg.replace(/^(\w+=\S+\s+)+/, "").split(/\s+/)[0] ?? "";
    const base = program.replace(/^.*\//, "");
    if (!AUTO_ALLOWED_PROGRAMS.has(base)) {
      return { decision: "approval", reason: `"${base}" is not in the automatic allowlist` };
    }
    if (base === "rm" && /(\s|^)-[a-zA-Z]*r/.test(seg)) {
      return { decision: "approval", reason: "recursive deletion requires approval" };
    }
  }
  return { decision: "allow", reason: "matches the automatic command allowlist" };
}
