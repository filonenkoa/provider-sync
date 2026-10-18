#!/usr/bin/env node
// provider-sync — manage local model providers for OpenCode and Hermes Agent.
// Zero dependencies, Node >= 18. Run `provider-sync help` for full documentation.

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, mkdirSync, readdirSync, unlinkSync, openSync, closeSync, fsyncSync, realpathSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { detectBackend, listCredentials } from "../lib/opencode-auth.js";
import { createHash } from "node:crypto";

// config file resolution mirrors OpenCode's own discovery: PS_CONFIG override
// (legacy: OCP_CONFIG), else the explicit file OpenCode loads after the global
// config ($OPENCODE_CONFIG), else the first existing of opencode.jsonc /
// opencode.json / config.json in $OPENCODE_CONFIG_DIR or
// $XDG_CONFIG_HOME/opencode (~/.config/opencode). jsonc wins over json on both
// 1.x and 2.x; config.json only exists on 1.x (2.x reads the first two names).
const CFG_DIR = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");
const CFG_CANDIDATES = ["opencode.jsonc", "opencode.json", "config.json"];
function detectCfg() {
  const hit = CFG_CANDIDATES.find((f) => existsSync(path.join(CFG_DIR, f)));
  return path.join(CFG_DIR, hit || CFG_CANDIDATES[0]);
}
const CFG_ENV = process.env.PS_CONFIG || process.env.OCP_CONFIG || process.env.OPENCODE_CONFIG || null;
export const CFG = CFG_ENV || detectCfg();
const AUTH = path.join(os.homedir(), ".local/share/opencode/auth.json");
// OpenCode 1.x keeps credentials in that file; 2.x keeps them in SQLite and
// only `auth` commands can write them. Detected once, reported honestly.
const authBackend = detectBackend();
const authInDb = authBackend.mode === "db";
export const HERMES_CFG = path.join(os.homedir(), ".hermes/config.yaml");
const HERMES_ENV = path.join(os.homedir(), ".hermes/.env");
// DeepSeek Harness: the home mirrors what dsh itself resolves — a non-blank
// $DSH_HOME (bare or ~/ tilde expanded) else ~/.dsh. Provider state lives in
// the active profile's cordis.patch.yml; a settings.yaml is the pre-0.2
// document dsh imports into that profile at its next boot.
const DSH_HOME = (() => {
  let p = (process.env.DSH_HOME || "").trim();
  if (!p) p = path.join(os.homedir(), ".dsh");
  else if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
})();
const DSH_SETTINGS = path.join(DSH_HOME, "settings.yaml");
const DSH_IMPORTED = path.join(DSH_HOME, "settings.yaml.imported");
const DSH_STORE = path.join(DSH_HOME, ".credentials.yaml");
const DSH_HOME_PATCH = path.join(DSH_HOME, "cordis.patch.yml");
const DSH_PROFILES = path.join(DSH_HOME, "profiles");

// ---------- cli ----------
const die = (m) => { console.error("error: " + m); process.exit(1); };
// parses ["--k","v"] and ["--k=v"]; boolean flags are the known no-value ones
const BOOL_FLAGS = new Set(["apply", "dry-run", "no-hermes", "help", "h", "version"]);
// a typo must not be swallowed: `--targe=hermes` used to be ignored and the
// default taken, which can write to a harness the user did not name
const VALUE_FLAGS = new Set(["name", "key", "key-env", "username", "password", "model", "target", "profile", "ctx", "output", "provider"]);
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const k = eq > 2 ? a.slice(2, eq) : a.slice(2);
    if (BOOL_FLAGS.has(k)) {
      // `--apply=false` used to read as "apply": any non-empty string is truthy
      if (eq > 2) die(`--${k} takes no value — drop the "=..."`);
      flags[k] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(k)) die(`unknown flag "--${k}" — see provider-sync help`);
    if (eq > 2) { flags[k] = a.slice(eq + 1); continue; }
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
// Everything the tool remembers between load() and save() lives on this object,
// so the coupling is visible instead of hidden in loose module variables.
const cfgStore = {
  hadComments: false, // the loaded file had comments, which a rewrite would drop
  warnedMulti: false, // the "several config files" note was already printed
  warnedComments: false,
  warnedLegacyName: false, // the "config.json is a 1.x name" note was already printed
  load() {
    if (!existsSync(CFG)) die(`no ${CFG}\nadd a provider first: provider-sync add <id> <baseURL>`);
    if (!this.warnedMulti && !CFG_ENV) {
      this.warnedMulti = true;
      const present = CFG_CANDIDATES.filter((f) => existsSync(path.join(CFG_DIR, f)));
      if (present.length > 1) console.error(`note: multiple config files in ${CFG_DIR} (${present.join(", ")}); OpenCode deep-merges them — provider-sync edits ${path.basename(CFG)}`);
    }
    // editing a file OpenCode 2.x does not read would "work" but change nothing
    if (!this.warnedLegacyName && !CFG_ENV && path.basename(CFG) === "config.json" && authInDb) {
      this.warnedLegacyName = true;
      console.error("note: config.json is an OpenCode 1.x config name — 2.x reads opencode.json / opencode.jsonc and will ignore edits made here");
    }
    const { text, hadComments } = parseJsonc(readFileSync(CFG, "utf8"));
    this.hadComments = hadComments;
    try {
      const p = JSON.parse(text);
      if (!p || typeof p !== "object" || Array.isArray(p)) die(`${CFG} must contain a JSON object`);
      return p;
    }
    catch (e) { die(`cannot parse ${CFG}: ${e.message}`); }
  },
};
export const loadCfg = () => cfgStore.load();
// ---------- provider shapes (1.x vs 2.x) ----------
// OpenCode 1.x wrote provider.<id> entries (`npm`, `options.baseURL/apiKey`,
// `models`). OpenCode 2.x reads that legacy shape by migrating it at load, but
// writes its own native shape providers.<id> (`package`, `settings.baseURL` /
// `settings.apiKey`, `models`). When both sections name the same id, 2.x lets
// the native entry REPLACE the legacy one wholesale — so a native entry that
// holds only a key would shadow (and break) a complete legacy definition.
// provider-sync therefore keeps each provider in a single shape: the one its
// entry already uses. A brand-new provider follows the file's dialect — native
// only in a config that has `providers` and no `provider` (a 2.x file), legacy
// everywhere else (1.x, and mixed files, where legacy also works on 2.x).
export function providerShape(cfg, id) {
  const native = cfg?.providers?.[id];
  if (native && typeof native === "object") return { shape: "native", entry: native };
  const legacy = cfg?.provider?.[id];
  if (legacy && typeof legacy === "object") return { shape: "legacy", entry: legacy };
  return { shape: cfg?.providers && !cfg?.provider ? "native" : "legacy", entry: null };
}
export const entryBaseURL = (shape, entry) => (shape === "native" ? entry?.settings?.baseURL : entry?.options?.baseURL);
export const entryApiKey = (shape, entry) => (shape === "native" ? entry?.settings?.apiKey : entry?.options?.apiKey);
// every provider id, legacy section first; a shadowed legacy id appears once
// and resolves to the native entry (which is what OpenCode 2.x will use)
export function providerIds(cfg) {
  const seen = new Set();
  const ids = [];
  for (const id of [...Object.keys(cfg?.provider || {}), ...Object.keys(cfg?.providers || {})])
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  return ids;
}
// What we know about a provider's credential, without pretending to more.
//   value    — readable, usable for probing
//   stored   — present, but in OpenCode's database: we can see that it exists
//              and nothing else, which is all the documentation allows
//   absent   — no credential anywhere we know of
// The key OpenCode itself will use for this provider: the entry's own shape
// wins, exactly like OpenCode's own load order. Verified against the real
// binary: a key in the provider entry arrives as the bearer token (1.x:
// provider.<id>.options.apiKey; 2.x: providers.<id>.settings.apiKey). This is
// also the only store that works without an interactive login, which is why
// `add --key` writes here rather than into auth.json or the database.
export function configApiKey(cfg, id) {
  const { shape, entry } = providerShape(cfg, id);
  const v = entry ? entryApiKey(shape, entry) : null;
  return typeof v === "string" && v ? v : null;
}
export function configApiKeyPaths(cfg, id) {
  return [providerShape(cfg, id).shape === "native" ? `providers.${id}.settings.apiKey` : `provider.${id}.options.apiKey`];
}
// Call with the provider entry itself already present (cmdAdd writes the full
// entry first): for a native provider this must not be the only thing written,
// because a native entry without `package`/`models` shadows the legacy one.
export function storeConfigApiKey(cfg, id, key) {
  const { shape } = providerShape(cfg, id);
  if (shape === "native") {
    cfg.providers = cfg.providers || {};
    cfg.providers[id] = cfg.providers[id] || {};
    cfg.providers[id].settings = { ...(cfg.providers[id].settings || {}), apiKey: key };
  } else {
    cfg.provider = cfg.provider || {};
    cfg.provider[id] = cfg.provider[id] || {};
    cfg.provider[id].options = { ...(cfg.provider[id].options || {}), apiKey: key };
  }
  return configApiKeyPaths(cfg, id);
}
// `{env:VAR}` in an apiKey is resolved by OpenCode from its own environment at
// startup; provider-sync probes servers directly, so it must resolve the same
// reference itself — sending the literal string would fail with 401.
export const envRef = (k) => {
  const m = typeof k === "string" && /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(k);
  return m ? m[1] : null;
};
// the key to actually send: a {env:VAR} reference becomes its value (null when
// the variable is not set here); any other key passes through unchanged
export const derefKey = (k) => {
  const ref = envRef(k);
  if (ref === null) return k ?? null;
  return process.env[ref] || null;
};
export function credentialFor(id, auth = loadAuth(), cfg = null) {
  const ck = configApiKey(cfg, id);
  if (ck) {
    const usable = derefKey(ck);
    // the config holds an {env:VAR} reference that is unset here: the key
    // exists on paper only, and "no-key" would hide the real cause
    if (!usable) return { state: "unresolved", key: null, where: CFG, from: "config", ref: ck };
    return { state: "value", key: usable, where: CFG, from: "config" };
  }
  // a readable value always wins over a store we cannot read: on a machine with
  // both a 1.x-style file and a 2.x-style database, hiding the usable key would
  // be worse than trusting it — the report says which store it came from.
  if (auth[id]?.key) return { state: "value", key: auth[id].key, where: AUTH, from: "auth.json" };
  if (authInDb) {
    const creds = dbCredentials();
    if (creds === null) return { state: "unknown", key: null, where: authBackend.dbPath };
    return id in creds
      ? { state: "stored", key: null, where: authBackend.dbPath, type: creds[id] }
      : { state: "absent", key: null };
  }
  return { state: "absent", key: null };
}
let _dbCreds;
function dbCredentials() {
  if (_dbCreds === undefined) _dbCreds = authInDb ? listCredentials() : null;
  return _dbCreds;
}
// short label for reports
export function credentialLabel(c) {
  if (c.state === "value" && c.from === "config") return "key (config)";
  if (c.state === "value") return authInDb ? "key (auth.json, may be stale)" : "key";
  if (c.state === "stored") return c.type && c.type !== "unknown" ? `key (${c.type}, in opencode db)` : "key (in opencode db)";
  if (c.state === "unknown") return "unknown (a database is present; the opencode CLI cannot list credentials)";
  if (c.state === "unresolved") return `no-key (${c.ref} is unset in this environment)`;
  return "no-key";
}
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
// millisecond precision: two writes in the same second must not overwrite
// each other's backup (the name doubles as the sort key)
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").replace(/\.(\d{3})Z$/, "_$1");
// drop all but the newest `keep` backups of `file`; legacy .bak-ocp- files included
function pruneBackups(file, keep = 3) {
  const dir = path.dirname(file);
  const prefixes = [path.basename(file) + ".bak-provider-sync-", path.basename(file) + ".bak-ocp-"];
  const baks = readdirSync(dir).filter((f) => prefixes.some((p) => f.startsWith(p))).sort();
  for (const f of baks.slice(0, -keep)) unlinkSync(path.join(dir, f));
}
// write via a temp file in the same directory, flush it to disk, then rename.
// fsync on the file makes the content durable; fsync on the directory makes the
// rename durable. without both, a power cut can leave a truncated config.
export function atomicWrite(file, data, mode = null) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-provider-sync";
  let fd = null;
  try {
    fd = openSync(tmp, "w");
    writeFileSync(fd, data);
    try { fsyncSync(fd); } catch {} // not every fs supports it
  } finally {
    if (fd !== null) closeSync(fd);
  }
  // owner-only for credential stores: set the mode before the rename, so the
  // file is never group/other-readable even for a moment
  if (mode !== null) { try { chmodSync(tmp, mode); } catch {} }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  try { // POSIX only: opening a directory fails on Windows, and that is fine
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch {}
}
function saveJson(file, obj) {
  if (existsSync(file)) {
    copyFileSync(file, file + ".bak-provider-sync-" + stamp());
    try { pruneBackups(file); } catch {}
  }
  atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");
}
export const saveCfg = (c) => {
  if (cfgStore.hadComments && !cfgStore.warnedComments) {
    cfgStore.warnedComments = true;
    console.error("note: comments in the config file are not preserved by provider-sync writes");
  }
  saveJson(CFG, c);
};
const saveAuth = (a) => saveJson(AUTH, a);

