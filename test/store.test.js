// the config store: state must describe the file that was actually read,
// never a leftover from an earlier load in the same run
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinHomeForImport } from "./helpers.js";

const home = mkdtempSync(path.join(tmpdir(), "ps-store-"));
pinHomeForImport(home);
const { loadCfg, saveCfg, loadAuth, CFG } = await import("../bin/provider-sync.js");

const cfgPath = path.join(home, ".config/opencode/opencode.jsonc");
const writeCfg = (text) => { mkdirSync(path.dirname(cfgPath), { recursive: true }); writeFileSync(cfgPath, text); };
// die() prints and calls process.exit, which would kill the test runner
const captureErrors = (fn) => {
  const errs = [];
  const origErr = console.error, origExit = process.exit;
  console.error = (m) => errs.push(String(m));
  process.exit = (code) => { throw new Error("exit " + code); };
  try { fn(); } catch (e) { if (!/^exit /.test(e.message)) throw e; }
  finally { console.error = origErr; process.exit = origExit; }
  return errs;
};

before(() => writeCfg('{\n  "provider": {}\n}\n'));
after(() => rmSync(home, { recursive: true, force: true }));

test("a missing provider section is created on load, not on write", () => {
  writeCfg('{\n  "plugin": ["x"]\n}\n');
  assert.deepEqual(loadCfg(), { plugin: ["x"], provider: {} });
});

test("existing keys survive a load/save round trip", () => {
  writeCfg('{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {"a": {"type": "remote"}},\n  "provider": {"p": {"options": {"baseURL": "http://h/v1"}}}\n}\n');
  const cfg = loadCfg();
  cfg.provider.p.name = "p";
  saveCfg(cfg);
  const back = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(back.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(back.mcp, { a: { type: "remote" } });
  assert.equal(back.provider.p.name, "p");
});

test("the lost-comments warning fires once, for the commented load only", () => {
  const errs = captureErrors(() => {
    writeCfg('{\n  "provider": {}\n}\n');           // no comments
    loadCfg(); saveCfg(loadCfg());
    writeCfg('{\n  // user comment\n  "provider": {}\n}\n'); // comments
    loadCfg(); saveCfg(loadCfg());
    writeCfg('{\n  "provider": {}\n}\n');           // comments gone again
    loadCfg(); saveCfg(loadCfg());
  });
  const warnings = errs.filter((e) => e.includes("comments"));
  assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
});

test("a backup of the previous config is kept and rotated", () => {
  writeCfg('{\n  "provider": {"a": {}}\n}\n');
  for (let i = 0; i < 5; i++) {
    const cfg = loadCfg();
    cfg.provider["p" + i] = { options: { baseURL: `http://${i}/v1` } };
    saveCfg(cfg);
  }
  const baks = readdirSync(path.dirname(cfgPath)).filter((f) => f.startsWith("opencode.jsonc.bak-provider-sync-"));
  assert.equal(baks.length, 3, "only the newest 3 backups survive");
});

test("auth.json is validated, not just parsed", () => {
  const authPath = path.join(home, ".local/share/opencode/auth.json");
  mkdirSync(path.dirname(authPath), { recursive: true });
  writeFileSync(authPath, "[]");
  const errs = captureErrors(() => loadAuth());
  assert.equal(errs.length, 1, "expected a diagnostic, got " + JSON.stringify(errs));
  writeFileSync(authPath, "{ broken");
  const errs2 = captureErrors(() => loadAuth());
  assert.match(errs2.join("\n"), /cannot parse/);
  rmSync(authPath);
  assert.deepEqual(loadAuth(), {});
});

test("a broken config fails loudly instead of writing something", () => {
  writeCfg("{ not json at all");
  const errs = captureErrors(() => loadCfg());
  assert.match(errs.join("\n"), /cannot parse/);
});

test("the config path follows the discovered candidates", () => {
  assert.equal(CFG, cfgPath, "opencode.jsonc is the first candidate");
});