#!/usr/bin/env node
// provider-sync — manage local model providers for OpenCode and Hermes Agent.
// Zero dependencies, Node >= 18. Run `provider-sync help` for full documentation.

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

// config file resolution mirrors OpenCode's own discovery (config.ts):
// PS_CONFIG override (legacy: OCP_CONFIG) > first existing of opencode.jsonc / opencode.json /
// config.json in $OPENCODE_CONFIG_DIR or $XDG_CONFIG_HOME/opencode (~/.config/opencode)
const CFG_DIR = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");
const CFG_CANDIDATES = ["opencode.jsonc", "opencode.json", "config.json"];
function detectCfg() {
  const hit = CFG_CANDIDATES.find((f) => existsSync(path.join(CFG_DIR, f)));
  return path.join(CFG_DIR, hit || CFG_CANDIDATES[0]);
}
const CFG_ENV = process.env.PS_CONFIG || process.env.OCP_CONFIG || null;
const CFG = CFG_ENV || detectCfg();
const AUTH = path.join(os.homedir(), ".local/share/opencode/auth.json");
const HERMES_CFG = path.join(os.homedir(), ".hermes/config.yaml");
const HERMES_ENV = path.join(os.homedir(), ".hermes/.env");

// ---------- cli ----------
const die = (m) => { console.error("error: " + m); process.exit(1); };
// parses ["--k","v"] and ["--k=v"]; boolean flags are the known no-value ones
const BOOL_FLAGS = new Set(["apply", "dry-run", "no-hermes", "help", "h"]);
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    if (BOOL_FLAGS.has(k)) { flags[k] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) die(`--${k} needs a value`);
    flags[k] = argv[++i];
  }
  return { flags, pos };
}
const { flags, pos } = parseArgs(process.argv.slice(2));
const cmd = pos[0];

// JSONC: strip // and /* */ comments plus trailing commas, both only outside
// string literals — one string-aware pass so a model id like "a, }" survives
export function parseJsonc(raw) {
  let out = "", i = 0, hadComments = false;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') { // copy the string literal verbatim, escapes included
      out += c; i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === "\\") { out += raw.slice(i, i + 2); i += 2; }
        else { out += raw[i]; i++; }
      }
      if (i < raw.length) { out += raw[i]; i++; }
      continue;
    }
    if (c === "/" && raw[i + 1] === "/") {
      hadComments = true;
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      hadComments = true;
      const end = raw.indexOf("*/", i + 2);
      i = end === -1 ? raw.length : end + 2;
      continue;
    }
    if (c === ",") { // a comma directly before a closer is not part of the data
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (raw[j] === "}" || raw[j] === "]") { i++; continue; }
    }
    out += c; i++;
  }
  return { text: out, hadComments };
}

// ---------- store ----------
let _cfgWarned = false;
function warnMultiCfg() {
  if (_cfgWarned || CFG_ENV) return;
  _cfgWarned = true;
  const present = CFG_CANDIDATES.filter((f) => existsSync(path.join(CFG_DIR, f)));
  if (present.length > 1) console.error(`note: multiple config files in ${CFG_DIR} (${present.join(", ")}); OpenCode deep-merges them — provider-sync edits ${path.basename(CFG)}`);
}
let _cfgHadComments = false, _cmtWarned = false;
export const loadCfg = () => {
  if (!existsSync(CFG)) die(`no ${CFG}\nadd a provider first: provider-sync add <id> <baseURL>`);
  warnMultiCfg();
  const { text, hadComments } = parseJsonc(readFileSync(CFG, "utf8"));
  _cfgHadComments = hadComments;
  try {
    const p = JSON.parse(text);
    if (!p.provider) p.provider = {}; // fresh configs have no provider section
    return p;
  }
  catch (e) { die(`cannot parse ${CFG}: ${e.message}`); }
};
export const loadAuth = () => {
  if (!existsSync(AUTH)) return {};
  let a;
  try { a = JSON.parse(readFileSync(AUTH, "utf8")); }
  catch (e) { die(`cannot parse ${AUTH}: ${e.message}\nfix or remove the file, then retry`); }
  if (!a || typeof a !== "object" || Array.isArray(a)) die(`${AUTH} must contain a JSON object of provider keys`);
  return a;
};
// same, but an absent config is a fresh install rather than an error (add bootstraps it)
const loadCfgOrEmpty = () => (existsSync(CFG) ? loadCfg() : { provider: {} });

// atomic write: backup (keep last 3), tmp file in the same dir, rename over target
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
// drop all but the newest `keep` backups of `file`; legacy .bak-ocp- files included
function pruneBackups(file, keep = 3) {
  const dir = path.dirname(file);
  const prefixes = [path.basename(file) + ".bak-provider-sync-", path.basename(file) + ".bak-ocp-"];
  const baks = readdirSync(dir).filter((f) => prefixes.some((p) => f.startsWith(p))).sort();
  for (const f of baks.slice(0, -keep)) unlinkSync(path.join(dir, f));
}
function saveJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    copyFileSync(file, file + ".bak-provider-sync-" + stamp());
    try { pruneBackups(file); } catch {}
  }
  const tmp = file + ".tmp-provider-sync";
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, file);
}
const saveCfg = (c) => {
  if (_cfgHadComments && !_cmtWarned) { _cmtWarned = true; console.error("note: comments in the config file are not preserved by provider-sync writes"); }
  saveJson(CFG, c);
};
const saveAuth = (a) => saveJson(AUTH, a);

// numeric flag: undefined stays undefined, anything non-numeric is an error
const numFlag = (v) => {
  if (v === undefined) return undefined;
  if (v === true) die("numeric flag needs a value");
  const n = +v;
  if (!Number.isFinite(n)) die(`bad number "${v}"`);
  return n;
};

