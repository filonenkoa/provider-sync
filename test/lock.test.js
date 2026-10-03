// the run lock: one writer at a time, stale locks taken over
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const home = mkdtempSync(path.join(tmpdir(), "ps-lock-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { acquireLock, releaseLock, lockHeld } = await import("../bin/provider-sync.js");

const lockDir = path.join(home, ".config/opencode");
const lockFile = path.join(lockDir, ".provider-sync.lock");
const posix = process.platform !== "win32"; // process.kill(pid, 0) is POSIX-only

// a process that is definitely alive, and not us
let child = null;
const livePid = () => {
  if (!posix) return null;
  if (!child) child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
  return child.pid;
};
// find a pid that is definitely not running instead of guessing a number
const findDeadPid = () => {
  for (let p = 4194303; p > 100000; p -= 7) {
    try { process.kill(p, 0); } catch (e) { if (e.code === "ESRCH") return p; }
  }
  throw new Error("no unused pid found");
};
const deadPid = findDeadPid();

before(() => { acquireLock(); releaseLock(); }); // make sure the dir exists
after(() => {
  if (child) child.kill();
  rmSync(home, { recursive: true, force: true });
});

const withStubbedExit = (fn) => {
  const errs = [];
  const origErr = console.error, origExit = process.exit;
  console.error = (m) => errs.push(String(m));
  process.exit = (code) => { throw new Error("exit " + code); };
  try { fn(); } catch (e) { if (!/^exit /.test(e.message)) throw e; }
  finally { console.error = origErr; process.exit = origExit; }
  return errs;
};

test("the lock can be taken and released", () => {
  acquireLock();
  assert.equal(existsSync(lockFile), true);
  assert.equal(readFileSync(lockFile, "utf8").trim(), String(process.pid));
  releaseLock();
  assert.equal(existsSync(lockFile), false);
});

test("a lock held by a live process blocks a second run", { skip: !posix }, () => {
  writeFileSync(lockFile, String(livePid()));
  assert.equal(lockHeld(), livePid());
  const errs = withStubbedExit(() => acquireLock());
  assert.equal(errs.length, 1, "expected a diagnostic");
  assert.match(errs.join("\n"), /another provider-sync run is in progress/);
  assert.equal(readFileSync(lockFile, "utf8").trim(), String(livePid()), "the other run's lock is untouched");
  rmSync(lockFile);
});

test("a stale lock from a dead process is taken over", () => {
  writeFileSync(lockFile, String(deadPid));
  assert.equal(lockHeld(), 0);
  acquireLock(); // must take the stale lock over, not throw
  assert.equal(readFileSync(lockFile, "utf8").trim(), String(process.pid));
  releaseLock();
});

test("a garbage lock file is treated as stale", () => {
  writeFileSync(lockFile, "not a pid");
  assert.equal(lockHeld(), 0);
  releaseLock();
});

test("our own lock is not reported as a conflict", () => {
  writeFileSync(lockFile, String(process.pid));
  assert.equal(lockHeld(), 0);
  releaseLock();
});

test("the lock lives next to the config it protects", () => {
  assert.equal(path.dirname(lockFile), lockDir);
});