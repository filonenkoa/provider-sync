// Shared test plumbing: running the CLI exactly the way a user would.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

// fileURLToPath, not URL.pathname: on Windows pathname yields "/D:/a/..." which
// node then resolves against the current drive into "D:\D:\a\..."
export const CLI = fileURLToPath(new URL("../bin/provider-sync.js", import.meta.url));

// The CLI resolves its paths from the environment exactly like OpenCode does, so
// a test has to pin every variable that can move them. HOME alone is not enough:
// CI runners export XDG_CONFIG_HOME, which wins over HOME and would point the
// tests at the runner's real config directory.
export function hermeticEnv(home, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ["OPENCODE_CONFIG_DIR", "PS_CONFIG", "OCP_CONFIG"]) delete env[k];
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  return env;
}

// for tests that import the module in-process instead of spawning it
export function pinHomeForImport(home) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.PS_CONFIG;
  delete process.env.OCP_CONFIG;
}

export const runCli = (home, args = [], opts = {}) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: hermeticEnv(home), ...opts });

export const runCliAsync = promisify(execFile);
export const runCliAsyncP = (home, args = [], extraEnv = {}) =>
  runCliAsync(process.execPath, [CLI, ...args], { env: hermeticEnv(home, extraEnv) }).then((r) => r.stdout);

// column widths are a formatting choice, not part of any contract
export const flat = (s) => s.replace(/[ \t]+/g, " ");

// a path printed by the CLI, with either separator
export const pathRe = (s) => s.replace(/[/\\]/g, "[\\\\/]");
