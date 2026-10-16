// argument parsing: the silent-boolean and --k=v bugs lived here
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "../bin/provider-sync.js";
import { runCli } from "./helpers.js";

// parseArgs calls die() (process.exit) on a bad flag, so assert on the good paths here
const p = (argv) => parseArgs(argv);

// "was it refused?": die() exits, capture that instead of killing the runner
const refused = (argv) => {
  const exit = process.exit, err = console.error;
  let exited = false;
  console.error = () => {};
  process.exit = () => { exited = true; throw new Error("exited"); };
  try { p(argv); } catch (e) { if (!exited) throw e; } finally { process.exit = exit; console.error = err; }
  return exited;
};

test("separates flags from positionals", () => {
  const { flags, pos } = p(["add", "id", "http://h/v1", "--key", "secret"]);
  assert.deepEqual(pos, ["add", "id", "http://h/v1"]);
  assert.equal(flags.key, "secret");
});

test("accepts --key=value as well as --key value", () => {
  assert.equal(p(["--key=secret"]).flags.key, "secret");
  assert.equal(p(["--key", "secret"]).flags.key, "secret");
  assert.equal(p(["--key="]).flags.key, "");
  assert.equal(p(["--name=a b c"]).flags.name, "a b c");
});

test("keeps a value that starts with a single dash (negative numbers)", () => {
  const { flags, pos } = p(["sync", "--ctx", "-1"]);
  assert.equal(flags.ctx, "-1");
  assert.deepEqual(pos, ["sync"]);
});

test("boolean flags take no value", () => {
  const { flags } = p(["sync", "--apply", "--dry-run", "--no-hermes", "--provider", "x"]);
  assert.equal(flags.apply, true);
  assert.equal(flags["dry-run"], true);
  assert.equal(flags["no-hermes"], true);
  assert.equal(flags.provider, "x");
});

test("everything after -- is positional", () => {
  const { flags, pos } = p(["add", "--", "--not-a-flag"]);
  assert.deepEqual(pos, ["add", "--not-a-flag"]);
  assert.deepEqual(flags, {});
});

test("a flag is never silently turned into the boolean true", () => {
  // regression: `--key` with no value used to be stored as true and written to auth.json
  for (const argv of [["--key"], ["--ctx"], ["--target"], ["add", "id", "url", "--name"]]) {
    const original = process.exit;
    let msg = null;
    process.exit = () => { throw new Error("exited"); };
    try { p(argv); assert.fail(`expected ${JSON.stringify(argv)} to be rejected`); }
    catch (e) {
      assert.equal(e.message, "exited");
      msg = e;
    } finally { process.exit = original; }
    assert.ok(msg);
  }
});

test("a boolean flag refuses a value instead of reading as true", () => {
  // regression: --apply=false applied every pending change (any string is truthy)
  assert.equal(refused(["sync", "--apply=false"]), true);
  assert.equal(refused(["sync", "--dry-run=0"]), true);
  assert.equal(p(["sync", "--apply"]).flags.apply, true, "the plain form still works");
});

test("an unknown flag is refused instead of silently ignored", () => {
  // regression: --targe=hermes was swallowed, the default target was applied
  // and both harnesses were written
  assert.equal(refused(["sync", "--targe", "hermes"]), true);
  assert.equal(refused(["sync", "--targe=hermes"]), true);
  assert.equal(refused(["add", "id", "url", "--dryrun"]), true);
  assert.equal(p(["sync", "--target", "hermes"]).flags.target, "hermes", "known flags still work");
});

test("an empty or negative numeric flag is refused, not read as 0", () => {
  // regression: --ctx= meant "omit the limit" and --ctx -1 was dropped
  const home = mkdtempSync(path.join(tmpdir(), "ps-flags-"));
  try {
    mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
    writeFileSync(path.join(home, ".config/opencode/opencode.jsonc"), '{ "provider": {} }\n');
    assert.throws(() => runCli(home, ["sync", "--target", "opencode", "--ctx="]), /numeric flag needs a value/);
    assert.throws(() => runCli(home, ["sync", "--target", "opencode", "--ctx", "-1"]), /bad number/);
    assert.throws(() => runCli(home, ["sync", "--target", "opencode", "--output", "0"]), /bad number/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});