// ---------- help ----------
const HELP = `provider-sync — manage local model providers for OpenCode (and Hermes Agent)

Zero dependencies; requires Node >= 18 (built-in fetch).
Run \`provider-sync\`, \`provider-sync help\`, \`-h\` or \`--help\` to see this text again.

Files:
  config   $OPENCODE_CONFIG_DIR or ~/.config/opencode — first existing of
           opencode.jsonc, opencode.json, config.json (same discovery as
           OpenCode itself; override with PS_CONFIG=/path/to/file)
  keys     ~/.local/share/opencode/auth.json   API keys, one per provider id
  hermes   ~/.hermes/config.yaml               custom_providers (if installed)
           ~/.hermes/.env                      key source for Hermes providers

Commands:
  provider-sync list
      List configured providers with model counts and key status. Prints
      "not found" instead of failing when OpenCode is not installed.

  provider-sync add <id> <baseURL> [options]
      Register or update a provider. The server type is auto-detected:
      llama.cpp (preset --ctx-size + per-model architecture), LM Studio
      (/api/v0/models), Unsloth UI (login + persistent API key) or any
      OpenAI-compatible server.
      Upsert semantics: models missing on the server are removed, new ones
      added, server-authoritative ctx/modalities applied; configured values
      are kept when the server reports nothing. Re-running add against a
      moved server re-points baseURL and reconciles the model list.
      Key resolution: --key K > existing auth.json key for <id>. For an
      Unsloth UI with neither, pass --username U --password P: provider-sync logs in
      and creates (and stores) a persistent API key named after <id>.
      On a machine without an OpenCode config the file is created (first
      provider bootstraps it); --dry-run writes nothing.
      Reaches every installed harness: the same provider is also created or
      updated under custom_providers in ~/.hermes/config.yaml (matched by
      base URL, so re-running updates instead of duplicating). Whatever
      happens, the last lines report per target: what was written and what
      was skipped, with the reason.
      Options:
        --name N          display name (default: existing value, else <id>)
        --key K           API key; stored to auth.json under <id>, and
                          written into the hermes entry as a literal api_key
                          (dummy when the server needs no auth)
        --username U      Unsloth UI login (together with --password P)
        --password P
        --model M         model written into the hermes entry's model:
                          field (default: first model the server reports)
        --no-hermes       do not touch ~/.hermes/config.yaml
        --ctx N           ctx for models whose server reports none
                          (0 = omit the limit). Without it, provider-sync asks
                          interactively in a terminal; with --dry-run a
                          guess is shown instead.
        --output N        max output tokens written into new limits
                          (default 65536)
        --dry-run         report what would change; writes nothing and
                          creates no API key

  provider-sync sync [--apply] [--target all|opencode|hermes] [--provider ID]
      Check configured providers against their servers: new/removed models,
      ctx changes, modality corrections. Offline or auth-failing servers are
      reported and skipped; disabled_providers in the config are ignored.
      Without --apply nothing is written — the safe default for a status
      check (ctx of brand-new models is shown as a guess). With --apply in
      a terminal, provider-sync may ask interactively about ctx it cannot determine.
      Targets:
        opencode  providers in the OpenCode config file (default when --provider set)
        hermes    custom_providers in ~/.hermes/config.yaml — the offline
                  fallback catalog Hermes shows when a server is down. Only
                  server-reported context lengths are written; guesses never
                  go into Hermes. Model entries keep only context_length —
                  any other fields are dropped (with a warning).
        all       both (default)
      Harnesses are independent — a target whose config file is missing is
      reported as "not found — skipped" and the other one still runs, so
      hermes-only and opencode-only machines work. Asking for a target
      explicitly (--target opencode / --provider ID) without an OpenCode
      config is still an error.
      Options: --provider ID (opencode target only), --ctx N, --output N.

  provider-sync set-ctx <provider>
      Interactively re-ask the context window for every model whose server
      reports no ctx (models absent from the server are skipped). Enter =
      best known value (trained window from server metadata when available,
      else a heuristic on the model id), number = use it, k = keep current,
      0 = omit the limit. Use this to fix guessed or stale values. Needs a
      terminal. Options: --output N.

  provider-sync help
      Show this text (bare \`provider-sync\` prints it too and exits non-zero).

Context resolution, first match wins:
  1. server-reported: llama.cpp preset --ctx-size (else allocated n_ctx),
     LM Studio loaded/max context, Unsloth loaded context
  2. --ctx N flag (0 = omit the limit)
  3. interactive prompt in a terminal while writing (a guess is shown;
     Enter accepts it, 0 omits the limit)
  4. omitted with a warning (non-interactive write, no --ctx); in report
     mode a guess is displayed instead so you can see what apply would do
  Already-configured values are never clobbered — re-ask them with
  \`provider-sync set-ctx <provider>\`.

Modality resolution:
  - llama.cpp architecture.input_modalities is ground truth and corrects
    over/under-declared models (e.g. video stripped from text-only builds)
  - otherwise heuristics on the model id: qwen3.8 -> text+image+video,
    qwen/gemma -> text+image, else text; LM Studio VLMs -> text+image
  - embedding models are skipped entirely

New-model defaults (OpenCode only): attachment when input has more than
text; tool_call disabled for *base* model ids; reasoning enabled for
thinking-style ids (qwen3.5+, qwen4, muse-glimmer, *thinking*).

Hermes key resolution, first match wins:
  1. literal api_key in the entry (unless it is a placeholder like "dummy")
  2. \${ENV_VAR} in api_key or a key_env field — read from ~/.hermes/.env
  3. borrowed from auth.json of an opencode provider pointing at the same
     server URL (localhost and 127.0.0.1 count as the same host)

Safety:
  - every write is atomic (tmp file + rename) and preceded by a
    .bak-provider-sync-* backup; only the last 3 backups per file are kept
  - the config file is validated after each write; on errors they are
    reported and provider-sync exits non-zero

Examples:
  provider-sync add 3090-lan http://192.168.9.50:64980/v1 --key 4117...
  provider-sync add helen http://100.64.0.6:8888/v1 --username unsloth --password ***
  provider-sync add local http://127.0.0.1:8080/v1 --dry-run
  provider-sync sync                      # status check, opencode + hermes, nothing written
  provider-sync sync --apply              # apply all pending changes
  provider-sync sync --apply --provider 3090
  provider-sync sync --target hermes      # only the Hermes fallback catalogs
  provider-sync add new http://10.0.0.5:64980/v1 --key ... --ctx 32768
  provider-sync set-ctx 3090
`;

