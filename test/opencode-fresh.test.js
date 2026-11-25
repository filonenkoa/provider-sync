// A fresh OpenCode 2.x install runs on the models built into the binary and
// creates no opencode.jsonc. Reporting that as "not found — skipped" reads as
// "OpenCode is not installed", which sends the user looking for an install
// problem that does not exist. A missing config next to an OpenCode data
// directory means "nothing to sync yet", and `add` is how a config appears.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCliAsyncP, flat } from "./helpers.js";

const made = [];
const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-oc-fresh-"));
  made.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
after(() => { for (const h of made) rmSync(h, { recursive: true, force: true }); });

// OpenCode 2.x creates its data directory (and database) on first run, whether
// or not the user ever writes a config.
const freshInstall = () => homeWith({ ".local/share/opencode/opencode.db": "" });
const dataEnv = (home) => ({ XDG_DATA_HOME: path.join(home, ".local/share") });

test("list explains a missing config on a fresh OpenCode install", async () => {
  const home = freshInstall();
  const out = flat(await runCliAsyncP(home, ["list"], dataEnv(home)));

  assert.match(out, /opencode \S*opencode\.jsonc: no config file/);
  assert.match(out, /built-in models/);
  assert.match(out, /provider-sync add/);
  assert.doesNotMatch(out, /opencode .*not found/);
});

test("sync reports nothing to sync on a fresh OpenCode install and writes nothing", async () => {
  const home = freshInstall();
  const out = flat(await runCliAsyncP(home, ["sync"], dataEnv(home)));

  assert.match(out, /opencode .*no config file/);
  assert.match(out, /provider-sync add/);
  assert.doesNotMatch(out, /opencode .*not found/);
  assert.equal(existsSync(path.join(home, ".config/opencode/opencode.jsonc")), false,
    "a read-only run must not create the config");
});

test("a machine with no OpenCode traces keeps the not-found line", async () => {
  const home = homeWith({ ".keep": "" });
  const out = flat(await runCliAsyncP(home, ["sync"], dataEnv(home)));

  assert.match(out, /opencode .*not found — skipped/);
});

test("a fresh install with --target opencode still asks for add instead of inventing one", async () => {
  const home = freshInstall();
  await assert.rejects(
    runCliAsyncP(home, ["sync", "--target", "opencode"], dataEnv(home)),
    /no .*opencode\.jsonc\nadd a provider first: provider-sync add <id> <baseURL>/,
  );
  assert.equal(existsSync(path.join(home, ".config/opencode/opencode.jsonc")), false);
});
