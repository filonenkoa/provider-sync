// The CLI must behave identically no matter how it is invoked. A symlinked
// install (npm link, ~/.local/bin) used to run nothing at all, silently.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLI = new URL("../bin/provider-sync.js", import.meta.url).pathname;
const home = mkdtempSync(path.join(tmpdir(), "ps-cli-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// a minimal config so commands that need one do not die
before(() => {
  mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  writeFileSync(path.join(home, ".config/opencode/opencode.jsonc"), '{\n  "provider": {}\n}\n');
});
after(() => rmSync(home, { recursive: true, force: true }));

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [opts.entry || CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, ...(opts.env || {}) },
  });

let binDir;
test("setup: a symlink like npm link would create", () => {
  binDir = mkdtempSync(path.join(tmpdir(), "ps-bin-"));
  symlinkSync(CLI, path.join(binDir, "provider-sync"));
  assert.ok(existsSync(path.join(binDir, "provider-sync")));
});

test("--version works through a symlink", () => {
  assert.match(run(["--version"], { entry: path.join(binDir, "provider-sync") }).trim(), /^\d+\.\d+\.\d+$/);
});

test("list works through a symlink", () => {
  assert.doesNotThrow(() => run(["list"], { entry: path.join(binDir, "provider-sync") }));
});

test("help is printed for every spelling of the help flag", () => {
  for (const args of [["help"], ["--help"], ["-h"]]) {
    const out = run(args, { entry: path.join(binDir, "provider-sync") });
    assert.match(out, /provider-sync — manage local model providers/, `args: ${args}`);
  }
});

test("an unknown command still fails loudly through a symlink", () => {
  assert.throws(() => run(["nonsense"], { entry: path.join(binDir, "provider-sync") }), /unknown command/);
});

test("output survives a pipe (process.exit must not truncate stdout)", () => {
  // execFileSync captures through a pipe, which is where a process.exit right
  // after console.log can drop buffered output
  for (let i = 0; i < 5; i++) {
    const out = run(["help"], { entry: path.join(binDir, "provider-sync") });
    assert.ok(out.length > 500, `run ${i}: got ${out.length} chars`);
  }
});

test("a nested symlink (symlink to symlink) also works", () => {
  const second = mkdtempSync(path.join(tmpdir(), "ps-bin2-"));
  symlinkSync(path.join(binDir, "provider-sync"), path.join(second, "provider-sync"));
  assert.match(run(["--version"], { entry: path.join(second, "provider-sync") }).trim(), /^\d+\.\d+\.\d+$/);
  rmSync(second, { recursive: true, force: true });
});

test("running the file by a relative path works", () => {
  const out = execFileSync("node", [path.relative(process.cwd(), CLI), "--version"], { encoding: "utf8" });
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});