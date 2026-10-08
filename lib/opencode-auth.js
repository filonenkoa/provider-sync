// Where OpenCode keeps provider credentials.
//
// OpenCode 1.x: a JSON file, ~/.local/share/opencode/auth.json, which we read
// and write ourselves.
//
// OpenCode 2.x: SQLite. Per its documentation, saved API keys and OAuth tokens
// live in the server's database, the path of which depends on the release
// channel, XDG_DATA_HOME and OPENCODE_DB — the supported way to learn it is
// `opencode debug paths db`. The legacy auth.json is imported once during the
// database migration and is never written back, so writing it on a 2.x machine
// would silently do nothing, and reading it would report stale or missing keys.
//
// Two consequences shape this module:
//   * we never touch the database, because the docs ask callers to manage
//     credentials through `/connect` and the `auth` commands, not by editing it;
//   * entering an API key requires an interactive terminal, so provider-sync
//     cannot store one non-interactively and instead prints the exact command.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const RUN = { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] };

// documented default: $XDG_DATA_HOME (or ~/.local/share)/opencode/opencode.db
export function defaultDbPath(env = process.env) {
  if (env.OPENCODE_DB) return path.resolve(env.OPENCODE_DB);
  const data = env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
  return path.join(data, "opencode", "opencode.db");
}

// "db" (OpenCode 2.x, credentials in SQLite) or "json" (1.x auth.json).
//
// Deliberately filesystem-only: asking the CLI instead (`opencode debug paths db`
// is the documented way) makes OpenCode create its cache/config/data directories
// as a side effect, so a mere `list` would leave empty ~/.config/opencode behind
// on a machine that never had one. A database in the data directory is the
// signal; OPENCODE_DB and other release channels are covered by the fallbacks.
export function detectBackend({ env = process.env } = {}) {
  if (env.OPENCODE_DB) return { mode: "db", dbPath: path.resolve(env.OPENCODE_DB), via: "OPENCODE_DB" };
  const dbPath = defaultDbPath(env);
  if (existsSync(dbPath)) return { mode: "db", dbPath, via: "database at the documented default" };
  // another release channel may use a different file name; any *.db means 2.x
  const dir = path.dirname(dbPath);
  try {
    const dbs = readdirSync(dir).filter((f) => f.endsWith(".db"));
    if (dbs.length) {
      const newest = dbs.map((f) => path.join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
      return { mode: "db", dbPath: newest, via: "a *.db file in the data directory" };
    }
  } catch {}
  return { mode: "json", dbPath: null, via: "legacy auth.json" };
}

// accepts what `opencode auth list --format json` may return: a bare array, a
// map keyed by provider id, or either of those wrapped in an object
export function parseCredentialList(text) {
  const out = {};
  const put = (id, type) => { if (id) out[String(id)] = String(type || "unknown"); };
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.credentials) ? data.credentials
    : Array.isArray(data?.providers) ? data.providers
    : null;
  if (rows) {
    for (const r of rows) if (r && typeof r === "object")
      put(r.id ?? r.provider ?? r.providerID ?? r.name, r.type ?? r.kind ?? r.method);
    return out;
  }
  if (data && typeof data === "object") {
    for (const [id, v] of Object.entries(data))
      put(id, v && typeof v === "object" ? v.type ?? v.kind ?? v.method : v);
  }
  return out;
}

// which providers have credentials, per OpenCode itself. Values are secrets and
// are never exposed by this call — presence is all we can (and should) learn.
export function listCredentials({ env = process.env, run = spawnSync } = {}) {
  const res = run("opencode", ["auth", "list", "--format", "json"], RUN);
  if (!res || res.status !== 0) return null;
  const parsed = parseCredentialList(String(res.stdout || ""));
  return parsed && Object.keys(parsed).length ? parsed : {};
}

// the only supported way to store a key on 2.x, spelled out for the user
export const loginCommand = (id) => `opencode auth login ${id} --method key`;