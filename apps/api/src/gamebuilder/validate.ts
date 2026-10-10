import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Static validator for Godot 4 text projects. It does NOT run Godot. It checks what can be checked
 * without the engine: project.godot entries, scene ext_resource/sub_resource references, node paths
 * used by scripts against the scene that owns them, res:// references, GDScript indentation and
 * bracket balance, and PNG/WAV file headers. Runtime behaviour still requires a headless Godot run.
 */
export interface GodotValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  checked: { scenes: number; scripts: number; resources: number; references: number; nodePaths: number };
  limitations: string[];
}

const LIMITATIONS = [
  "Static checks only: Godot was not executed, so runtime errors, physics feel and visuals are not verified.",
  "GDScript is checked for balanced brackets, indentation style and resource references, not full type correctness.",
];

export function validateGodotProject(root: string): GodotValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts = { scenes: 0, scripts: 0, resources: 0, references: 0, nodePaths: 0 };
  const files = listFiles(root);
  const rel = (abs: string) => relative(root, abs).split(sep).join("/");
  const exists = (resPath: string) => existsSync(join(root, resPath.replace(/^res:\/\//, "")));

  const projectFile = join(root, "project.godot");
  if (!existsSync(projectFile)) {
    errors.push("project.godot is missing");
    return { ok: false, errors, warnings, checked: counts, limitations: LIMITATIONS };
  }
  const project = readFileSync(projectFile, "utf8");
  if (!/^config_version=\d+/m.test(project)) errors.push("project.godot: config_version is missing");
  const main = /^run\/main_scene="([^"]+)"/m.exec(project)?.[1];
  if (!main) errors.push("project.godot: run/main_scene is not set");
  else if (!exists(main)) errors.push(`project.godot: main scene ${main} does not exist`);
  for (const m of project.matchAll(/^[A-Za-z_]+="\*?(res:\/\/[^"]+)"/gm)) {
    if (!exists(m[1]!)) errors.push(`project.godot: referenced resource ${m[1]} does not exist`);
  }

  // Scenes: collect node paths and script links.
  const scriptScenes = new Map<string, Set<string>>(); // script res path -> node paths in owning scenes
  for (const abs of files.filter((f) => f.endsWith(".tscn"))) {
    counts.scenes++;
    const text = readFileSync(abs, "utf8");
    const label = rel(abs);
    const extIds = new Map<string, string>();
    const subIds = new Set<string>();
    for (const m of text.matchAll(/^\[ext_resource[^\]]*?type="([^"]+)"[^\]]*?path="([^"]+)"[^\]]*?id="([^"]+)"/gm)) {
      extIds.set(m[3]!, m[2]!);
      counts.resources++;
      if (!exists(m[2]!)) errors.push(`${label}: ext_resource ${m[2]} does not exist`);
    }
    for (const m of text.matchAll(/^\[ext_resource[^\]]*?path="([^"]+)"[^\]]*?id="([^"]+)"/gm)) {
      if (!extIds.has(m[2]!)) extIds.set(m[2]!, m[1]!);
    }
    for (const m of text.matchAll(/^\[sub_resource[^\]]*?id="([^"]+)"/gm)) subIds.add(m[1]!);
    for (const m of text.matchAll(/ExtResource\("([^"]+)"\)/g)) {
      counts.references++;
      if (!extIds.has(m[1]!)) errors.push(`${label}: ExtResource("${m[1]}") is not declared`);
    }
    for (const m of text.matchAll(/SubResource\("([^"]+)"\)/g)) {
      counts.references++;
      if (!subIds.has(m[1]!)) errors.push(`${label}: SubResource("${m[1]}") is not declared`);
    }
    const nodes: Array<{ name: string; parent?: string; script?: string; full: string }> = [];
    const blocks = text.split(/^(?=\[node )/m).filter((b) => b.startsWith("[node "));
    for (const block of blocks) {
      const head = /^\[node name="([^"]+)"(?: type="[^"]+")?(?: parent="([^"]*)")?/.exec(block);
      if (!head) continue;
      const scriptRef = /^script = ExtResource\("([^"]+)"\)/m.exec(block)?.[1];
      const parentPath = head[2] === undefined ? undefined : head[2] === "." ? "" : head[2];
      const full = parentPath === undefined ? "." : parentPath ? `${parentPath}/${head[1]}` : head[1]!;
      nodes.push({ name: head[1]!, parent: head[2], script: scriptRef ? extIds.get(scriptRef) : undefined, full });
    }
    const paths = new Set<string>();
    if (!nodes.some((n) => n.parent === undefined)) errors.push(`${label}: scene has no root node`);
    for (const n of nodes) {
      if (n.parent === undefined) {
        paths.add(".");
        continue;
      }
      const parentPath = n.parent === "." ? "" : n.parent;
      if (n.parent !== "." && !paths.has(parentPath)) {
        errors.push(`${label}: node ${n.name} has missing parent "${n.parent}"`);
      }
      const full = parentPath ? `${parentPath}/${n.name}` : n.name;
      paths.add(full);
    }
    counts.nodePaths += paths.size;
    for (const n of nodes) {
      if (!n.script) continue;
      if (!exists(n.script)) errors.push(`${label}: attached script ${n.script} does not exist`);
      // $Paths in a script resolve relative to the node it is attached to: its descendants only.
      const set = scriptScenes.get(n.script) ?? new Set<string>();
      for (const p of paths) {
        if (n.full === ".") set.add(p === "." ? "." : p);
        else if (p === n.full) set.add(".");
        else if (p.startsWith(`${n.full}/`)) set.add(p.slice(n.full.length + 1));
      }
      scriptScenes.set(n.script, set);
    }
  }

  // Scripts.
  for (const abs of files.filter((f) => f.endsWith(".gd"))) {
    counts.scripts++;
    const label = rel(abs);
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    if (!/^(extends|class_name|@tool)/m.test(text)) warnings.push(`${label}: no extends declaration`);
    let tabLines = 0;
    let spaceLines = 0;
    lines.forEach((line, i) => {
      const indent = /^[\t ]*/.exec(line)?.[0] ?? "";
      if (indent.includes("\t")) tabLines++;
      if (/^ +\S/.test(line) && !/^ +\*/.test(line)) spaceLines++;
      if (/\t/.test(indent) && / /.test(indent)) errors.push(`${label}:${i + 1}: mixed tabs and spaces in indentation`);
    });
    if (tabLines > 0 && spaceLines > 0) errors.push(`${label}: indentation mixes tabs and spaces`);
    const balance = checkBalance(text);
    if (balance) errors.push(`${label}: ${balance}`);
    for (const m of text.matchAll(/(?:preload|load)\("(res:\/\/[^"]+)"\)/g)) {
      counts.references++;
      if (!exists(m[1]!)) errors.push(`${label}: ${m[0]} references a missing file`);
    }
    // $NodePath references must exist in the scene(s) that own this script.
    const owners = scriptScenes.get(`res://${rel(abs)}`);
    const used = new Set<string>();
    for (const m of text.matchAll(/\$"?([A-Za-z0-9_/]+)"?/g)) used.add(m[1]!);
    if (owners) {
      for (const p of used) {
        counts.references++;
        if (!owners.has(p)) errors.push(`${label}: $${p} is not a node in the scene(s) that use this script`);
      }
    } else if (used.size > 0) {
      warnings.push(`${label}: script is not attached to any scene; $ node references were not checked`);
    }
  }

  // Binary assets.
  for (const abs of files) {
    const r = rel(abs);
    if (r.endsWith(".png")) {
      const head = readFileSync(abs).subarray(0, 8);
      if (!head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) errors.push(`${r}: invalid PNG signature`);
      counts.resources++;
    } else if (r.endsWith(".wav")) {
      const buf = readFileSync(abs).subarray(0, 12);
      if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") errors.push(`${r}: invalid WAV header`);
      counts.resources++;
    } else if (r.endsWith(".import")) {
      warnings.push(`${r}: generated import file present`);
    }
    if (statSync(abs).size === 0) errors.push(`${r}: file is empty`);
  }

  return { ok: errors.length === 0, errors, warnings, checked: counts, limitations: LIMITATIONS };
}

/** Balanced (), [] and {} outside strings and comments. Returns a message on the first imbalance. */
export function checkBalance(source: string): string | undefined {
  const stack: Array<{ ch: string; line: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      if (triple) {
        const end = source.indexOf(c.repeat(3), i + 3);
        if (end === -1) return `unterminated multi-line string starting on line ${line}`;
        line += (source.slice(i, end).match(/\n/g) ?? []).length;
        i = end + 3;
        continue;
      }
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") {
        if (source[j] === "\\") j++;
        j++;
      }
      if (source[j] !== c) return `unterminated string on line ${line}`;
      i = j + 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push({ ch: c, line });
    else if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top || top.ch !== pairs[c]) return `unbalanced "${c}" on line ${line}`;
    }
    i++;
  }
  if (stack.length > 0) return `unclosed "${stack[stack.length - 1]!.ch}" from line ${stack[stack.length - 1]!.line}`;
  return undefined;
}

function listFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === ".godot" || name === "node_modules") continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) listFiles(root, abs, out);
    else out.push(abs);
  }
  return out;
}
