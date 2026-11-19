// provider-sync's tombstone file is as important as a harness config: losing
// it silently brings deliberately removed models back on the next sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLI, hermeticEnv, runCli } from "./helpers.js";

const homes = [];
const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-state-io-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const stateFile = (home) => path.join(home, ".config/provider-sync/state.json");

test("writing tombstones keeps a rotating backup of the previous state", () => {
  const previous = JSON.stringify({ version: 1, excluded: [{ target: "opencode", provider: "other", models: ["x"] }] }, null, 2) + "\n";
  const home = homeWith({
    ".config/opencode/opencode.jsonc": JSON.stringify({
      provider: { dropme: { models: { m1: {}, m2: {} }, options: { baseURL: "http://127.0.0.1:9/v1" } } },
    }),
    ".config/provider-sync/state.json": previous,
  });
  runCli(home, ["remove", "dropme", "--model", "m2", "--target", "opencode", "--apply"]);
  const dir = path.dirname(stateFile(home));
  const backups = readdirSync(dir).filter((f) => f.startsWith("state.json.bak-provider-sync-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(dir, backups[0]), "utf8"), previous);
  const now = JSON.parse(readFileSync(stateFile(home), "utf8"));
  assert.ok(now.excluded.some((e) => e.provider === "dropme" && e.models.includes("m2")));
  assert.ok(now.excluded.some((e) => e.provider === "other"), "the existing tombstone survives");
});

test("a corrupt state file is reported instead of silently treated as empty", () => {
  const corrupt = "{ this is not json";
  const home = homeWith({
    ".config/opencode/opencode.jsonc": '{ "provider": {} }\n',
    ".config/provider-sync/state.json": corrupt,
  });
  const r = spawnSync(process.execPath, [CLI, "list", "--target", "opencode"], {
    encoding: "utf8",
    env: hermeticEnv(home),
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /warning: .*state\.json.*(not valid JSON|unreadable)/);
  assert.match(r.stderr, /removed models may come back/i);
  assert.equal(readFileSync(stateFile(home), "utf8"), corrupt, "a read-only command does not overwrite it");
});

test.after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
