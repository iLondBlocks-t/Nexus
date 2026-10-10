import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Lists regular files under root (posix relative paths), skipping excluded prefixes and symlinks. */
export function walkFiles(root: string, excludedPrefixes: string[], limit = 20_000): string[] {
  const out: string[] = [];
  const visit = (dirRel: string) => {
    for (const name of readdirSync(join(root, dirRel))) {
      const rel = dirRel ? `${dirRel}/${name}` : name;
      if (excludedPrefixes.some((p) => `${rel}/`.startsWith(p) || rel === p.replace(/\/$/, ""))) continue;
      const st = lstatSync(join(root, rel));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(rel);
      else if (st.isFile()) {
        out.push(rel);
        if (out.length > limit) throw new Error("too many files");
      }
    }
  };
  visit("");
  return out;
}