// ---------- http ----------
async function req(url, { method = "GET", key, body, timeout = 6000 } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, {
      method, signal: c.signal,
      headers: {
        ...(key ? { Authorization: "Bearer " + key } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : e.cause?.code || e.message };
  } finally { clearTimeout(t); }
}
const rootOf = (b) => b.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
const v1Of = (b) => { b = b.replace(/\/+$/, ""); return /\/v1$/.test(b) ? b : b + "/v1"; };
const nz = (v) => (typeof v === "number" && v > 0 ? v : null);

// ---------- detection ----------
async function probe(base, key) {
  const root = rootOf(base);
  let r = await req(root + "/openapi.json");
  if (r.status === 200 && /unsloth/i.test(r.json?.info?.title || "")) return { kind: "unsloth", root };
  r = await req(root + "/api/v0/models");
  if (r.status === 200 && r.json) return { kind: "lmstudio", root };
  r = await req(v1Of(base) + "/models", { key });
  if (r.status === 200 && r.json) {
    const data = Array.isArray(r.json) ? r.json : Array.isArray(r.json.data) ? r.json.data : null;
    if (data) {
      const first = data[0] || {};
      return { kind: first.status?.args || first.preset || first.architecture ? "llamacpp" : "openai", root, models: data };
    }
  }
  if (r.status === 401) return { kind: "auth", root };
  return { kind: "offline", root, status: r.status, error: r.error || (r.status ? "HTTP " + r.status + " (not a known model server?)" : r.text?.slice(0, 80)) };
}

// ---------- model specs ----------
async function fetchModels(pr, base, key) {
  if (pr.kind === "llamacpp" || pr.kind === "openai") return pr.models.map(specAny);
  if (pr.kind === "lmstudio") {
    const r = await req(rootOf(base) + "/api/v0/models", { key });
    if (r.status !== 200) throw new Error("/api/v0/models HTTP " + r.status);
    const data = Array.isArray(r.json) ? r.json : r.json?.data || [];
    return data.filter((m) => m && m.id).map((m) => ({
      id: m.id,
      ctx: nz(m.loaded_context_length || m.max_context_length),
      input: m.type === "vlm" ? ["text", "image"] : null,
      skip: m.type === "embeddings",
    }));
  }
  if (pr.kind === "unsloth") {
    const r = await req(v1Of(base) + "/models", { key });
    if (r.status === 401) throw new Error("401: no valid API key in auth.json (provider-sync add <id> <url> --username U --password P)");
    if (r.status !== 200) throw new Error("/v1/models HTTP " + r.status);
    return (r.json?.data || []).map((m) => ({ id: m.id, ctx: nz(m.context_length), input: null }));
  }
  return [];
}
function specAny(m) {
  if (m.status?.args || m.architecture || m.meta) {
    const args = m.status?.args || [];
    const i = args.indexOf("--ctx-size");
    // meta is only present for currently loaded models: n_ctx = allocated,
    // n_ctx_train = native window from GGUF metadata (great guess source)
    const preset = i >= 0 ? parseInt(args[i + 1]) : NaN;
    return {
      id: m.id,
      ctx: Number.isFinite(preset) ? preset : nz(m.meta?.n_ctx),
      native: nz(m.meta?.n_ctx_train),
      input: m.architecture?.input_modalities || null,
    };
  }
  return { id: m.id, ctx: nz(m.context_length), input: null };
}

// ---------- heuristics (used only for NEW models) ----------
const MOD_BY_ID = (id) => /qwen3\.8/i.test(id) ? ["text", "image", "video"]
  : /qwen|gemma/i.test(id) ? ["text", "image"] : ["text"];
const TOOL_BY_ID = (id) => !/(^|[-/])base[-_]/i.test(id);
const REASON_BY_ID = (id) => /qwen3\.[5-9]|qwen4|muse.?glimmer|thinking/i.test(id);

// guess a context window from the model id (only used as prompt hint / report)
function guessCtx(id) {
  const k = id.match(/(^|[^A-Za-z0-9])(\d+)K/i);
  if (k) return parseInt(k[2]) * 1024;
  if (/1M/i.test(id)) return 1048576;
  if (/qwen3\.[5-9]/i.test(id)) return 262144;
  return 131072;
}
let _rl = null;
const ask = async (q) => {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await _rl.question(q); }
  catch { try { _rl.close(); } catch {} _rl = null; throw new Error("input ended"); }
};

// for every model the server reports no ctx for: --ctx flag, interactive
// prompt (mode "write" in a terminal), or guess (mode "report")
async function resolveCtxs(server, { ctxFlag, mode, notes, existing = [] }) {
  const have = new Set(existing);
  const map = {};
  for (const m of server) {
    if (m.ctx != null || m.skip) continue;
    if (have.has(m.id)) { map[m.id] = null; continue; } // already configured, keep its value
    if (ctxFlag !== undefined) { map[m.id] = ctxFlag === 0 ? null : ctxFlag; continue; }
    if (mode === "write" && process.stdin.isTTY) {
      const guess = m.native || guessCtx(m.id);
      let ans;
      try { ans = (await ask(`  ctx for ${m.id} — server reports none, guess ${guess} [Enter=guess / number / 0=omit limit]: `)).trim(); }
      catch { die("aborted (no more input) — nothing written"); }
      map[m.id] = ans === "" ? guess : ans === "0" ? null : /^\d+$/.test(ans) ? parseInt(ans) : guess;
    } else if (mode === "write") {
      map[m.id] = null;
      notes.push(`${m.id}: limit omitted — no server ctx and non-interactive (pass --ctx N or run in a terminal)`);
    } else {
      const g = m.native || guessCtx(m.id);
      map[m.id] = g;
      notes.push(`${m.id}: ctx ${g} is a ${m.native ? "trained-window estimate" : "guess"} (will prompt on apply)`);
    }
  }
  return map;
}

function freshEntry(id, m, { out, ctxMap }) {
  const inp = m.input || MOD_BY_ID(id);
  const c = m.ctx ?? ctxMap?.[id] ?? null;
  const e = { name: id };
  if (inp.length > 1) e.attachment = true;
  e.modalities = { input: inp, output: ["text"] };
  if (c != null) e.limit = { context: c, output: out };
  e.tool_call = TOOL_BY_ID(id);
  if (REASON_BY_ID(id)) e.reasoning = true;
  return e;
}
function upsertEntry(old, m, opts) {
  if (!old) return freshEntry(m.id, m, opts);
  const e = structuredClone(old);
  if (m.input) e.modalities = { input: m.input, output: e.modalities?.output || ["text"] };
  if (m.ctx != null) e.limit = { context: m.ctx, output: e.limit?.output || opts.out };
  return e;
}

