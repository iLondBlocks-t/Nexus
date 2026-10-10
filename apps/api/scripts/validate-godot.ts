import { validateGodotProject } from "../src/gamebuilder/validate.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run validate:godot -w @nexus/api -- <project-dir>");
  process.exit(2);
}
const report = validateGodotProject(dir);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