// numeric flag: undefined stays undefined; empty, non-numeric or below min is
// an error instead of silently becoming 0 (which for --ctx means "omit")
const numFlag = (v, min = 0) => {
  if (v === undefined) return undefined;
  if (v === true || v === "") die("numeric flag needs a value");
  const n = +v;
  if (!Number.isFinite(n)) die(`bad number "${v}"`);
  if (n < min) die(`bad number "${v}" (must be >= ${min})`);
  return n;
};

// ---------- help ----------
const HELP = `provider-sync — manage local model providers for OpenCode, Hermes Agent and DeepSeek Harness

Zero dependencies; requires Node >= 18 (built-in fetch).
Run \`provider-sync\`, \`provider-sync help\`, \`-h\` or \`--help\` to see this text again;
\`--version\` prints the version.

Files:
  config   $OPENCODE_CONFIG (an explicit config file) else the first existing
           of opencode.jsonc, opencode.json, config.json in $OPENCODE_CONFIG_DIR
           or ~/.config/opencode — the same choice OpenCode itself makes
           (override with PS_CONFIG=/path/to/file; 2.x ignores config.json)
  keys     provider.<id>.options.apiKey (1.x entry) or
           providers.<id>.settings.apiKey (2.x entry) — API keys are written
           into the shape the provider entry already uses, and OpenCode sends
           it as the bearer token. OpenCode's own stores (auth.json on 1.x,
           opencode.db on 2.x) are read-only for provider-sync: presence is
           reported, never changed
  hermes   ~/.hermes/config.yaml               custom_providers (if installed)
           ~/.hermes/.env                      key source for Hermes providers
  dsh      ~/.dsh/profiles/<name>/cordis.patch.yml  the live llm-pi-ai providers
                                               (the dsh home honors $DSH_HOME)
           ~/.dsh/settings.yaml                pre-0.2 document — dsh imports it
                                               at the next boot, so provider-sync
                                               writes there while it exists
           ~/.dsh/.credentials.yaml            key store; provider-sync writes
                                               refs but never prints a value

Commands:
  provider-sync list [--target all|opencode|hermes|dsh] [--profile NAME]
      List configured providers per harness — id/name, model count, base URL
      and key status (for Hermes also where the key comes from: literal,
      ~/.hermes/.env, or borrowed from a matching OpenCode provider; for dsh
      from the environment, ~/.dsh/.credentials.yaml or ~/.dsh/.env). Entries
      living in the 2.x \`providers\` section are marked (2.x). A harness that
      is not installed is reported as "not found — skipped" instead of
      failing, so a Hermes-only or OpenCode-only machine is fine.

  provider-sync add <id> <baseURL> [options]
      Register or update a provider. The server type is auto-detected:
      llama.cpp (preset --ctx-size + per-model architecture), LM Studio
      (/api/v0/models), Unsloth UI (login + persistent API key) or any
      OpenAI-compatible server.
      Upsert semantics: models missing on the server are removed, new ones
      added, server-authoritative ctx/modalities applied; configured values
      are kept when the server reports nothing. Re-running add against a
      moved server re-points baseURL and reconciles the model list.
      Key resolution: --key K > the key already in the provider entry for <id>
      > OpenCode's own store (auth.json / database). For an
      Unsloth UI with neither, pass --username U --password P: provider-sync logs in
      and creates (and stores) a persistent API key named after <id>.
      On a machine without an OpenCode config the file is created (first
      provider bootstraps it); --dry-run writes nothing.
      Reaches every installed harness: the same provider is also created or
      updated under custom_providers in ~/.hermes/config.yaml (matched by
      base URL, so re-running updates instead of duplicating) and in the dsh
      llm-pi-ai config (matched by base URL, then by id). A harness that
      is not installed is left alone — no config file is created for it — and
      --target opencode is how you ask for one to be created anyway.
      dsh specifics: the provider is written where dsh reads now — into
      settings.yaml while it still exists (dsh imports it at the next boot),
      else into the active profile's cordis.patch.yml (--profile NAME picks
      one; the default is web). The key goes to ~/.dsh/.credentials.yaml as a
      reference (<ID>_API_KEY, like dsh's own UI); without --key the existing
      reference is kept, and a keyless server gets "dummy" so requests do not
      fail with MISSING_CREDENTIAL.
      Entry shapes: a provider whose entry lives in the 2.x \`providers\`
      section is updated in that shape (package/settings/models); a legacy
      provider.<id> entry stays legacy (2.x migrates it at load). A config
      with only \`providers\` — a 2.x file — gets new providers in 2.x shape.
      provider-sync never writes a second entry for the same id: OpenCode 2.x
      would let the partial one shadow and break the real entry.
      Whatever happens, the last lines report per target: what was written,
      what was skipped, and which of the two reasons it was.
      Options:
        --name N          display name (default: existing value, else <id>)
        --key K           API key; stored into the provider entry in your
                          config (apiKey), written into the hermes entry as
                          a literal api_key, and stored in
                          ~/.dsh/.credentials.yaml behind the entry's key
                          reference (dummy when the server needs no auth)
        --key-env VAR     store the key as an {env:VAR} reference instead of
                          the literal secret, so a config that lives in version
                          control stays clean; resolved from the environment
                          when provider-sync probes the server (for dsh this
                          becomes the entry's apiKeyEnv, and nothing is stored)
        --username U      Unsloth UI login; both flags must be passed together,
        --password P      and only an Unsloth UI server accepts the login
        --model M         model written into the hermes entry's model:
                          field (default: first model the server reports)
        --target T        all|opencode|hermes|dsh (default all); only the
                          chosen harnesses are written
        --profile NAME    dsh profile whose cordis.patch.yml is edited
                          (default: web, else the only profile there is)
        --no-hermes       shortcut for --target opencode
        --ctx N           ctx for models whose server reports none
                          (0 = omit the limit). Without it, provider-sync asks
                          interactively in a terminal; with --dry-run a
                          guess is shown instead.
        --output N        max output tokens written into new limits
                          (default 65536)
        --dry-run         report what would change; writes nothing and
                          creates no API key

  provider-sync sync [--apply] [--target all|opencode|hermes|dsh] [--provider ID]
                      [--profile NAME]
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
        dsh       llm-pi-ai providers — the live profile patch, or
                  settings.yaml while dsh has not imported it yet. Model
                  lists are server-authoritative (added/removed models and
                  server-reported contextWindow values are written; entries
                  dsh owns — api, displayName, other fields — survive).
                  Refuses to touch a providers block it cannot rewrite
                  losslessly, and reports why instead.
        all       all three (default)
      Harnesses are independent — a target whose config file is missing is
      reported as "not found — skipped" and the other ones still run, so
      hermes-only, opencode-only and dsh-only machines work. Asking for a
      target explicitly (--target opencode / --provider ID) without an
      OpenCode config is still an error.
      Options: --provider ID (opencode target only; asks for an unknown or
      disabled provider are refused, not silently empty), --profile NAME
      (dsh target: which profile patch to edit — default web, else the only
      profile there is), --ctx N, --output N,
      --key K (used for this run only — never stored), --dry-run (report
      only; --dry-run always wins over --apply). Providers in the 2.x
      \`providers\` shape are checked and updated in place.

  provider-sync set-ctx <provider>
      Interactively re-ask the context window for every model whose server
      reports no ctx (models absent from the server are skipped). Enter =
      best known value (trained window from server metadata when available,
      else a heuristic on the model id), number = use it, k = keep current,
      0 = omit the limit. Use this to fix guessed or stale values. Needs a
      terminal. Options: --output N, --key K (this run only), --dry-run.

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
  3. borrowed from an opencode provider whose config entry has the same
     server URL (localhost and 127.0.0.1 count as the same host); a
     {env:VAR} reference there is resolved from the environment, and
     --key-env stores it as a hermes key_env instead of the literal key

DeepSeek Harness key resolution, first match wins:
  1. the launch environment (a provider's apiKeyEnv variable)
  2. the stored reference in ~/.dsh/.credentials.yaml (values are never
     printed; a multi-line value is reported as unreadable, not guessed)
  3. ~/.dsh/.env
  A route that names no apiKeyEnv authenticates from its own record in the
  store (llm-pi-ai/<route>), which is what a dsh sign-in writes: the record's
  key is used to probe, a grant is reported as signed-in but unreadable, and
  provider-sync never adds an apiKeyEnv over such a route (that would override
  the credential dsh resolves itself).
  --key K is stored in that file under the entry's reference (a new
  provider gets <ID>_API_KEY, dsh's own convention); --key-env VAR sets
  apiKeyEnv: VAR and stores nothing. A keyless OpenAI-compatible server
  gets the placeholder "dummy" so its requests do not fail with
  MISSING_CREDENTIAL.

Safety:
  - every write is atomic (tmp file + fsync + rename) and preceded by a
    .bak-provider-sync-* backup; only the last 3 backups per file are kept
  - the config file is validated after each write; the hermes config is
    re-read and rolled back from its backup if it no longer parses, and the
    dsh configs are re-read and compared provider-by-provider, with the
    same rollback on a mismatch
  - dsh writes touch only the llm-pi-ai providers block: everything else in
    settings.yaml / cordis.patch.yml survives byte for byte, and a block
    with comments, anchors, tags or flow mappings inside is refused (with
    the reason) rather than rewritten
  - ~/.dsh/.credentials.yaml is written owner-only (mode 600) — dsh refuses
    to load a store others can read — and a stored secret is never printed
  - writing commands (add, sync --apply, set-ctx) take an exclusive lock in
    the system temp directory (keyed by the config directory), so two runs
    cannot interleave; read-only commands never take it
  - --dry-run never writes, in add, sync and set-ctx alike (with --apply on
    the same line it still wins); an unknown flag or a value on a boolean flag
    (--apply=false) is refused instead of guessed, and so is a known flag that
    means nothing for the command it sits on (sync --no-hermes, list --key)
  - each provider is kept in exactly one entry shape — the one it already
    uses — because a second, partial entry for the same id would shadow and
    break the real one on OpenCode 2.x
  - on errors nothing is reported as written and provider-sync exits non-zero

Examples:
  provider-sync add 3090-lan http://192.168.9.50:64980/v1 --key 4117...
  provider-sync add helen http://100.64.0.6:8888/v1 --username unsloth --password ***
  provider-sync add local http://127.0.0.1:8080/v1 --dry-run
  provider-sync sync                      # status check, opencode + hermes + dsh, nothing written
  provider-sync sync --apply              # apply all pending changes
  provider-sync sync --apply --provider 3090
  provider-sync sync --target hermes      # only the Hermes fallback catalogs
  provider-sync sync --target dsh         # only the dsh llm-pi-ai providers
  provider-sync add new http://10.0.0.5:64980/v1 --key ... --ctx 32768
  provider-sync set-ctx 3090
`;