// existing models object + server specs -> merged + diff
function reconcile(models, server, { out, ctxMap, notes }) {
  const res = { added: [], removed: [], ctx: [], mods: [] };
  const next = {};
  const seen = new Set();
  for (const m of server) {
    seen.add(m.id);
    if (m.skip) { if (models[m.id]) next[m.id] = models[m.id]; continue; }
    const old = models[m.id];
    next[m.id] = upsertEntry(old, m, { out, ctxMap, notes });
    if (!old) res.added.push(m.id);
    else {
      if (m.ctx != null && old.limit?.context !== m.ctx) res.ctx.push([m.id, old.limit?.context, m.ctx]);
      if (m.input && JSON.stringify(old.modalities?.input || []) !== JSON.stringify(m.input))
        res.mods.push([m.id, old.modalities?.input || [], m.input]);
    }
  }
  for (const id of Object.keys(models)) if (!seen.has(id)) { res.removed.push(id); delete next[id]; }
  return { models: next, ...res };
}

// ---------- hermes (~/.hermes/config.yaml, custom_providers) ----------
// Surgical line-based YAML edits: no full-file reparse/rewrite, comments and
// formatting of untouched sections are preserved. Only the per-provider
// `models:` block (a fallback catalog for offline use) is rewritten.
const normUrl = (b) => (b || "").replace(/\/v1\/?$/i, "").replace(/\/+$/, "").toLowerCase().replace("localhost", "127.0.0.1");

