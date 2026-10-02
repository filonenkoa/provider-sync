// argument parsing: the silent-boolean and --k=v bugs lived here
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../bin/provider-sync.js";

// parseArgs calls die() (process.exit) on a bad flag, so assert on the good paths here
const p = (argv) => parseArgs(argv);

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