// ---------- http ----------
// `cap` stops reading after N bytes (used for the huge Unsloth openapi.json,
// where only info.title matters) — the rest of the body is never downloaded
async function readCapped(r, cap) {
  if (!cap || !r.body) return r.text();
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (out.length >= cap) break;
    }
  } finally { try { await reader.cancel(); } catch {} }
  return out;
}

export async function req(url, { method = "GET", key, body, timeout = 6000, cap = 0 } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, {
      method, signal: c.signal,
      headers: {
        Accept: "application/json",
        ...(key ? { Authorization: "Bearer " + key } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await readCapped(r, cap);
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
// one probe per server per run: the opencode and hermes sections often point at
// the same URL, and re-probing it would triple the request count for no new data
const _probes = new Map();
export function probeCached(base, key) {
  const k = normUrl(base) + "|" + (key || "");
  if (!_probes.has(k)) _probes.set(k, probe(base, key));
  return _probes.get(k);
}
// the cache is per-run state; tests need to start from a clean slate
export const clearProbeCache = () => _probes.clear();

export async function probe(base, key) {
  const root = rootOf(base);
  // only info.title is read from the Unsloth spec, so cap the download; a capped
  // body is truncated, hence the regex fallback instead of relying on r.json
  let r = await req(root + "/openapi.json", { cap: 8192 });
  const title = r.json?.info?.title ?? ((r.text || "").match(/"title"\s*:\s*"([^"]{0,200})"/) || [])[1] ?? "";
  if (r.status === 200 && /unsloth/i.test(title)) return { kind: "unsloth", root };
  r = await req(root + "/api/v0/models", { key });
  if (r.status === 200 && r.json) return { kind: "lmstudio", root, models: Array.isArray(r.json) ? r.json : r.json.data || [] };
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
export async function fetchModels(pr, base, key) {
  if (pr.kind === "llamacpp" || pr.kind === "openai") return pr.models.map(specAny);
  if (pr.kind === "lmstudio") {
    // probe() already fetched /api/v0/models and handed the payload over
    const data = pr.models || await req(rootOf(base) + "/api/v0/models", { key }).then((r) => {
      if (r.status !== 200) throw new Error("/api/v0/models HTTP " + r.status);
      return Array.isArray(r.json) ? r.json : r.json?.data || [];
    });
    return data.filter((m) => m && m.id).map((m) => ({
      id: m.id,
      ctx: nz(m.loaded_context_length || m.max_context_length),
      input: m.type === "vlm" ? ["text", "image"] : null,
      skip: m.type === "embeddings",
    }));
  }
  if (pr.kind === "unsloth") {
    const r = await req(v1Of(base) + "/models", { key });
    if (r.status === 401) throw new Error("401: the server rejected the API key (provider-sync add <id> <url> --key K, or --username U --password P to create one)");
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

// context windows are powers of two in practice, so snap a parsed "262K" (268288)
// down to 262144 rather than trusting the digits in the name
const pow2 = (n) => { let p = 4096; while (p * 2 <= n) p *= 2; return p; };
// guess a context window from the model id (only used as prompt hint / report)
export function guessCtx(id) {
  const k = id.match(/(^|[^A-Za-z0-9])(\d+)K/i);
  if (k) return pow2(parseInt(k[2]) * 1024);
  if (/1M/i.test(id)) return 1048576;
  if (/qwen3\.[5-9]/i.test(id)) return 262144;
  return 131072;
}
// one readline interface for the whole run, created on first use
const asker = (() => {
  let rl = null;
  return async (q) => {
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(q); }
    catch { try { rl.close(); } catch {} rl = null; throw new Error("input ended"); }
  };
})();
const ask = asker;

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

// Model fields differ per shape: legacy entries use modalities / attachment /
// tool_call / reasoning; native 2.x entries use capabilities (input / output /
// tools / reasoning). The information maps 1:1, only the field names change.
function freshEntry(id, m, { out, ctxMap, shape = "legacy" }) {
  const inp = m.input || MOD_BY_ID(id);
  const raw = m.ctx ?? ctxMap?.[id] ?? null;
  const c = typeof raw === "number" && raw > 0 ? raw : null; // ctx 0 means "omit the limit"
  const e = { name: id };
  if (shape === "native") {
    e.capabilities = { tools: TOOL_BY_ID(id), input: inp, output: ["text"] };
    if (REASON_BY_ID(id)) e.capabilities.reasoning = { supported: true };
  } else {
    // `attachment` is implied by the input modalities in the 2.x shape
    if (inp.length > 1) e.attachment = true;
    e.modalities = { input: inp, output: ["text"] };
    e.tool_call = TOOL_BY_ID(id);
    if (REASON_BY_ID(id)) e.reasoning = true;
  }
  if (c != null) e.limit = { context: c, output: out };
  return e;
}
export function upsertEntry(old, m, opts) {
  const shape = opts.shape || "legacy";
  if (!old) return freshEntry(m.id, m, opts);
  const e = structuredClone(old);
  if (m.input) {
    if (shape === "native")
      e.capabilities = { ...(e.capabilities || {}), input: m.input, output: e.capabilities?.output || ["text"] };
    else e.modalities = { input: m.input, output: e.modalities?.output || ["text"] };
  }
  if (m.ctx != null) e.limit = { context: m.ctx, output: e.limit?.output || opts.out };
  return e;
}
// the input modalities an entry declares, whichever shape it is written in
export const entryInputMods = (shape, m) => ((shape === "native" ? m?.capabilities?.input : m?.modalities?.input) || []);

// existing models object + server specs -> merged + diff
export function reconcile(models, server, { out, ctxMap, shape = "legacy" }) {
  const res = { added: [], removed: [], ctx: [], mods: [] };
  const next = {};
  const seen = new Set();
  for (const m of server) {
    seen.add(m.id);
    if (m.skip) { if (models[m.id]) next[m.id] = models[m.id]; continue; }
    const old = models[m.id];
    next[m.id] = upsertEntry(old, m, { out, ctxMap, shape });
    if (!old) res.added.push(m.id);
    else {
      if (m.ctx != null && old.limit?.context !== m.ctx) res.ctx.push([m.id, old.limit?.context, m.ctx]);
      if (m.input && JSON.stringify(entryInputMods(shape, old)) !== JSON.stringify(m.input))
        res.mods.push([m.id, entryInputMods(shape, old), m.input]);
    }
  }
  for (const id of Object.keys(models)) if (!seen.has(id)) { res.removed.push(id); delete next[id]; }
  return { models: next, ...res };
}

import { ind, normUrl, deq, yq, parseHermes, renderModels, hermesSetModels, hermesSetField } from "../lib/hermes-yaml.js";

// ---------- hermes (~/.hermes/config.yaml, custom_providers) ----------
// Surgical line-based YAML edits: no full-file reparse/rewrite, comments and
// formatting of untouched sections are preserved. Only the per-provider
// `models:` block (a fallback catalog for offline use) is rewritten.

// parse ~/.hermes/.env once per run; the cache lives in this closure
const once = (fn) => { let v; return () => (v === undefined ? (v = fn()) : v); };
const hermesEnv = once(() => {
  const env = {};
  if (existsSync(HERMES_ENV))
    for (const line of readFileSync(HERMES_ENV, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  return env;
});


// short paths in reports: ~/.config/... instead of /Users/x/.config/...
const disp = (p) => (typeof p === "string" && p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);


// key for a hermes custom provider: literal api_key / ${ENV} / key_env from
// ~/.hermes/.env, else borrow the opencode key of a provider on the same
// server — from the provider's config entry (where `add --key` stores it since
// 1.1.1) or auth.json, with {env:VAR} references resolved. Returns { key } when
// a usable key was found; when none is readable, the best explanation found on
// the way: { key: null, ref, from } for an unset {env:VAR}, or
// { key: null, dbKey: true, from } when it lives in OpenCode's database.
function hermesKey(e, ocCfg, ocAuth) {
  if (e.api_key && e.api_key !== "dummy") {
    if (e.api_key.startsWith("${") && e.api_key.endsWith("}")) return { key: hermesEnv()[e.api_key.slice(2, -1)] || null };
    return { key: e.api_key };
  }
  if (e.key_env) return { key: hermesEnv()[e.key_env] || null };
  let miss = null;
  for (const pid of providerIds(ocCfg)) {
    const { shape, entry } = providerShape(ocCfg, pid);
    if (normUrl(entryBaseURL(shape, entry)) !== normUrl(e.base_url)) continue;
    const c = credentialFor(pid, ocAuth, ocCfg);
    if (c.key) return { key: c.key }; // the first readable key wins
    if (!miss) {
      if (c.state === "unresolved") miss = { key: null, ref: c.ref, from: pid };
      else if (c.state === "stored" || c.state === "unknown") miss = { key: null, dbKey: true, from: pid };
    }
  }
  return miss || { key: null };
}

// where a hermes entry gets its key from; shown by `list` so that "no-key"
// can be told apart from "key that just could not be resolved"
function hermesKeySource(e, ocCfg, ocAuth) {
  if (e.api_key && e.api_key !== "dummy")
    return e.api_key.startsWith("${") && e.api_key.endsWith("}") ? "key (env)" : "key";
  if (e.key_env) return hermesEnv()[e.key_env] ? "key (env)" : `no-key (${e.key_env} is unset in ~/.hermes/.env)`;
  for (const pid of providerIds(ocCfg)) {
    const { shape, entry } = providerShape(ocCfg, pid);
    if (normUrl(entryBaseURL(shape, entry)) !== normUrl(e.base_url)) continue;
    const c = credentialFor(pid, ocAuth, ocCfg);
    if (c.state === "value") return `key (borrowed from ${pid})`;
    if (c.state === "unresolved") return `no-key (${c.ref} from ${pid} is unset)`;
  }
  if (authInDb) {
    for (const pid of providerIds(ocCfg)) {
      const { shape, entry } = providerShape(ocCfg, pid);
      if (normUrl(entryBaseURL(shape, entry)) === normUrl(e.base_url) && credentialFor(pid, ocAuth).state === "stored")
        return "no-key (opencode has a key for this server, stored in its database)";
    }
  }
  return "no-key";
}

// ---------- hermes writes (shared by sync and add) ----------

// read the file we just wrote and confirm it still says what we intended;
// a mismatch means the line surgery produced something we do not understand,
// so the backup (made a moment earlier) is put back and the caller is told
function verifyHermesWrite(expect) {
  const after = parseHermes(readFileSync(HERMES_CFG, "utf8"));
  if (!after) return "the written file no longer has a custom_providers section";
  if (expect.entries != null && after.entries.length !== expect.entries)
    return `entry count changed (${expect.entries} -> ${after.entries.length})`;
  for (const { base, ids } of expect.models || []) {
    const e = after.entries.find((x) => normUrl(x.base_url) === normUrl(base));
    if (!e) return `entry for ${base} disappeared`;
    if (JSON.stringify(e.models.map((m) => m.id)) !== JSON.stringify(ids))
      return `models of ${base} did not land as written`;
  }
  return null;
}
// atomic write with a rotating backup; returns the backup path
function writeHermesCfg(lines, eol = "\n", expect = {}) {
  const bak = HERMES_CFG + ".bak-provider-sync-" + stamp();
  try {
    copyFileSync(HERMES_CFG, bak);
    try { pruneBackups(HERMES_CFG); } catch {}
    atomicWrite(HERMES_CFG, lines.join(eol));
  } catch (e) {
    throw new Error(`cannot write ${disp(HERMES_CFG)}: ${e.message}`);
  }
  const bad = verifyHermesWrite(expect);
  if (bad) {
    copyFileSync(bak, HERMES_CFG); // roll back to the untouched original
    throw new Error(`${bad} — ${disp(HERMES_CFG)} was restored from ${path.basename(bak)}`);
  }
  return path.basename(bak);
}

// create or update a custom_providers entry so `add` reaches every installed
// harness; matched by base URL, so re-running updates instead of duplicating
export function hermesUpsert({ name, base, key, model, models, dryRun }) {
  if (!existsSync(HERMES_CFG)) return { status: "absent", why: `hermes not installed (${disp(HERMES_CFG)} not found)` };
  const h = parseHermes(readFileSync(HERMES_CFG, "utf8"));
  if (!h) return { status: "no-section", why: `no custom_providers section in ${disp(HERMES_CFG)}` };
  const n = models.length;
  // `{env:VAR}` is OpenCode's syntax; Hermes reads `key_env` from
  // ~/.hermes/.env, so an env reference is translated instead of copied
  const ref = envRef(key);
  const found = h.entries.find((e) => normUrl(e.base_url) === normUrl(base));
  if (found) {
    if (found.flow)
      return { status: "flow", why: `the entry for ${base} is written in flow style on one line — provider-sync will not rewrite it` };
    if (dryRun) return { status: "updated", name: found.name, n };
    const lines = h.lines.slice();
    hermesSetModels(lines, found, models);
    if (ref) {
      if (found.key_env !== ref) hermesSetField(lines, found, "key_env", ref);
      // a live literal key would shadow key_env on Hermes' side
      if (found.api_key && found.api_key !== "dummy") hermesSetField(lines, found, "api_key", "dummy");
    } else if (key && found.api_key !== key) hermesSetField(lines, found, "api_key", key);
    writeHermesCfg(lines, h.eol, { entries: h.entries.length, models: [{ base, ids: models.map((m) => m.id) }] });
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
    `${ind(fi)}api_key: ${!ref && key ? yq(key) : "dummy"}`,
    ...(ref ? [`${ind(fi)}key_env: ${ref}`] : []),
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
  writeHermesCfg(lines, h.eol, { entries: h.entries.length + 1, models: [{ base, ids: models.map((m) => m.id) }] });
  return { status: "created", name, n };
}

async function syncHermes({ apply, ocCfg, ocAuth }) {
  if (!existsSync(HERMES_CFG)) { console.log(`hermes (${disp(HERMES_CFG)}): not found — skipped`); return { status: "absent", why: "not installed" }; }
  const text = readFileSync(HERMES_CFG, "utf8");
  const h = parseHermes(text);
  if (!h) { console.log(`hermes (${disp(HERMES_CFG)}): no custom_providers — skipped`); return { status: "no-section", why: "no custom_providers section" }; }
  if (!h.entries.length) { console.log(`hermes: custom_providers found but no entries parsed${h.unparsed ? ` (${h.unparsed} item(s) in an unexpected layout)` : " (unexpected indentation?)"} — skipped`); return { status: "empty", why: "no entries parsed" }; }
  console.log(`hermes (${disp(HERMES_CFG)}): ${h.entries.length} custom provider(s)`);
  if (h.unparsed) console.log(`  note: ${h.unparsed} item(s) in an unexpected layout — skipped, provider-sync will not touch them`);
  // probe all providers in parallel, then report in config order
  const rs = await Promise.all(h.entries.map(async (e) => {
    if (e.flow) return { e, skip: "flow-style entry (one line in braces) — listed, never rewritten" };
    if (!e.base_url) return { e, skip: "no base_url" };
    const { key, ref, from, dbKey } = hermesKey(e, ocCfg, ocAuth);
    // --key stands in for this run when the stored key is unreadable (e.g. it
    // lives in OpenCode's database) and is never stored
    const runKey = key || flags.key || null;
    const pr = await probeCached(e.base_url, runKey);
    if (pr.kind === "offline") return { e, offline: pr.error || "HTTP " + pr.status };
    if (pr.kind === "auth")
      return { e, badauth: true, unsetRef: ref, refFrom: from, dbKey, supplied: !key && !!flags.key };
    try { return { e, kind: pr.kind, server: await fetchModels(pr, e.base_url, runKey) }; }
    catch (err) { return { e, err: err.message }; }
  }));
  const edits = [];
  let changes = 0;
  for (const r of rs) {
    if (r.skip) { console.log(`  ${r.e.name}: ${r.skip} — skipped`); continue; }
    if (r.offline) { console.log(`  ${r.e.name} (${r.e.base_url}): OFFLINE (${r.offline}) — skipped`); continue; }
    if (r.badauth) {
      console.log(r.supplied
        ? `  ${r.e.name} (${r.e.base_url}): AUTH 401 — the key passed with --key was rejected — check it`
        : r.unsetRef
          ? `  ${r.e.name} (${r.e.base_url}): AUTH 401 — its key is ${r.unsetRef} (from ${r.refFrom}), which is not set in this environment`
          : r.dbKey
            ? `  ${r.e.name} (${r.e.base_url}): AUTH 401 — its key is in OpenCode's database (from ${r.refFrom}) and cannot be read here; pass --key K to check this server`
            : `  ${r.e.name} (${r.e.base_url}): AUTH 401 — key missing or invalid`);
      continue;
    }
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
  const bak = writeHermesCfg(lines, h.eol, {
    entries: h.entries.length,
    models: edits.map((ed) => ({ base: ed.e.base_url, ids: ed.live.map((m) => m.id) })),
  });
  console.log(`  APPLIED ${changes} change(s) — backup at ${bak}`);
  return { status: "applied", changes, providers: edits.length };
}

// ---------- deepseek harness (dsh) ----------
// dsh keeps provider state in the active profile's cordis.patch.yml (the
// `- id: llm-pi-ai` loader patch item). Before the first 0.2 boot it still
// lives in settings.yaml, which dsh imports into the profile once and renames
// to settings.yaml.imported. provider-sync edits whichever document is live:
// settings.yaml while it exists, the profile patch after dsh consumed it.

import { parseDshSettings, writeDshSettings, parseDshPatch, writeDshPatch, parseDshStore, setDshStoreRef, dshRefName, PATCH_HEADER } from "../lib/dsh-yaml.js";

function dshProfiles() {
  try {
    return readdirSync(DSH_PROFILES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return []; }
}
// the profile whose patch provider-sync edits: --profile wins; else web (the
// shipped appliance); else the only profile there is. several profiles and no
// settings.yaml (which would be profile-agnostic) is refused for writes.
function dshProfile() {
  const names = dshProfiles();
  if (flags.profile !== undefined) {
    if (!names.includes(flags.profile))
      die(`no dsh profile "${flags.profile}" under ${disp(DSH_PROFILES)}${names.length ? ` (found: ${names.join(", ")})` : " (no profiles yet)"}`);
    return { name: flags.profile, note: null, names };
  }
  if (names.includes("web")) return { name: "web", note: null, names };
  if (names.length === 1) return { name: names[0], note: `dsh profile "${names[0]}" is the only one — using it`, names };
  return { name: null, note: names.length ? `several dsh profiles (${names.join(", ")}) — name one with --profile` : null, names };
}
const dshPatchPath = (name) => path.join(DSH_PROFILES, name, "cordis.patch.yml");

// which document is live; `create` is for add --target dsh on a home that has
// no profile yet — then settings.yaml is the right surface regardless of
// profile, because dsh imports it into whichever profile boots next
function dshSurface({ create = false } = {}) {
  const prof = dshProfile();
  if (existsSync(DSH_SETTINGS))
    return { kind: "legacy", file: DSH_SETTINGS, profile: prof.name, note: "settings.yaml is the pre-0.2 document — dsh imports it into its profile at the next boot" };
  if (prof.name) {
    const file = dshPatchPath(prof.name);
    return { kind: "patch", file, profile: prof.name, note: prof.note, fresh: !existsSync(file) };
  }
  if (prof.names.length > 1 && !create)
    return { kind: "empty", note: prof.note };
  return { kind: "legacy", file: DSH_SETTINGS, profile: null, fresh: true, note: "no dsh profile yet — writing settings.yaml, which dsh imports on its first boot" };
}

function dshState({ create = false } = {}) {
  const s = dshSurface({ create });
  if (s.kind === "empty") return { kind: "empty", note: s.note };
  const text = existsSync(s.file) ? readFileSync(s.file, "utf8") : "";
  const parsed = s.kind === "legacy" ? parseDshSettings(text) : parseDshPatch(text);
  return { ...s, text, parsed, error: parsed.error, providers: parsed.providers };
}

// a home-level cordis.patch.yml applies after every profile patch and would
// shadow what provider-sync edits; never fight it, report it
function dshHomeOverride() {
  if (!existsSync(DSH_HOME_PATCH)) return null;
  const p = parseDshPatch(readFileSync(DSH_HOME_PATCH, "utf8"));
  if (p.error) return { file: DSH_HOME_PATCH, why: `cannot read ${disp(DSH_HOME_PATCH)} (${p.error})` };
  if (p.present) return { file: DSH_HOME_PATCH, why: `${disp(DSH_HOME_PATCH)} targets llm-pi-ai too, and a home-level patch wins over the profile's` };
  return null;
}

function dshNotes(st) {
  const notes = [];
  if (st.note) notes.push(st.note);
  if (st.fresh) notes.push("cordis.patch.yml does not exist yet — it appears on the first dsh boot, or on the next provider-sync write");
  if (st.parsed?.disabled) notes.push("the llm-pi-ai patch item is disabled: true — configuration has no effect until it is enabled");
  const ov = dshHomeOverride();
  if (ov) notes.push(`${ov.why}${ov.why.startsWith("cannot read") ? "" : " — it is the live config, not this file"}`);
  if (existsSync(DSH_IMPORTED))
    notes.push("settings.yaml.imported exists — the one-time import already ran, and a section left in it was rejected by dsh at boot (it is not live)");
  return notes;
}

// dsh key resolution, in dsh's own order: a route that names apiKeyEnv resolves
// that reference (launch environment, then the stored .credentials.yaml, then
// ~/.dsh/.env); a route that names none authenticates from its own record in
// the store (`llm-pi-ai/<route>`, what a sign-in writes). Values are never
// printed.
const DSH_RECORD_SCOPE = "llm-pi-ai";
const dshStore = once(() => {
  if (!existsSync(DSH_STORE)) return { refs: new Map(), records: new Map(), error: null };
  try { return parseDshStore(readFileSync(DSH_STORE, "utf8")); }
  catch (e) { return { refs: new Map(), records: new Map(), error: e.message }; }
});
const dshHomeEnv = once(() => {
  const env = {};
  const f = path.join(DSH_HOME, ".env");
  if (existsSync(f))
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  return env;
});
// one credential reference, resolved exactly as dsh's reference seam resolves it
function dshResolveRef(ref) {
  if (process.env[ref]) return { state: "env", ref, key: process.env[ref] };
  const hit = dshStore().refs.get(ref);
  if (hit?.value) return { state: "stored", ref, key: hit.value };
  if (hit?.opaque) return { state: "opaque", ref };
  const home = dshHomeEnv()[ref];
  if (home) return { state: "envfile", ref, key: home };
  return { state: "unset", ref };
}
// the credential route `pid` would actually send: an apiKeyEnv reference when
// the entry names one (it wins — dsh passes it to pi-ai as an explicit
// override), otherwise the route's own stored record
function dshKeyOf(p, pid) {
  const ref = typeof p?.apiKeyEnv === "string" && p.apiKeyEnv ? p.apiKeyEnv : null;
  if (ref) return dshResolveRef(ref);
  if (!pid) return { state: "none" };
  // a record id is a lowercase hyphenated identifier (dsh's own rule), so a
  // route named any other way cannot address one
  if (!/^[a-z][a-z0-9-]*$/.test(pid)) return { state: "none" };
  const rec = dshStore().records.get(`${DSH_RECORD_SCOPE}/${pid}`);
  if (!rec) return { state: "none" };
  if (rec.kind === "grant" || (rec.kind !== "api-key" && !rec.opaque && !rec.key && !rec.env?.length))
    return { state: "grant", ref: `${DSH_RECORD_SCOPE}/${pid}` };
  if (rec.key) return { state: "record", ref: `${DSH_RECORD_SCOPE}/${pid}`, key: rec.key };
  if (rec.opaque) return { state: "opaque", ref: `${DSH_RECORD_SCOPE}/${pid}` };
  // an api-key record may name the references its value lives under instead
  for (const name of rec.env || []) {
    const hit = dshResolveRef(name);
    if (hit.key) return { state: "record", ref: `${DSH_RECORD_SCOPE}/${pid}`, via: name, key: hit.key };
  }
  return { state: "unset", ref: `${DSH_RECORD_SCOPE}/${pid}` };
}
function dshKeyLabel(p, pid) {
  const k = dshKeyOf(p, pid);
  if (k.state === "env") return `key (env ${k.ref})`;
  if (k.state === "stored") return "key (stored)";
  if (k.state === "envfile") return "key (.dsh/.env)";
  if (k.state === "record") return k.via ? `key (dsh record, via ${k.via})` : "key (dsh sign-in record)";
  if (k.state === "unset") return `no-key (${k.ref} unset here)`;
  if (k.state === "opaque") return `key (${k.ref} is multi-line — cannot read)`;
  if (k.state === "grant") return "key (signed in by dsh, stored as a grant — not readable here)";
  if (k.state === "none") return "no-key (no apiKeyEnv, no stored record)";
  return "key";
}

// the credentials store: only ever add or replace single-line refs; dsh
// refuses to load a store that is not owner-only, so the file is chmod 600
function dshStoreSet(name, value) {
  const existed = existsSync(DSH_STORE);
  const text = existed ? readFileSync(DSH_STORE, "utf8") : "";
  const out = setDshStoreRef(text, name, value);
  const bak = DSH_STORE + ".bak-provider-sync-" + stamp();
  try {
    if (existed) {
      copyFileSync(DSH_STORE, bak);
      try { pruneBackups(DSH_STORE); } catch {}
    }
    atomicWrite(DSH_STORE, out.text, 0o600);
  } catch (e) {
    throw new Error(`cannot write ${disp(DSH_STORE)}: ${e.message}`);
  }
  const back = parseDshStore(readFileSync(DSH_STORE, "utf8"));
  if (back.refs.get(name)?.value !== value) {
    if (existed) copyFileSync(bak, DSH_STORE);
    throw new Error(`the key did not land in ${disp(DSH_STORE)} — provider-sync cannot claim it is stored`);
  }
  return existed ? path.basename(bak) : null;
}

// re-read what was written and compare provider-by-provider; a mismatch means
// the surgical edit produced something we do not understand, so the backup is
// put back and the caller is told
function verifyDshWrite(file, kind, want) {
  if (!existsSync(file)) return "the file disappeared after the write";
  const p = kind === "legacy" ? parseDshSettings(readFileSync(file, "utf8")) : parseDshPatch(readFileSync(file, "utf8"));
  if (p.error) return `the written file no longer parses (${p.error})`;
  const got = p.providers ?? {};
  const sig = (m) => JSON.stringify(Object.fromEntries(Object.entries(m).map(([id, v]) => [id, (Array.isArray(v?.models) ? v.models : []).map((x) => [x?.id ?? null, x?.contextWindow ?? null])])));
  if (Object.keys(got).length !== Object.keys(want).length)
    return `provider count changed (${Object.keys(want).length} -> ${Object.keys(got).length})`;
  if (sig(got) !== sig(want)) return "the providers did not land as written";
  return null;
}
function writeDshFile(file, text, kind, want) {
  const existed = existsSync(file);
  const bak = file + ".bak-provider-sync-" + stamp();
  try {
    if (existed) {
      copyFileSync(file, bak);
      try { pruneBackups(file); } catch {}
    }
    atomicWrite(file, text);
  } catch (e) {
    throw new Error(`cannot write ${disp(file)}: ${e.message}`);
  }
  const bad = verifyDshWrite(file, kind, want);
  if (bad) {
    if (existed) copyFileSync(bak, file);
    else { try { unlinkSync(file); } catch {} }
    throw new Error(`${bad} — ${disp(file)} was ${existed ? `restored from ${path.basename(bak)}` : "left as it was"}`);
  }
  return existed ? path.basename(bak) : null;
}
// provider entries as dsh parses them must be mappings; models must be a list
function dshProvidersOf(st) {
  if (st.error) throw new Error(st.error);
  return st.providers && typeof st.providers === "object" && !Array.isArray(st.providers) ? { ...st.providers } : {};
}
// dsh serves a route from its installed catalog and lets `modelOverrides` tune
// the entries of it; a `models` list *replaces* that catalog, and dsh refuses
// the combination ("sets modelOverrides ... beside a models list"), which takes
// the whole route out of every picker. Writing the list under such an entry
// would therefore break a working route, so it is reported instead.
const dshOverridesOnly = (p) =>
  !!p && typeof p === "object" && p.modelOverrides && typeof p.modelOverrides === "object" &&
  Object.keys(p.modelOverrides).length > 0 &&
  !(Array.isArray(p.models) && p.models.length > 0);
const DSH_OVERRIDES_WHY = (id) => `the entry "${id}" tunes the installed catalog with modelOverrides and lists no models; dsh refuses a models list beside modelOverrides — declare the fields on its model entries, or drop modelOverrides, by hand`;
const dshWrite = (st, providers) => {
  const text = st.kind === "patch" && st.fresh ? PATCH_HEADER.join("\n") + "\n" : st.text;
  return st.kind === "legacy" ? writeDshSettings(text, providers) : writeDshPatch(text, providers);
};

// create or update an llm-pi-ai provider so `add` reaches every installed
// harness. Matched by base URL first (re-running updates instead of
// duplicating), then by id (a moved server re-points its entry).
export function dshUpsert({ id, name, base, keyRaw, keyFlag, keyEnvFlag, models, dryRun, create }) {
  if (!existsSync(DSH_HOME) && !create)
    return { status: "absent", why: `dsh not installed (${disp(DSH_HOME)} not found)` };
  const st = dshState({ create: !!create });
  if (st.kind === "empty") return { status: "empty", why: st.note || `nothing configured under ${disp(DSH_HOME)}` };
  if (st.error) return { status: "refused", why: st.error, file: st.file };
  const ov = dshHomeOverride();
  if (ov) return { status: "overridden", why: ov.why };
  const providers = dshProvidersOf(st);
  const nb = normUrl(base);
  let pid = Object.keys(providers).find((k) => providers[k]?.baseURL && normUrl(providers[k].baseURL) === nb);
  let note = null;
  if (pid && pid !== id) note = `matched the existing entry "${pid}" by base URL — updating it`;
  else if (!pid) pid = id;
  const old = providers[pid] && typeof providers[pid] === "object" ? providers[pid] : {};
  const existed = !!providers[pid];
  const n = models.length;
  if (dshOverridesOnly(old)) return { status: "refused", why: DSH_OVERRIDES_WHY(pid), file: st.file };
  // the key: keep the entry's existing reference when there is one; a new
  // provider follows dsh's own UI convention <ID_UPPER>_API_KEY. --key-env
  // wins, an {env:VAR} reference borrowed from OpenCode is kept as a ref too.
  const hasRef = typeof old.apiKeyEnv === "string" && old.apiKeyEnv ? old.apiKeyEnv : null;
  let ref = keyEnvFlag || hasRef || dshRefName(pid);
  let storeValue = null;
  let storeNote = null;
  // a route dsh authenticated through its own stored record (a sign-in)
  // keeps that credential: naming an apiKeyEnv here would override it — with
  // the stored reference if one exists, otherwise with a MISSING_CREDENTIAL
  const record = dshKeyOf(old, pid);
  const recordAuth = !hasRef && !!record.ref;
  if (keyFlag) storeValue = keyFlag;
  else if (!keyEnvFlag && keyRaw) {
    const er = envRef(keyRaw);
    if (er) ref = er;
    else storeValue = keyRaw;
  }
  if (!storeValue && !keyEnvFlag && !envRef(keyRaw)) {
    if (hasRef) storeNote = `kept the entry's own reference ${hasRef} — pass --key K to change it`;
    else if (recordAuth) storeNote = `kept the credential dsh stored for "${pid}" (${record.ref}) — pass --key K to replace it`;
    else {
      // an OpenAI-compatible route with no resolvable key fails every request
      // (MISSING_CREDENTIAL), so a keyless server gets the conventional
      // placeholder — but never over a value the store already holds
      const src = dshKeyOf({ apiKeyEnv: ref });
      if (src.state === "unset") {
        storeValue = "dummy";
        storeNote = `no key known for ${ref} — storing "dummy" (an OpenAI-compatible route needs one)`;
      }
    }
  }
  // a record-authenticated route keeps no apiKeyEnv: dsh resolves its own
  // credential, and an unset reference would override it with a failure
  const useRef = !(recordAuth && !keyEnvFlag && !storeValue && !hasRef && !envRef(keyRaw));
  const curModels = Array.isArray(old.models) ? old.models : [];
  const curById = new Map(curModels.map((m) => [m?.id, m]));
  let added = 0, changed = 0;
  const newModels = [];
  for (const m of models) {
    const c = curById.get(m.id);
    if (!c) { newModels.push({ id: m.id, ...(m.ctx != null ? { contextWindow: m.ctx } : {}) }); added++; continue; }
    curById.delete(m.id);
    if (m.ctx != null && c.contextWindow !== m.ctx) { newModels.push({ ...c, contextWindow: m.ctx }); changed++; }
    else newModels.push(c);
  }
  const removed = curById.size;
  const entry = {
    ...old,
    api: old.api || "openai-completions",
    baseURL: base,
    displayName: flags.name ? name : old.displayName || name,
    models: newModels,
  };
  // no apiKeyEnv at all on a record-authenticated route: the field is omitted,
  // not written as null
  if (useRef) entry.apiKeyEnv = ref;
  else delete entry.apiKeyEnv;
  providers[pid] = entry;
  const res = {
    status: existed ? "updated" : "created",
    pid, n, ref: useRef ? ref : null,
    store: storeValue ? (storeValue === "dummy" ? "dummy" : "key") : null,
    file: st.file, kind: st.kind,
    added, changed, removed,
    // both notes can apply at once (an entry matched by base URL that also keeps a
    // credential); report them together rather than dropping the second
    note: [note, storeNote].filter(Boolean).join("; ") || null,
  };
  if (dryRun) return res;
  try {
    if (storeValue) dshStoreSet(ref, storeValue); // before the config: a ref must never dangle
    const out = dshWrite(st, providers);
    writeDshFile(st.file, out.text, st.kind, providers);
  } catch (e) {
    return { status: "error", why: e.message, pid, ref, file: st.file };
  }
  return res;
}

async function syncDsh({ apply }) {
  if (!existsSync(DSH_HOME)) { console.log(`dsh (${disp(DSH_HOME)}): not found — skipped`); return { status: "absent", why: "not installed" }; }
  const st = dshState();
  if (st.kind === "empty") { console.log(`dsh (${disp(DSH_HOME)}): ${st.note || "no profile and no settings.yaml — nothing configured"} — skipped`); return { status: "empty", why: st.note || "nothing configured" }; }
  const label = st.kind === "legacy" ? `${disp(st.file)} (pre-0.2 document)` : `${disp(st.file)} (profile ${st.profile})`;
  if (st.error) { console.log(`dsh (${label}): ${st.error} — skipped`); return { status: "refused", why: st.error }; }
  const ov = dshHomeOverride();
  if (ov) { console.log(`dsh (${label}): ${ov.why} — skipped`); return { status: "overridden", why: ov.why }; }
  const providers = dshProvidersOf(st);
  const ids = Object.keys(providers);
  console.log(`dsh (${label}): ${ids.length} provider(s)`);
  for (const nt of dshNotes(st)) console.log(`  note: ${nt}`);
  if (!ids.length) return { status: "empty", why: "no providers configured" };
  if (st.parsed?.disabled) console.log("  note: llm-pi-ai is disabled — writing through is still possible, but dsh will not apply it");
  const DEFAULT_CTX = 262144; // dsh's provider default when contextWindow is unset
  // probe all providers in parallel, then report in config order
  const rs = await Promise.all(ids.map(async (id) => {
    const p = providers[id];
    if (!p || typeof p !== "object") return { id, skip: "the entry is not a mapping" };
    if (dshOverridesOnly(p)) return { id, skip: DSH_OVERRIDES_WHY(id) };
    if (!p.baseURL) return { id, skip: "no baseURL (catalog provider)" };
    const k = dshKeyOf(p, id);
    const runKey = k.key || flags.key || null; // --key stands in for this run only
    const pr = await probeCached(p.baseURL, runKey);
    if (pr.kind === "offline") return { id, base: p.baseURL, offline: pr.error || "HTTP " + pr.status };
    if (pr.kind === "auth") return { id, base: p.baseURL, badauth: true, k, supplied: !k.key && !!flags.key };
    try { return { id, base: p.baseURL, kind: pr.kind, server: await fetchModels(pr, p.baseURL, runKey) }; }
    catch (e) { return { id, base: p.baseURL, err: e.message }; }
  }));
  let changes = 0;
  const edits = [];
  for (const r of rs) {
    if (r.skip) { console.log(`  ${r.id}: ${r.skip} — skipped`); continue; }
    if (r.offline) { console.log(`  ${r.id} (${r.base}): OFFLINE (${r.offline}) — skipped`); continue; }
    if (r.badauth) {
      console.log(r.supplied
        ? `  ${r.id} (${r.base}): AUTH 401 — the key passed with --key was rejected — check it`
        : r.k.state === "grant"
          ? `  ${r.id} (${r.base}): AUTH 401 — it is signed in through ${r.k.ref}, a grant provider-sync cannot read or send; check the sign-in, or pass --key K to check this server`
          : r.k.state === "unset"
            ? `  ${r.id} (${r.base}): AUTH 401 — its key is ${r.k.ref}, which is not set here (checked the environment, ${disp(DSH_STORE)} and ~/.dsh/.env); export it or pass --key K`
            : r.k.state === "opaque"
              ? `  ${r.id} (${r.base}): AUTH 401 — ${r.k.ref} is stored as a multi-line value provider-sync cannot read; pass --key K to check this server`
              : `  ${r.id} (${r.base}): AUTH 401 — key missing or invalid`);
      continue;
    }
    if (r.err) { console.log(`  ${r.id} (${r.base}): ERROR — ${r.err}`); continue; }
    const p = providers[r.id];
    const cur = Array.isArray(p.models) ? p.models : [];
    const live = r.server.filter((m) => !m.skip).map((m) => ({ id: m.id, ctx: m.ctx ?? null }));
    const curById = new Map(cur.map((m) => [m?.id, m]));
    const liveIds = new Set(live.map((m) => m.id));
    const added = live.filter((m) => !curById.has(m.id));
    const removed = cur.filter((m) => !liveIds.has(m?.id));
    // a missing contextWindow means dsh's provider default applies, so compare
    // against the effective value — that is what pinning would change
    const eff = (c) => c.contextWindow ?? p.defaultContextWindow ?? DEFAULT_CTX;
    const ctxCh = live.filter((m) => { const c = curById.get(m.id); return c && m.ctx != null && eff(c) !== m.ctx; });
    console.log(`  ${r.id} (${r.kind}, ${r.base}): ${live.length} on server, ${cur.length} in config`);
    for (const a of added) console.log(`    + ${a.id}`);
    for (const a of removed) console.log(`    - ${a.id} (no longer on server)`);
    for (const c of ctxCh) console.log(`    ~ ctx ${c.id}: ${curById.get(c.id).contextWindow ?? `default ${eff(curById.get(c.id))}`} -> ${c.ctx}`);
    if (!added.length && !removed.length && !ctxCh.length) { console.log("    in sync"); continue; }
    changes += added.length + removed.length + ctxCh.length;
    edits.push({ id: r.id, live });
  }
  if (!edits.length) return { status: "in-sync", n: ids.length };
  if (!apply) { console.log(`  ${changes} change(s) pending — re-run with --apply to write`); return { status: "pending", changes }; }
  const next = { ...providers };
  for (const ed of edits) {
    const p = next[ed.id];
    const cur = Array.isArray(p.models) ? p.models : [];
    const curById = new Map(cur.map((m) => [m?.id, m]));
    const models = [];
    for (const m of ed.live) {
      const c = curById.get(m.id);
      if (!c) models.push({ id: m.id, ...(m.ctx != null ? { contextWindow: m.ctx } : {}) });
      else if (m.ctx != null) models.push({ ...c, contextWindow: m.ctx });
      else models.push(c);
    }
    next[ed.id] = { ...p, models };
  }
  const out = dshWrite(st, next);
  const bak = writeDshFile(st.file, out.text, st.kind, next);
  console.log(`  APPLIED ${changes} change(s)${bak ? ` — backup at ${bak}` : ""}`);
  return { status: "applied", changes, providers: edits.length, file: st.file };
}

// ---------- validation ----------
const MODS = new Set(["text", "image", "audio", "video", "pdf"]);
// keys provider-sync itself writes into a legacy model entry; native 2.x
// entries have OpenCode's own (larger) schema, so the unknown-key check is
// legacy-only
const MODEL_KEYS = new Set(["name", "attachment", "modalities", "limit", "tool_call", "reasoning", "options"]);
function validate(cfg) {
  const errs = [];
  for (const pid of providerIds(cfg)) {
    const { shape, entry } = providerShape(cfg, pid);
    const boxes = (m) => (shape === "native" ? m.capabilities : m.modalities);
    for (const k of Object.keys(entry?.models || {})) {
      const m = entry.models[k];
      if (shape === "legacy")
        for (const key of Object.keys(m)) if (!MODEL_KEYS.has(key)) errs.push(`${pid}/${k}: unknown model key "${key}"`);
      if (m.limit && (!m.limit.context || !m.limit.output)) errs.push(`${pid}/${k}: limit needs context+output`);
      for (const side of ["input", "output"])
        for (const v of boxes(m)?.[side] || []) if (!MODS.has(v)) errs.push(`${pid}/${k}: bad modality "${v}"`);
      if (boxes(m)?.input && !boxes(m).input.includes("text")) errs.push(`${pid}/${k}: input must include "text"`);
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
  const out = numFlag(flags.output, 1) ?? 65536;
  const cfg = loadCfg();
  const { shape, entry: p } = providerShape(cfg, pid);
  if (!p) die(`unknown provider "${pid}" (see provider-sync list)`);
  const base = entryBaseURL(shape, p);
  const own = credentialFor(pid, loadAuth(), cfg);
  const key = own.key || flags.key || null;
  const pr = await probeCached(base, key);
  if (pr.kind === "auth" && own.state !== "value")
    die(flags.key ? `${base} rejected the supplied key (HTTP 401) — check it, nothing has been written`
      : own.state === "unresolved"
        ? `${base} requires auth — the key in the config is ${own.ref}, which is not set in this environment
export it or pass it for this run: provider-sync set-ctx ${pid} --key K`
        : `${base} needs a key that provider-sync cannot read (OpenCode ${authInDb ? "keeps credentials in its database" : "has none for " + pid})
pass it for this run: provider-sync set-ctx ${pid} --key K`);
  if (pr.kind === "offline" || pr.kind === "auth") die(`cannot reach ${base}: ${pr.error || "HTTP " + pr.status}`);
  let server;
  try { server = await fetchModels(pr, base, key); } catch (e) { die(e.message); }
  const byId = Object.fromEntries(server.map((m) => [m.id, m]));
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
  if (changed) {
    if (flags["dry-run"]) console.log(`dry-run: ${changed} ctx value(s) would be updated (nothing written)`);
    else { saveCfg(cfg); reportValidate(cfg); console.log(`updated ${changed} ctx value(s)`); }
  }
  else console.log("no changes");
}

// ---------- commands ----------
function cmdList() {
  const target = flags.target || "all";
  if (!["all", "opencode", "hermes", "dsh"].includes(target)) die(`bad --target "${target}" (all|opencode|hermes|dsh)`);
  if (flags.profile !== undefined && target !== "all" && target !== "dsh")
    die(`--profile is only for the dsh target — it does nothing for --target ${target}`);
  const haveOc = existsSync(CFG);
  const cfg = haveOc ? loadCfg() : {}; // absent config is not an error here
  const auth = loadAuth();
  if (target === "all" || target === "opencode") {
    if (!haveOc) console.log(`opencode  ${disp(CFG)}: not found — skipped`);
    else {
      console.log(`opencode  ${disp(CFG)}`);
      const ids = providerIds(cfg);
      if (!ids.length) console.log("  (no providers)");
      for (const id of ids) {
        const { shape, entry } = providerShape(cfg, id);
        const n = Object.keys(entry?.models || {}).length;
        // `providers` entries are the 2.x-native shape (provider-sync edits them in place)
        const mark = shape === "native" ? " (2.x)" : "";
        console.log(`  ${(id + mark).padEnd(20)} ${String(n).padStart(3)} models  ${(entryBaseURL(shape, entry) || "-")}  ${credentialLabel(credentialFor(id, auth, cfg))}`);
      }
    }
  }
  if (authInDb && (target === "all" || target === "opencode")) console.log(`keys      ${disp(authBackend.dbPath || "opencode database")}  credentials live in OpenCode's database (${authBackend.via}); provider-sync never writes it and never shows a stored value${existsSync(AUTH) ? ", and an auth.json found here was imported at migration and may be stale" : ""}`);
  if (target === "all" || target === "hermes") {
    if (!existsSync(HERMES_CFG)) console.log(`hermes  ${disp(HERMES_CFG)}: not found — skipped`);
    else {
      const h = parseHermes(readFileSync(HERMES_CFG, "utf8"));
      console.log(`hermes  ${disp(HERMES_CFG)}`);
      if (!h) console.log("  no custom_providers section — skipped");
      else if (!h.entries.length) console.log(`  custom_providers present but no entries parsed${h.unparsed ? ` (${h.unparsed} item(s) in an unexpected layout)` : ""}`);
      else {
        // partial coverage must be visible: those entries are listed nowhere
        if (h.unparsed) console.log(`  note: ${h.unparsed} item(s) in an unexpected layout — not listed, and provider-sync will not touch them`);
        for (const e of h.entries) {
          const style = e.flow ? (e.modelsOk ? " (flow style, read-only)" : " (flow style, models unreadable)") : "";
          console.log(`  ${e.name.padEnd(20)} ${String(e.models.length).padStart(3)} models  ${e.base_url || "-"}${style}  ${hermesKeySource(e, cfg, auth)}`);
        }
      }
    }
  }
  if (target === "all" || target === "dsh") {
    if (!existsSync(DSH_HOME)) console.log(`dsh       ${disp(DSH_HOME)}: not found — skipped`);
    else {
      const st = dshState();
      if (st.kind === "empty") console.log(`dsh       ${disp(DSH_HOME)}: no profile and no settings.yaml — nothing configured`);
      else {
        const label = st.kind === "legacy" ? `${disp(st.file)} (pre-0.2 document)` : `${disp(st.file)} (profile ${st.profile})`;
        console.log(`dsh       ${label}`);
        if (st.error) console.log(`  note: ${st.error}`);
        else {
          const ids = Object.keys(st.providers || {});
          if (!ids.length) console.log("  (no providers)");
          for (const id of ids) {
            const p = st.providers[id] && typeof st.providers[id] === "object" ? st.providers[id] : {};
            const n = Array.isArray(p.models) ? p.models.length : 0;
            console.log(`  ${id.padEnd(20)} ${String(n).padStart(3)} models  ${p.baseURL || "-"}  ${dshKeyLabel(p, id)}`);
          }
        }
        for (const nt of dshNotes(st)) console.log(`  note: ${nt}`);
      }
    }
  }
}

async function cmdAdd(id, url) {
  const base = v1Of(url);
  const a = loadAuth();
  // validate before anything is probed or stored: a bad name would become an
  // {env:...} reference nothing can resolve
  const keyEnv = flags["key-env"];
  if (keyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv))
    die(`--key-env needs an environment variable name, got "${keyEnv}"`);
  // --username/--password are one Unsloth UI login: half a pair cannot log in,
  // so it is refused up front instead of being dropped without a word
  if (!!flags.username !== !!flags.password)
    die("--username and --password must be given together (Unsloth UI login)");
  // validate numeric flags before anything is probed or stored
  const out = numFlag(flags.output, 1) ?? 65536;
  const ctxFlag = numFlag(flags.ctx);
  const storedCfg = existsSync(CFG) ? loadCfg() : null;
  const storedKey = configApiKey(storedCfg, id); // raw: may be a {env:VAR} reference
  let key = flags.key || storedKey || a[id]?.key || null; // the key to keep/store
  // probe with the literal --key, the stored key with {env:VAR} resolved from
  // this environment, or the value --key-env names when it is set here
  const probeKey = derefKey(key) || (keyEnv ? derefKey(`{env:${keyEnv}}`) : null);
  const pr = await probeCached(base, probeKey);
  if (pr.kind === "offline") die(`cannot reach ${base}: ${pr.error || "HTTP " + pr.status}`);
  if (pr.kind === "auth")
    die(probeKey ? `${base} rejected the supplied key (HTTP 401) — check the server's api key, nothing was written`
        : key ? `${base} requires auth — the stored key is ${key}, which is not set in this environment; export it or pass --key K`
        : `${base} requires auth — pass --key K (or --username U --password P for Unsloth UI)`);
  let runKey = probeKey; // credential used for this run's requests
  // the pair is never a silent no-op: when it cannot be used, the report says why
  const loginGiven = !!flags.username && !!flags.password; // both, or neither (checked above)
  const loginSkip = loginGiven && pr.kind !== "unsloth"
    ? `--username/--password not used — the server was detected as ${pr.kind}, not Unsloth UI, so no login was attempted`
    : loginGiven && runKey ? "--username/--password not used — an API key is already available" : null;
  if (loginGiven && pr.kind === "unsloth" && !runKey) {
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

  const notes = [];
  if (loginSkip) notes.push(loginSkip);
  const mode = flags["dry-run"] ? "report" : "write";
  // a harness is written only if it is installed on this machine; --target
  // opencode is the explicit way to create an OpenCode config where there is none
  const target = flags.target || "all";
  if (!["all", "opencode", "hermes", "dsh"].includes(target)) die(`bad --target "${target}" (all|opencode|hermes|dsh)`);
  if (flags["no-hermes"] && (target === "hermes" || target === "dsh"))
    die(`--no-hermes conflicts with --target ${target} — pick one`);
  if (flags.profile !== undefined && target !== "all" && target !== "dsh")
    die(`--profile is only for the dsh target — it does nothing for --target ${target}`);
  const haveOcFile = existsSync(CFG);
  // --no-hermes keeps its documented meaning (--target opencode), so dsh is
  // not selected either; --target names exactly what is written
  const skipHermes = !!flags["no-hermes"] || target === "opencode" || target === "dsh";
  const skipDsh = !!flags["no-hermes"] || target === "opencode" || target === "hermes";
  const wantOc = (target === "all" || target === "opencode") && (haveOcFile || target === "opencode");
  const wantH = !skipHermes && existsSync(HERMES_CFG);
  const wantD = !skipDsh && (target === "dsh" || existsSync(DSH_HOME));
  // why a target was skipped: "not chosen" and "not installed" are different problems
  const ocWhy = target === "opencode" || target === "all" ? (haveOcFile ? "" : "opencode is not installed here")
    : `not selected (--target ${target})`;
  const hWhy = flags["no-hermes"] ? "disabled with --no-hermes"
    : target === "opencode" || target === "dsh" ? `not selected (--target ${target})`
    : wantH ? "" : "hermes is not installed here";
  const dWhy = flags["no-hermes"] ? "disabled with --no-hermes"
    : target === "opencode" || target === "hermes" ? `not selected (--target ${target})`
    : wantD ? "" : "dsh is not installed here";
  const fresh = wantOc && !existsSync(CFG);
  const cfg = wantOc ? loadCfgOrEmpty() : { provider: {} };
  // the provider is updated in the shape its entry already uses; a new one
  // follows the file's dialect (see providerShape)
  const { shape, entry } = providerShape(cfg, id);
  const oldProv = entry || {};
  if (cfg.providers?.[id] && cfg.provider?.[id])
    notes.push(`${id} exists in both "provider" and "providers" — OpenCode 2.x uses providers.${id}; updating that entry`);
  const ctxMap = await resolveCtxs(server, { ctxFlag, mode, notes, existing: Object.keys(oldProv.models || {}) });
  const res = reconcile(oldProv.models || {}, server, { out, ctxMap, notes, shape });
  // --key stores a literal secret; --key-env stores a {env:VAR} reference so the
  // secret stays out of a file that people commit
  const keyValue = key ? key : keyEnv ? `{env:${keyEnv}}` : null;
  const keyWhere = keyValue ? configApiKeyPaths(cfg, id) : [];
  const prov = shape === "native"
    ? {
        ...oldProv, // preserve any user-added fields (env, canonical, headers, ...)
        name: flags.name || oldProv.name || id,
        package: oldProv.package || "@opencode/ai/providers/openai-compatible",
        settings: { ...(oldProv.settings || {}), baseURL: base },
        models: res.models,
      }
    : {
        ...oldProv, // preserve any user-added provider-level fields
        name: flags.name || oldProv.name || id,
        npm: oldProv.npm || "@ai-sdk/openai-compatible",
        options: { ...(oldProv.options || {}), baseURL: base },
        models: res.models,
      };
  if (shape === "native") { cfg.providers = cfg.providers || {}; cfg.providers[id] = prov; }
  else { cfg.provider = cfg.provider || {}; cfg.provider[id] = prov; }
  console.log(`${id} (${pr.kind}, ${base}): ${Object.keys(prov.models).length} models`);
  for (const a of res.added) console.log(`  + ${a}`);
  for (const a of res.removed) console.log(`  - ${a} (no longer on server)`);
  for (const [m, o, n] of res.ctx) console.log(`  ~ ctx ${m}: ${o} -> ${n}`);
  for (const [m, o, n] of res.mods) console.log(`  ~ modalities ${m}: [${o}] -> [${n}]`);
  if (!res.added.length && !res.removed.length && !res.ctx.length && !res.mods.length) console.log("  up to date");
  for (const nt of notes) console.log("  note: " + nt);

  const hmodels = server.filter((m) => !m.skip).map((m) => ({ id: m.id, ctx: m.ctx ?? null }));
  // the raw value matters here: {env:VAR} stays a reference, which hermesUpsert
  // turns into key_env instead of copying OpenCode's syntax
  const hkey = key || configApiKey(cfg, id) || a[id]?.key || keyValue;
  const hmodel = flags.model || hmodels[0]?.id || null;
  const hargs = { name: prov.name, base, key: hkey, model: hmodel, models: hmodels };
  // dsh has its own credential store; the same raw key value is passed so an
  // {env:VAR} reference stays a reference (apiKeyEnv) instead of becoming a
  // literal secret in .credentials.yaml
  const dargs = { id, name: prov.name, base, keyRaw: hkey, keyFlag: flags.key || null, keyEnvFlag: keyEnv || null, models: hmodels, create: wantD };
  const nModels = Object.keys(prov.models).length;
  // every target is reported afterwards: what was written and what was skipped, and why
  const ocLine = (verb) => wantOc
    ? `provider "${id}" (${nModels} models${fresh ? ", new config file" : ""}${verb ? ", " + verb : ""})`
    : `skipped — ${ocWhy}`;
  const keysLine = (verb) => {
    if (!wantOc) return `skipped — ${ocWhy}`;
    if (!keyValue) return "no change (no --key)";
    return `api key for "${id}" in ${disp(CFG)} ${keyWhere.join(" + ")}${verb ? ", " + verb : ""}`;
  };
  const hermesLine = (r, verb) => {
    if (!wantH) return `skipped — ${hWhy}`;
    if (["absent", "no-section", "unparsed", "layout", "flow", "error"].includes(r.status)) return `skipped — ${r.why}`;
    return `custom_providers "${r.name}" ${verb}${r.status} (${r.n} models, model: ${hmodel || "-"})`;
  };
  const dshSkip = (r) => !wantD || !r || ["absent", "empty", "refused", "overridden", "error"].includes(r.status);
  const dshLine = (r, verb) => {
    if (!wantD) return `skipped — ${dWhy}`;
    if (dshSkip(r)) return `skipped — ${r.why}`;
    const key = r.ref ? `, key ref ${r.ref}` : ", key kept as dsh stored it";
    return `provider "${r.pid}" ${verb}${r.status} (${r.n} models${key})`;
  };
  const dshKeysLine = (r, dry) => {
    if (!wantD) return `skipped — ${dWhy}`;
    if (dshSkip(r)) return "skipped — dsh was not written";
    if (!r.store) return "no change (no key to store)";
    const what = r.store === "dummy" ? `set to "dummy" (the server needs no auth)` : "stored";
    return `key "${r.ref}" ${dry ? "would be " + what : what}`;
  };
  let hres = { status: "off", why: hWhy };
  if (wantH) hres = hermesUpsert({ ...hargs, dryRun: true });
  let ddres = { status: "off", why: dWhy };
  if (wantD) {
    try { ddres = dshUpsert({ ...dargs, dryRun: true }); }
    catch (e) { ddres = { status: "error", why: e.message }; }
  }

  if (flags["dry-run"]) {
    console.log("dry-run: nothing written. Would write:");
    console.log(`  opencode  ${disp(CFG)}  ${ocLine("would be written")}`);
    console.log(`  keys      ${keyValue ? disp(CFG) : disp(AUTH)}  ${keysLine("would be written")}`);
    console.log(`  hermes    ${disp(HERMES_CFG)}  ${hermesLine(hres, "would be ")}`);
    console.log(`  dsh       ${disp(ddres.file || DSH_HOME)}  ${dshLine(ddres, "would be ")}`);
    console.log(`  dsh-keys  ${disp(DSH_STORE)}  ${dshKeysLine(ddres, true)}`);
    if (ddres.note) console.log("      note: " + ddres.note);
    return;
  }
  if (wantOc) {
    if (keyValue) storeConfigApiKey(cfg, id, keyValue); // before the write, not after
    saveCfg(cfg);
    if (fresh) console.log(`created ${CFG}`);
    if (!reportValidate(cfg)) process.exitCode = 1;
    else console.log(`OK — ${nModels} models in ${id}`);
    if (keyValue) {
      // read the file back: a key we cannot see in the file is a key OpenCode
      // cannot use, and claiming success would be a lie
      const back = configApiKey(loadCfg(), id);
      if (back !== keyValue) {
        console.log(`ERROR: the key did not land in ${disp(CFG)} — provider-sync cannot claim it is stored`);
        process.exitCode = 1;
      } else if (authInDb)
        console.log(`note: stored in the config instead of ${disp(authBackend.dbPath || "the database")}: OpenCode 2.x keeps its own credentials in that database and this build cannot write it without an interactive login`);
    }
  }
  if (wantH)
    try { hres = hermesUpsert({ ...hargs, dryRun: false }); }
    catch (e) { hres = { status: "error", why: `cannot write ${disp(HERMES_CFG)}: ${e.message}` }; }
  let dres = { status: "off", why: dWhy };
  if (wantD) {
    try { dres = dshUpsert({ ...dargs, dryRun: false }); }
    catch (e) { dres = { status: "error", why: e.message }; }
  }
  if (dres.note) console.log("  note: " + dres.note);
  console.log("written:");
  console.log(`  opencode  ${disp(CFG)}  ${ocLine("")}`);
  console.log(`  keys      ${keyValue ? disp(CFG) : disp(AUTH)}  ${keysLine("")}`);
  console.log(`  hermes    ${disp(HERMES_CFG)}  ${hermesLine(hres, "")}`);
  console.log(`  dsh       ${disp(dres.file || DSH_HOME)}  ${dshLine(dres, "")}`);
  console.log(`  dsh-keys  ${disp(DSH_STORE)}  ${dshKeysLine(dres, false)}`);
}

async function cmdSync() {
  const target = flags.target || "all";
  const written = [];
  if (!["all", "opencode", "hermes", "dsh"].includes(target)) die(`bad --target "${target}" (all|opencode|hermes|dsh)`);
  if (flags.provider && target !== "all" && target !== "opencode")
    die(`--provider is only for the opencode target — use --target all|opencode`);
  if (flags.profile !== undefined && target !== "all" && target !== "dsh")
    die(`--profile is only for the dsh target — it does nothing for --target ${target}`);
  // --dry-run always wins: a "report what would change" run must never write,
  // even when --apply is also on the line
  const apply = !!flags.apply && !flags["dry-run"];
  if (flags.apply && flags["dry-run"]) console.error("note: --dry-run — ignoring --apply, nothing will be written");
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
    const out = numFlag(flags.output, 1) ?? 65536;
    const ctxFlag = numFlag(flags.ctx);
    const mode = apply ? "write" : "report";
    const allIds = providerIds(cfg);
    // a named provider that is not there is a mistake, not "nothing to check"
    if (flags.provider && !allIds.includes(flags.provider))
      die(`unknown provider "${flags.provider}" (see provider-sync list)`);
    const ids = allIds.filter((id) => !disabled.has(id) && (!flags.provider || flags.provider === id));
    if (!ids.length && flags.provider)
      die(`${flags.provider} is disabled (disabled_providers in the config) — nothing to check`);
    if (!ids.length) console.log("opencode: no providers to check");
    const rs = await Promise.all(ids.map(async (id) => {
      const { shape, entry } = providerShape(cfg, id);
      if (!entry) return { id, err: "provider entry is not an object" };
      const base = entryBaseURL(shape, entry);
      if (!base) return { id, err: "no baseURL in config" };
      const own = credentialFor(id, auth, cfg);
      const key = own.key || flags.key || null; // a readable key, or one passed for this run
      const pr = await probeCached(base, key);
      if (pr.kind === "offline") return { id, offline: pr.error || "HTTP " + pr.status };
      if (pr.kind === "auth")
        return { id, badauth: true, unreadable: own.state === "stored" || own.state === "unknown",
                 unsetRef: own.state === "unresolved" ? own.ref : null, supplied: !own.key && !!flags.key };
      try { return { id, kind: pr.kind, base, server: await fetchModels(pr, base, key) }; }
      catch (e) { return { id, err: e.message }; }
    }));
    let changes = 0;
    for (const r of rs) {
      if (r.offline) { console.log(`${r.id}: OFFLINE (${r.offline}) — skipped`); continue; }
      if (r.badauth) {
        console.log(r.supplied
          ? `${r.id}: AUTH 401 — the key passed with --key was rejected — check it`
          : r.unsetRef
            ? `${r.id}: AUTH 401 — its key is ${r.unsetRef}, which is not set in this environment; export it or pass --key K`
            : r.unreadable
              ? `${r.id}: AUTH 401 — its key is in OpenCode's database and cannot be read here; pass --key K to check this server`
              : `${r.id}: AUTH 401 — key missing or invalid`);
        continue;
      }
      if (r.err) { console.log(`${r.id}: ERROR — ${r.err}`); continue; }
      const notes = [];
      const { shape: pshape, entry: pentry } = providerShape(cfg, r.id);
      const cur = pentry?.models || {};
      const ctxMap = await resolveCtxs(r.server, { ctxFlag, mode, notes, existing: Object.keys(cur) });
      const res = reconcile(cur, r.server, { out, ctxMap, notes, shape: pshape });
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
      if (apply) { pentry.models = res.models; console.log(`  APPLIED ${total} change(s)`); }
    }
    if (apply && changes) {
      try {
        saveCfg(cfg);
        reportValidate(cfg);
        written.push(`  opencode  ${disp(CFG)}  ${changes} change(s)`);
      } catch (e) {
        console.error(`error: opencode config not written: ${e.message}`);
        process.exitCode = 1;
      }
    }
    if (!apply && changes) console.log(`${changes} change(s) pending — re-run with --apply to write`);
  }
  if (target === "all" || target === "hermes") {
    let hr = null;
    try { hr = await syncHermes({ apply, ocCfg: cfg, ocAuth: auth }); }
    catch (e) {
      // e.g. an unwritable config.yaml: report it, keep going, fail the exit code
      console.error(`error: ${e.message}`);
      process.exitCode = 1;
      written.push(`  hermes    ${disp(HERMES_CFG)}  FAILED — nothing changed for this target`);
    }
    if (hr?.status === "applied") written.push(`  hermes    ${disp(HERMES_CFG)}  ${hr.changes} change(s) in ${hr.providers} provider(s)`);
    else if (hr && ["absent", "no-section", "empty"].includes(hr.status)) written.push(`  hermes    ${disp(HERMES_CFG)}  skipped — ${hr.why}`);
  }
  if (target === "all" || target === "dsh") {
    let dr = null;
    try { dr = await syncDsh({ apply }); }
    catch (e) {
      // e.g. an unwritable patch file: report it, keep going, fail the exit code
      console.error(`error: ${e.message}`);
      process.exitCode = 1;
      written.push(`  dsh       ${disp(DSH_HOME)}  FAILED — nothing changed for this target`);
    }
    if (dr?.status === "applied") written.push(`  dsh       ${disp(dr.file)}  ${dr.changes} change(s) in ${dr.providers} provider(s)`);
    else if (dr && ["absent", "empty", "refused", "overridden"].includes(dr.status)) written.push(`  dsh       ${disp(DSH_HOME)}  skipped — ${dr.why}`);
  }
  if (written.length) { console.log("written:"); for (const w of written) console.log(w); }
}

// ---------- run lock ----------
// two mutating runs at once would race on read-modify-write and on the backup
// file, so a writer takes an exclusive lock for the whole command
// kept in the temp dir, keyed by the config it guards: a run on a machine where
// OpenCode is not installed must not create ~/.config/opencode just to lock
const LOCK = path.join(os.tmpdir(), `provider-sync-${createHash("sha1").update(CFG_DIR).digest("hex").slice(0, 10)}.lock`);
export function lockHeld() {
  if (!existsSync(LOCK)) return 0;
  const pid = parseInt(readFileSync(LOCK, "utf8").trim(), 10);
  if (!pid || pid === process.pid) return 0;
  try {
    process.kill(pid, 0); // signal 0 only checks that the pid exists
    return pid;
  } catch (e) {
    return e.code === "EPERM" ? pid : 0; // alive but not ours
  }
}
export function acquireLock() {
  // two passes: the second one is only reached when the first found a stale lock
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = lockHeld();
    if (held) die(`another provider-sync run is in progress (pid ${held}) — wait for it or delete ${disp(LOCK)}`);
    try {
      const fd = openSync(LOCK, "wx"); // exclusive create: the atomic part
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // the file exists. if nobody live owns it, drop it and retry once;
      // if a live run won the race in between, refuse rather than steal its lock
      if (attempt === 1 || lockHeld())
        die(`another provider-sync run is in progress (${disp(LOCK)}) — wait for it or delete that file`);
      try { unlinkSync(LOCK); } catch {}
    }
  }
}
export function releaseLock() {
  try { unlinkSync(LOCK); } catch {}
}
// ---------- version ----------
const VERSION = (() => {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version; }
  catch { return "unknown"; }
})();

// ---------- per-command argument check ----------
// A flag that parses but means nothing for the command it is attached to must
// not silently do nothing: `sync --no-hermes` used to sync both harnesses and
// `list --key K` used to ignore the key. Each command lists what it accepts;
// everything else is refused with the right alternative when there is one.
const CMD_SPEC = {
  list: { flags: ["target", "profile"], args: 0, usage: "provider-sync list [--target all|opencode|hermes|dsh] [--profile NAME]" },
  add: {
    flags: ["name", "key", "key-env", "username", "password", "model", "target", "profile", "no-hermes", "ctx", "output", "dry-run"],
    args: 2,
    usage: "provider-sync add <id> <baseURL> [options]",
  },
  sync: {
    flags: ["apply", "dry-run", "target", "profile", "provider", "ctx", "output", "key"],
    args: 0,
    usage: "provider-sync sync [--apply] [--target all|opencode|hermes|dsh] [--provider ID] [--profile NAME]",
  },
  "set-ctx": { flags: ["output", "key", "dry-run"], args: 1, usage: "provider-sync set-ctx <provider>" },
};
const FLAG_HINTS = {
  sync: { "no-hermes": "is for add — sync narrows harnesses with --target opencode" },
  list: {
    provider: "is for sync/add — list shows every provider; use --target to narrow harnesses",
    key: "is not used by list — keys are never printed",
  },
  add: { apply: "is for sync — add always writes (use --dry-run to preview)" },
  "set-ctx": {
    target: "is not used by set-ctx — it edits one OpenCode provider in place",
    profile: "is for the dsh target — set-ctx edits one OpenCode provider in place",
  },
};
function checkCommandArgs() {
  const spec = CMD_SPEC[cmd];
  if (!spec) return; // unknown commands are refused by the dispatcher
  for (const k of Object.keys(flags)) {
    if (spec.flags.includes(k)) continue;
    const hint = FLAG_HINTS[cmd]?.[k];
    die(`--${k} ${hint || `is not an option of "provider-sync ${cmd}"`} — see provider-sync help`);
  }
  const extra = pos.length - 1 - spec.args;
  if (extra > 0) die(`unexpected argument "${pos[spec.args + 1]}" — ${spec.usage}`);
  if (extra < 0) die(`usage: ${spec.usage} — see provider-sync help`);
}

// ---------- main ----------
// run only when executed directly; importing the module (tests) must not exit
// argv[1] is however the user spelled the command: a symlink in ~/.local/bin,
// an npm bin link, a relative path. compare real paths, or every installed copy
// would silently do nothing.
const isMain = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain)
try {
  // --help / -h and --version / -v win anywhere on the line: `add --help` must
  // print help, not complain about a missing baseURL
  const wantsHelp = cmd === "help" || pos.includes("-h") || flags.help || flags.h;
  const wantsVersion = pos.includes("-v") || flags.version;
  if (wantsHelp) console.log(HELP);
  else if (wantsVersion) console.log(VERSION);
  else if (!cmd) { console.error(HELP); process.exit(1); }
  else {
    checkCommandArgs();
    if (cmd === "list") cmdList();
    else if (cmd === "add") {
      if (!flags["dry-run"]) { acquireLock(); try { await cmdAdd(pos[1], pos[2]); } finally { releaseLock(); } }
      else await cmdAdd(pos[1], pos[2]);
    } else if (cmd === "sync") {
      // a --dry-run run writes nothing, so it needs no lock
      if (flags.apply && !flags["dry-run"]) { acquireLock(); try { await cmdSync(); } finally { releaseLock(); } }
      else await cmdSync();
    } else if (cmd === "set-ctx") {
      const locked = !flags["dry-run"]; // same: a preview takes no lock
      if (locked) acquireLock();
      try { await cmdSetCtx(pos[1]); } finally { if (locked) releaseLock(); }
    } else die(`unknown command "${cmd}" — see provider-sync help`);
  }
} catch (e) { die(e.stack || e.message); }
if (isMain) process.exit(process.exitCode ?? 0);