let _henv = null;
function hermesEnv() {
  if (_henv !== null) return _henv;
  _henv = {};
  if (existsSync(HERMES_ENV))
    for (const line of readFileSync(HERMES_ENV, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) _henv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  return _henv;
}

// unquote a YAML scalar; double-quoted strings are JSON (yq quotes via JSON.stringify)
const deq = (s) => {
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch {} }
  return s.replace(/^(['"])(.*)\1$/, "$2");
};

// quote a YAML scalar only when needed; JSON quoting is always valid YAML
const yq = (s) => (/^[A-Za-z0-9_.@-]/.test(s) && !/: /.test(s) && !/^\s|\s$/.test(s) && !s.includes("#") ? s : JSON.stringify(s));

// short paths in reports: ~/.config/... instead of /Users/x/.config/...
const disp = (p) => (typeof p === "string" && p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);

const ind = (n) => " ".repeat(n);
const indentOf = (l) => l.length - l.trimStart().length;

// hermes yaml: indentation is detected from the file instead of assumed, so
// configs written with a different indent (or by a Windows editor) still parse
function parseHermes(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^custom_providers:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const entries = [];
  let listInd = null;
  let dashes = 0; // list items we could not parse — appending next to them would corrupt the yaml
  let i = start + 1;
  while (i < lines.length) {
    const m = lines[i].match(/^( *)- +(.*)$/);
    if (!m) {
      if (lines[i].trim() === "") { i++; continue; }
      if (/^\S/.test(lines[i])) break;
      i++; continue;
    }
    const li = m[1].length;
    if (listInd === null) listInd = li;
    if (li > listInd) { i++; continue; } // a list nested inside the previous entry
    if (li < listInd) break; // the custom_providers list ended
    const nm = m[2].match(/^name:\s*(.*)$/);
    if (!nm) { dashes++; i++; continue; }
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > li)) j++;
    let e2 = j;
    while (e2 > i + 1 && lines[e2 - 1].trim() === "") e2--;
    let fi = null; // field indent = indent of the first field line (usually dash + 2)
    for (let k = i + 1; k < e2; k++)
      if (lines[k].trim() && indentOf(lines[k]) > li) { fi = indentOf(lines[k]); break; }
    if (fi === null) fi = li + 2;
    const entry = { idx: i, end: e2, name: deq(nm[1].trim()), listInd: li, fldInd: fi, mdlInd: fi + 2, ctxInd: fi + 4, base_url: null, api_key: null, key_env: null, model: null, modelsIdx: -1, blockEnd: -1, models: [], modelsDiscovered: false };
    const fld = (k) => new RegExp("^ {" + fi + "}" + k + ":\\s*(\\S.*?)\\s*$");
    for (let k = i + 1; k < e2; k++) {
      const l = lines[k];
      let f;
      if ((f = l.match(fld("base_url")))) entry.base_url = deq(f[1]);
      else if ((f = l.match(fld("api_key")))) entry.api_key = deq(f[1]);
      else if ((f = l.match(fld("key_env")))) entry.key_env = deq(f[1]);
      else if ((f = l.match(fld("model")))) entry.model = deq(f[1]);
      else if ((f = l.match(fld("models_discovered")))) entry.modelsDiscovered = /^(true|yes|1)$/i.test(f[1]);
      else if (new RegExp("^ {" + fi + "}models:\\s*$").test(l)) {
        entry.modelsIdx = k;
        let b = k + 1;
        while (b < e2 && (lines[b].trim() === "" || indentOf(lines[b]) > fi)) b++;
        entry.blockEnd = b;
        entry.models = parseModelsBlock(lines, k + 1, b, fi + 2, fi + 4);
      }
    }
    entries.push(entry);
    i = e2;
  }
  const li = listInd ?? 2;
  return { lines, entries, listInd: li, fldInd: entries[0]?.fldInd ?? li + 2, listEnd: i, unparsed: dashes, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function parseModelsBlock(lines, a, b, mdl, ctx) {
  const models = [];
  const keyRe = new RegExp("^ {" + mdl + "}(.+?):(?:\\s+(\\{.*\\}))?\\s*$");
  const ctxRe = new RegExp("^ {" + ctx + "}context_length:\\s*(\\d+)\\s*$");
  let i = a;
  while (i < b) {
    const l = lines[i];
    if (l.trim() === "") { i++; continue; }
    const m = l.match(keyRe);
    if (!m) { i++; continue; }
    const id = deq(m[1]);
    let ctxv = null, extra = false; // extra: fields provider-sync does not preserve (only context_length is kept)
    if (m[2]) {
      const ic = m[2].match(/context_length:\s*(\d+)/);
      if (ic) ctxv = parseInt(ic[1]);
      const rest = m[2].replace(/^\{\s*|\s*\}$/g, "").replace(/"?context_length"?\s*:\s*\d+/g, "");
      if (rest.replace(/[,\s]/g, "") !== "") extra = true;
    } else {
      for (let k = i + 1; k < b; k++) {
        if (lines[k].trim() === "") continue;
        const c2 = lines[k].match(ctxRe);
        if (c2) { ctxv = parseInt(c2[1]); continue; }
        if (indentOf(lines[k]) <= mdl) break;
        extra = true;
      }
    }
    let e = i + 1;
    while (e < b && lines[e].trim() !== "" && indentOf(lines[e]) > mdl) e++;
    models.push({ id, ctx: ctxv, extra });
    i = e;
  }
  return models;
}

function renderModels(models, mdl = 6, ctx = 8) {
  const lines = [];
  for (const m of models)
    if (m.ctx != null) lines.push(`${ind(mdl)}${yq(m.id)}:`, `${ind(ctx)}context_length: ${m.ctx}`);
    else lines.push(`${ind(mdl)}${yq(m.id)}: {}`);
  return lines;
}

// key for a hermes custom provider: literal api_key / ${ENV} / key_env from
// ~/.hermes/.env, else borrow the opencode key of a provider on the same server
function hermesKey(e, ocCfg, ocAuth) {
  if (e.api_key && e.api_key !== "dummy") {
    if (e.api_key.startsWith("${") && e.api_key.endsWith("}")) return hermesEnv()[e.api_key.slice(2, -1)] || null;
    return e.api_key;
  }
  if (e.key_env) return hermesEnv()[e.key_env] || null;
  for (const [pid, p] of Object.entries(ocCfg.provider || {}))
    if (normUrl(p.options?.baseURL) === normUrl(e.base_url) && ocAuth[pid]?.key) return ocAuth[pid].key;
  return null;
}

// ---------- hermes writes (shared by sync and add) ----------
// first line index after an entry that is not part of it (next entry / top-level key)
function entryEnd(lines, idx, listInd) {
  for (let k = idx + 1; k < lines.length; k++) {
    if (lines[k].trim() === "") continue;
    if (indentOf(lines[k]) <= listInd) return k;
  }
  return lines.length;
}

// replace (or create) an entry's models region; index arithmetic stays valid because
// the marker line is consumed from the replaced region and re-emitted fresh
function hermesSetModels(lines, e, models) {
  const body = renderModels(models, e.mdlInd, e.ctxInd);
  const marker = `${ind(e.fldInd)}models_discovered: true`;
  const markerRe = new RegExp("^ {" + e.fldInd + "}models_discovered:");
  if (e.modelsIdx >= 0) {
    let end = e.blockEnd;
    for (let k = end; k < e.end; k++) {
      if (lines[k].trim() === "") continue;
      if (markerRe.test(lines[k])) { end = k + 1; break; }
      break;
    }
    lines.splice(e.modelsIdx + 1, end - e.modelsIdx - 1, ...body, marker);
  } else {
    let at = e.end, have = false;
    for (let k = e.idx + 1; k < e.end; k++)
      if (markerRe.test(lines[k])) { at = k; have = true; break; }
    lines.splice(at, 0, `${ind(e.fldInd)}models:`, ...body, ...(have ? [] : [marker]));
  }
  return lines;
}

// set (or insert) a scalar field of an entry; located by content so it stays
// correct after a models-region splice shifted the line numbers
function hermesSetField(lines, e, key, value) {
  const end = entryEnd(lines, e.idx, e.listInd);
  const re = new RegExp("^ {" + e.fldInd + "}" + key + ":");
  for (let k = e.idx + 1; k < end; k++)
    if (re.test(lines[k])) { lines[k] = `${ind(e.fldInd)}${key}: ${yq(value)}`; return; }
  let at = e.idx + 1;
  const baseRe = new RegExp("^ {" + e.fldInd + "}base_url:");
  for (let k = e.idx + 1; k < end; k++)
    if (baseRe.test(lines[k])) { at = k + 1; break; }
  lines.splice(at, 0, `${ind(e.fldInd)}${key}: ${yq(value)}`);
}

// atomic write with a rotating backup; returns the backup path
function writeHermesCfg(lines, eol = "\n") {
  copyFileSync(HERMES_CFG, HERMES_CFG + ".bak-provider-sync-" + stamp());
  try { pruneBackups(HERMES_CFG); } catch {}
  const tmp = HERMES_CFG + ".tmp-provider-sync";
  writeFileSync(tmp, lines.join(eol));
  renameSync(tmp, HERMES_CFG);
  return `config.yaml.bak-provider-sync-${stamp}`;
}

// create or update a custom_providers entry so `add` reaches every installed
// harness; matched by base URL, so re-running updates instead of duplicating
function hermesUpsert({ name, base, key, model, models, dryRun }) {
  if (!existsSync(HERMES_CFG)) return { status: "absent", why: `hermes not installed (${disp(HERMES_CFG)} not found)` };
  const h = parseHermes(readFileSync(HERMES_CFG, "utf8"));
  if (!h) return { status: "no-section", why: `no custom_providers section in ${disp(HERMES_CFG)}` };
  const n = models.length;
  const found = h.entries.find((e) => normUrl(e.base_url) === normUrl(base));
  if (found) {
    if (dryRun) return { status: "updated", name: found.name, n };
    const lines = h.lines.slice();
    hermesSetModels(lines, found, models);
    if (key && found.api_key !== key) hermesSetField(lines, found, "api_key", key);
    writeHermesCfg(lines, h.eol);
    return { status: "updated", name: found.name, n };
  }
  if (dryRun) return { status: "created", name, n };
  if (h.unparsed) return { status: "unparsed", why: `${h.unparsed} custom_providers item(s) not understood (unexpected layout) — refusing to append, update them by hand` };
  // yaml requires the fields of a list item exactly two columns right of its dash;
  // anything else means the file is hand-made and we must not guess its style
  if (h.entries.length && h.fldInd !== h.listInd + 2)
    return { status: "layout", why: `existing entries are indented unusually (dash ${h.listInd}, fields ${h.fldInd}) — refusing to append, update by hand` };
  const li = h.listInd, fi = li + 2;
  const block = [
    `${ind(li)}- name: ${yq(name)}`,
    `${ind(fi)}base_url: ${yq(base)}`,
    `${ind(fi)}api_key: ${key ? yq(key) : "dummy"}`,
    ...(model ? [`${ind(fi)}model: ${yq(model)}`] : []),
    `${ind(fi)}models:`,
    ...renderModels(models, fi + 2, fi + 4),
    `${ind(fi)}models_discovered: true`,
  ];
  const lines = h.lines.slice();
  let at = h.listEnd;
  while (at > 0 && lines[at - 1].trim() === "") at--;
  // separate the new entry from a following top-level key with one blank line
  const blank = at < lines.length && lines[at].trim() !== "" ? [""] : [];
  lines.splice(at, 0, ...block, ...blank);
  writeHermesCfg(lines, h.eol);
  return { status: "created", name, n };
}

async function syncHermes({ apply, ocCfg, ocAuth }) {
  if (!existsSync(HERMES_CFG)) { console.log(`hermes (${disp(HERMES_CFG)}): not found — skipped`); return { status: "absent", why: "not installed" }; }
  const text = readFileSync(HERMES_CFG, "utf8");
  const h = parseHermes(text);
  if (!h) { console.log(`hermes (${disp(HERMES_CFG)}): no custom_providers — skipped`); return { status: "no-section", why: "no custom_providers section" }; }
  if (!h.entries.length) { console.log(`hermes: custom_providers found but no entries parsed${h.unparsed ? ` (${h.unparsed} item(s) in an unexpected layout)` : " (unexpected indentation?)"} — skipped`); return { status: "empty", why: "no entries parsed" }; }
  console.log(`hermes (~/.hermes/config.yaml): ${h.entries.length} custom provider(s)`);
  // probe all providers in parallel, then report in config order
  const rs = await Promise.all(h.entries.map(async (e) => {
    if (!e.base_url) return { e, skip: "no base_url" };
    const key = hermesKey(e, ocCfg, ocAuth);
    const pr = await probe(e.base_url, key);
    if (pr.kind === "offline") return { e, offline: pr.error || "HTTP " + pr.status };
    if (pr.kind === "auth") return { e, badauth: true };
    try { return { e, kind: pr.kind, server: await fetchModels(pr, e.base_url, key) }; }
    catch (err) { return { e, err: err.message }; }
  }));
  const edits = [];
  let changes = 0;
  for (const r of rs) {
    if (r.skip) { console.log(`  ${r.e.name}: ${r.skip} — skipped`); continue; }
    if (r.offline) { console.log(`  ${r.e.name} (${r.e.base_url}): OFFLINE (${r.offline}) — skipped`); continue; }
    if (r.badauth) { console.log(`  ${r.e.name} (${r.e.base_url}): AUTH 401 — key missing or invalid`); continue; }
    if (r.err) { console.log(`  ${r.e.name} (${r.e.base_url}): ERROR — ${r.err}`); continue; }
    const e = r.e;
    const live = r.server.filter((m) => !m.skip).map((m) => ({ id: m.id, ctx: m.ctx ?? null }));
    const curIds = new Map(e.models.map((m) => [m.id, m]));
    const liveIds = new Set(live.map((m) => m.id));
    const added = live.filter((m) => !curIds.has(m.id));
    const removed = e.models.filter((m) => !liveIds.has(m.id));
    const ctxCh = live.filter((m) => { const c = curIds.get(m.id); return c && m.ctx != null && c.ctx !== m.ctx; });
    console.log(`  ${e.name} (${r.kind}, ${e.base_url}): ${live.length} on server, ${e.models.length} in config`);
    for (const a of added) console.log(`    + ${a.id}`);
    for (const a of removed) console.log(`    - ${a.id} (no longer on server)`);
    for (const c of ctxCh) console.log(`    ~ ctx ${c.id}: ${curIds.get(c.id).ctx} -> ${c.ctx}`);
    if (!added.length && !removed.length && !ctxCh.length) { console.log("    in sync"); continue; }
    for (const m of e.models.filter((m) => m.extra))
      console.log(`    note: ${m.id} has fields other than context_length — they will be dropped on --apply`);
    changes += added.length + removed.length + ctxCh.length;
    edits.push({ e, live });
  }
  if (!edits.length) return { status: "in-sync", n: h.entries.length };
  if (!apply) { console.log(`  ${changes} change(s) pending — re-run with --apply to write`); return { status: "pending", changes }; }
  // apply bottom-up so earlier line indices stay valid
  const lines = h.lines.slice();
  for (const ed of edits.sort((a, b) => b.e.idx - a.e.idx)) hermesSetModels(lines, ed.e, ed.live);
  console.log(`  APPLIED ${changes} change(s) — backup at ${writeHermesCfg(lines, h.eol)}`);
  return { status: "applied", changes, providers: edits.length };
}

// ---------- validation ----------
const MODS = new Set(["text", "image", "audio", "video", "pdf"]);
const MODEL_KEYS = new Set(["name", "attachment", "modalities", "limit", "tool_call", "reasoning", "options"]);
function validate(cfg) {
  const errs = [];
  for (const [pid, p] of Object.entries(cfg.provider || {})) {
    for (const k of Object.keys(p.models || {})) {
      const m = p.models[k];
      for (const key of Object.keys(m)) if (!MODEL_KEYS.has(key)) errs.push(`${pid}/${k}: unknown model key "${key}"`);
      if (m.limit && (!m.limit.context || !m.limit.output)) errs.push(`${pid}/${k}: limit needs context+output`);
      for (const side of ["input", "output"])
        for (const v of m.modalities?.[side] || []) if (!MODS.has(v)) errs.push(`${pid}/${k}: bad modality "${v}"`);
      if (m.modalities?.input && !m.modalities.input.includes("text")) errs.push(`${pid}/${k}: input must include "text"`);
    }
  }
  return errs;
}
function reportValidate(cfg) {
  const errs = validate(cfg);
  if (errs.length) { console.log("VALIDATION ERRORS:"); for (const e of errs) console.log("  " + e); process.exitCode = 1; }
  return errs.length === 0;
}

// interactively re-ask ctx for models the server doesn't report
async function cmdSetCtx(pid) {
  if (!process.stdin.isTTY) die("set-ctx needs an interactive terminal");
  const cfg = loadCfg();
  const p = cfg.provider[pid];
  if (!p) die(`unknown provider "${pid}" (see provider-sync list)`);
  const base = p.options?.baseURL;
  const key = loadAuth()[pid]?.key || null;
  const pr = await probe(base, key);
  if (pr.kind === "offline" || pr.kind === "auth") die(`cannot reach ${base}: ${pr.error || "HTTP " + pr.status}`);
  let server;
  try { server = await fetchModels(pr, base, key); } catch (e) { die(e.message); }
  const byId = Object.fromEntries(server.map((m) => [m.id, m]));
  const out = numFlag(flags.output) ?? 65536;
  let changed = 0;
  for (const [mid, m] of Object.entries(p.models || {})) {
    const spec = byId[mid];
    if (!spec) { console.log(`  ${mid}: not on server — skipped`); continue; }
    if (spec.ctx != null) continue; // server is authoritative, nothing to ask
    const cur = m.limit?.context || 0;
    const best = spec.native || guessCtx(mid);
    let ans;
    const prompt = cur && cur === best
      ? `  ${mid}: ctx = ${cur} [Enter=keep / number / 0=omit]: `
      : `  ${mid}: ctx ${cur ? `= ${cur}, ` : ""}best known ${best} [Enter=${best} / number / k=keep${cur ? ` ${cur}` : ""} / 0=omit]: `;
    try { ans = (await ask(prompt)).trim(); }
    catch { die("aborted (no more input) — nothing written"); }
    if (ans === "") {
      if (cur && cur === best) continue;
      m.limit = { context: best, output: m.limit?.output || out };
      changed++;
      continue;
    }
    if (ans === "0") { delete m.limit; changed++; }
    else if (ans === "k" || ans === "K") continue;
    else if (/^\d+$/.test(ans)) { m.limit = { context: parseInt(ans), output: m.limit?.output || out }; changed++; }
    else console.log(`  invalid "${ans}" — kept`);
  }
  if (changed) { saveCfg(cfg); reportValidate(cfg); console.log(`updated ${changed} ctx value(s)`); }
  else console.log("no changes");
}

// ---------- commands ----------
function cmdList() {
  if (!existsSync(CFG)) { console.log(`opencode (${CFG}): not found — no opencode providers`); return; }
  const cfg = loadCfg();
  const auth = loadAuth();
  for (const [id, p] of Object.entries(cfg.provider || {})) {
    const n = Object.keys(p.models || {}).length;
    console.log(`${id.padEnd(18)} ${String(n).padStart(3)} models  ${(p.options?.baseURL || "-")}  ${auth[id]?.key ? "key" : "no-key"}`);
  }
}

async function cmdAdd(id, url) {
  const base = v1Of(url);
  let key = flags.key || loadAuth()[id]?.key || null; // persisted key
  const pr = await probe(base, key);
  if (pr.kind === "offline") die(`cannot reach ${base}: ${pr.error || "HTTP " + pr.status}`);
  if (pr.kind === "auth") die(`${base} requires auth — pass --key K (or --username U --password P for Unsloth UI)`);
  let runKey = key; // credential used for this run's requests
  if (pr.kind === "unsloth" && !runKey && flags.username && flags.password) {
    const r = await req(pr.root + "/api/auth/login", { method: "POST", body: { username: flags.username, password: flags.password } });
    const tok = r.json?.access_token;
    if (!tok) die(`Unsloth login failed: HTTP ${r.status} ${r.text?.slice(0, 120)}`);
    runKey = tok; // a login token can read /v1/models without creating anything
    if (flags["dry-run"]) console.log("note: dry-run — using a temporary login token, no API key created");
    else {
      const k = await req(pr.root + "/api/auth/api-keys", { method: "POST", key: tok, body: { name: id } });
      key = k.json?.api_key || k.json?.key || null;
      if (!key) die(`failed to create Unsloth API key: ${k.text?.slice(0, 200)}`);
      console.log(`created persistent Unsloth API key for ${id}`);
    }
  }
  let server;
  try { server = await fetchModels(pr, base, runKey); } catch (e) { die(e.message); }
  if (!server.length) die("server returned 0 models");

  const out = numFlag(flags.output) ?? 65536;
  const ctxFlag = numFlag(flags.ctx);
  const notes = [];
  const mode = flags["dry-run"] ? "report" : "write";
  const fresh = !existsSync(CFG); // first provider on a machine without OpenCode config
  const cfg = loadCfgOrEmpty();
  const oldProv = cfg.provider[id] || {};
  const ctxMap = await resolveCtxs(server, { ctxFlag, mode, notes, existing: Object.keys(oldProv.models || {}) });
  const res = reconcile(oldProv.models || {}, server, { out, ctxMap, notes });
  const prov = {
    ...oldProv, // preserve any user-added provider-level fields
    name: flags.name || oldProv.name || id,
    npm: oldProv.npm || "@ai-sdk/openai-compatible",
    options: { ...(oldProv.options || {}), baseURL: base },
    models: res.models,
  };
  cfg.provider[id] = prov;
  console.log(`${id} (${pr.kind}, ${base}): ${Object.keys(prov.models).length} models`);
  for (const a of res.added) console.log(`  + ${a}`);
  for (const a of res.removed) console.log(`  - ${a} (no longer on server)`);
  for (const [m, o, n] of res.ctx) console.log(`  ~ ctx ${m}: ${o} -> ${n}`);
  for (const [m, o, n] of res.mods) console.log(`  ~ modalities ${m}: [${o}] -> [${n}]`);
  if (!res.added.length && !res.removed.length && !res.ctx.length && !res.mods.length) console.log("  up to date");
  for (const nt of notes) console.log("  note: " + nt);

  const hmodels = server.filter((m) => !m.skip).map((m) => ({ id: m.id, ctx: m.ctx ?? null }));
  const hkey = key || loadAuth()[id]?.key || null;
  const hmodel = flags.model || hmodels[0]?.id || null;
  const hargs = { name: prov.name, base, key: hkey, model: hmodel, models: hmodels };
  // every target is reported afterwards: what was written and what was skipped, and why
  const hermesLine = (r, verb) => {
    if (["off", "absent", "no-section", "unparsed", "layout", "error"].includes(r.status)) return `skipped — ${r.why}`;
    return `custom_providers "${r.name}" ${verb}${r.status} (${r.n} models, model: ${hmodel || "-"})`;
  };
  let hres = flags["no-hermes"] ? { status: "off", why: "disabled with --no-hermes" } : hermesUpsert({ ...hargs, dryRun: true });

  if (flags["dry-run"]) {
    console.log("dry-run: nothing written. Would write:");
    console.log(`  opencode  ${disp(CFG)}  provider "${id}" (${Object.keys(prov.models).length} models)`);
    console.log(`  keys      ${disp(AUTH)}  ${key ? `api key for "${id}"` : "no change (no --key)"}`);
    console.log(`  hermes    ${disp(HERMES_CFG)}  ${hermesLine(hres, "would be ")}`);
    return;
  }
  saveCfg(cfg);
  if (fresh) console.log(`created ${CFG}`);
  const a = loadAuth();
  if (key && a[id]?.key !== key) { a[id] = { type: "api", key }; saveAuth(a); }
  if (reportValidate(cfg)) console.log(`OK — ${Object.keys(prov.models).length} models in ${id}`);
  if (!flags["no-hermes"])
    try { hres = hermesUpsert({ ...hargs, dryRun: false }); }
    catch (e) { hres = { status: "error", why: `cannot write ${disp(HERMES_CFG)}: ${e.message}` }; }
  console.log("written:");
  console.log(`  opencode  ${disp(CFG)}  provider "${id}" (${Object.keys(prov.models).length} models)`);
  console.log(`  keys      ${disp(AUTH)}  ${key && a[id]?.key === key ? `api key for "${id}"` : "no change (no new key)"}`);
  console.log(`  hermes    ${disp(HERMES_CFG)}  ${hermesLine(hres, "")}`);
}

async function cmdSync() {
  const target = flags.target || "all";
  const written = [];
  if (!["all", "opencode", "hermes"].includes(target)) die(`bad --target "${target}" (all|opencode|hermes)`);
  // harnesses are independent: a missing config only skips its own target, so a
  // hermes-only (or opencode-only) machine still syncs what it has. The opencode
  // config is optional for hermes anyway — it is only used to borrow API keys.
  const haveOc = existsSync(CFG);
  if (!haveOc && (target === "opencode" || flags.provider)) die(`no ${CFG}\nadd a provider first: provider-sync add <id> <baseURL>`);
  const cfg = haveOc ? loadCfg() : {};
  const auth = loadAuth();
  const wantOc = target === "all" || target === "opencode";
  if (wantOc && !haveOc) console.log(`opencode (${CFG}): not found — skipped`);
  if (wantOc && haveOc) {
    const disabled = new Set(cfg.disabled_providers || []);
    const out = numFlag(flags.output) ?? 65536;
    const ctxFlag = numFlag(flags.ctx);
    const mode = flags.apply ? "write" : "report";
    const ids = Object.keys(cfg.provider || {}).filter((id) => !disabled.has(id) && (!flags.provider || flags.provider === id));
    if (!ids.length) console.log("opencode: no providers to check");
    const rs = await Promise.all(ids.map(async (id) => {
      const base = cfg.provider[id].options?.baseURL;
      if (!base) return { id, err: "no baseURL in config" };
      const key = auth[id]?.key || null;
      const pr = await probe(base, key);
      if (pr.kind === "offline") return { id, offline: pr.error || "HTTP " + pr.status };
      if (pr.kind === "auth") return { id, badauth: true };
      try { return { id, kind: pr.kind, base, server: await fetchModels(pr, base, key) }; }
      catch (e) { return { id, err: e.message }; }
    }));
    let changes = 0;
    for (const r of rs) {
      if (r.offline) { console.log(`${r.id}: OFFLINE (${r.offline}) — skipped`); continue; }
      if (r.badauth) { console.log(`${r.id}: AUTH 401 — key missing or invalid`); continue; }
      if (r.err) { console.log(`${r.id}: ERROR — ${r.err}`); continue; }
      const notes = [];
      const cur = cfg.provider[r.id].models || {};
      const ctxMap = await resolveCtxs(r.server, { ctxFlag, mode, notes, existing: Object.keys(cur) });
      const res = reconcile(cur, r.server, { out, ctxMap, notes });
      const n = r.server.filter((m) => !m.skip).length;
      console.log(`${r.id} (${r.kind}, ${r.base}): ${n} on server, ${Object.keys(cur).length} in config`);
      for (const a of res.added) console.log(`  + ${a}`);
      for (const a of res.removed) console.log(`  - ${a} (no longer on server)`);
      for (const [m, o, nw] of res.ctx) console.log(`  ~ ctx ${m}: ${o} -> ${nw}`);
      for (const [m, o, nw] of res.mods) console.log(`  ~ modalities ${m}: [${o}] -> [${nw}]`);
      for (const nt of notes) console.log("  note: " + nt);
      const total = res.added.length + res.ctx.length + res.mods.length + res.removed.length;
      if (!total) { console.log("  in sync"); continue; }
      changes += total;
      if (flags.apply) { cfg.provider[r.id].models = res.models; console.log(`  APPLIED ${total} change(s)`); }
    }
    if (flags.apply && changes) { saveCfg(cfg); reportValidate(cfg); written.push(`  opencode  ${disp(CFG)}  ${changes} change(s)`); }
    if (!flags.apply && changes) console.log(`${changes} change(s) pending — re-run with --apply to write`);
  }
  if (target === "all" || target === "hermes") {
    const hr = await syncHermes({ apply: !!flags.apply, ocCfg: cfg, ocAuth: auth });
    if (hr?.status === "applied") written.push(`  hermes    ${disp(HERMES_CFG)}  ${hr.changes} change(s) in ${hr.providers} provider(s)`);
    else if (hr && ["absent", "no-section", "empty"].includes(hr.status)) written.push(`  hermes    ${disp(HERMES_CFG)}  skipped — ${hr.why}`);
  }
  if (written.length) { console.log("written:"); for (const w of written) console.log(w); }
}

// ---------- main ----------
// run only when executed directly; importing the module (tests) must not exit
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
try {
  if (cmd === "list") cmdList();
  else if (cmd === "add") {
    if (!pos[1] || !pos[2]) die("usage: provider-sync add <id> <baseURL> [options] — see provider-sync help");
    await cmdAdd(pos[1], pos[2]);
  } else if (cmd === "sync") await cmdSync();
  else if (cmd === "set-ctx") {
    if (!pos[1]) die("usage: provider-sync set-ctx <provider> — see provider-sync help");
    await cmdSetCtx(pos[1]);
  } else if (cmd === "help" || cmd === "-h" || (!pos.length && (flags.help || flags.h))) console.log(HELP);
  else if (!cmd) { console.error(HELP); process.exit(1); }
  else die(`unknown command "${cmd}" — see provider-sync help`);
} catch (e) { die(e.stack || e.message); }
if (isMain) process.exit(process.exitCode ?? 0);
