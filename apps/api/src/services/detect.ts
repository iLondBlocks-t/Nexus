import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectDetection {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  scripts: Record<string, string>;
  testCommands: string[];
  buildCommands: string[];
  hasTests: boolean;
  notes: string[];
}

/** Read-only detection of language, framework and conventions. Never executes project code. */
export function detectProject(root: string): ProjectDetection {
  const d: ProjectDetection = { languages: [], frameworks: [], packageManager: null, scripts: {}, testCommands: [], buildCommands: [], hasTests: false, notes: [] };
  const has = (f: string) => existsSync(join(root, f));
  if (has("package.json")) {
    d.languages.push("JavaScript/TypeScript");
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      d.scripts = pkg.scripts ?? {};
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dep, label] of [["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["vite", "Vite"], ["express", "Express"], ["fastify", "Fastify"], ["@angular/core", "Angular"]] as const) {
        if (deps[dep]) d.frameworks.push(label);
      }
      if (d.scripts.test) d.testCommands.push("npm test");
      if (d.scripts.build) d.buildCommands.push("npm run build");
      if (d.scripts.lint) d.notes.push("npm run lint is available");
    } catch {
      d.notes.push("package.json could not be parsed");
    }
    d.packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("package-lock.json") ? "npm" : "npm (no lockfile)";
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    d.languages.push("Python");
    d.packageManager ??= has("pyproject.toml") ? "pyproject" : "pip";
    if (has("pytest.ini") || has("tests")) d.testCommands.push("python3 -m pytest");
  }
  if (has("go.mod")) {
    d.languages.push("Go");
    d.testCommands.push("go test ./...");
    d.buildCommands.push("go build ./...");
  }
  if (has("Cargo.toml")) {
    d.languages.push("Rust");
    d.testCommands.push("cargo test");
    d.buildCommands.push("cargo build");
  }
  if (has("project.godot")) {
    d.languages.push("GDScript");
    d.frameworks.push("Godot 4");
    d.notes.push("Godot projects are validated headless when the Godot binary is installed");
  }
  if (has("index.html")) d.frameworks.push("Static HTML");
  d.hasTests = d.testCommands.length > 0;
  if (!d.hasTests) d.notes.push("No test command was detected");
  return d;
}
