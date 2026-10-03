// Portable `npm test`: expands the test files in Node instead of relying on the
// shell. PowerShell does not expand `test/*.test.js`, and Node only learned to
// do that itself in v21 — so on Windows + Node 18 the glob reached node verbatim
// and nothing ran at all.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join(dir, f));

if (!files.length) {
  console.error(`no *.test.js files in ${dir}`);
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
