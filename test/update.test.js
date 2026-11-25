// `provider-sync update` must find the checkout it was installed from, fetch,
// fast-forward and report the version it moved from and to. The tests build
// throwaway git repositories: a bare origin, a seed working copy and a clone
// that plays the installed copy. No test touches the real repository or the
// network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLI, hermeticEnv } from "./helpers.js";
import { versionDate } from "../lib/update.js";

const LIB = fileURLToPath(new URL("../lib", import.meta.url));
const HAS_GIT = (() => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const dirs = [];
const tmp = (prefix = "ps-update-") => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// git reads the user's identity and aliases from HOME/XDG; pin them to an empty
// directory so a developer's gitconfig cannot change what these tests do.
function gitEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "provider-sync test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "provider-sync test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function git(cwd, args, env = {}, opts = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...gitEnv(path.join(cwd, ".git-home")), ...env },
    ...opts,
  }).trim();
}

function commit(repo, message, date, env = {}) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--no-gpg-sign", "-m", message], {
    GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
    GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
    ...env,
  });
}

function writeProject(root, version, date) {
  mkdirSync(path.join(root, "bin"), { recursive: true });
  cpSync(CLI, path.join(root, "bin/provider-sync.js"));
  cpSync(LIB, path.join(root, "lib"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "provider-sync", version, type: "module", bin: { "provider-sync": "./bin/provider-sync.js" } }, null, 2) + "\n",
  );
  writeFileSync(path.join(root, "CHANGELOG.md"), `# Changelog\n\n## ${version} — ${date}\n`);
}

// bare origin <- seed (upstream) -> work (the installed clone)
function installedCopy({ version = "1.2.2", date = "2026-10-18" } = {}) {
  const base = tmp();
  const seed = path.join(base, "seed");
  const bare = path.join(base, "origin.git");
  const work = path.join(base, "work");
  mkdirSync(seed);
  writeProject(seed, version, date);
  git(seed, ["init", "-q", "-b", "main"]);
  commit(seed, "initial", date);
  git(seed, ["tag", `v${version}`]);
  git(base, ["init", "--bare", "-q", "-b", "main", bare]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-q", "-u", "origin", "main", "--tags"]);
  git(base, ["clone", "-q", bare, work]);
  return { base, seed, bare, work };
}

function publish(seed, { version, date, marker }) {
  writeProject(seed, version, date);
  if (marker) writeFileSync(path.join(seed, marker), "new\n");
  commit(seed, `release ${version}`, date);
  git(seed, ["tag", `v${version}`]);
  git(seed, ["push", "-q", "origin", "main", "--tags"]);
}

function runUpdate(work, args = [], opts = {}) {
  const home = tmp("ps-update-home-");
  return spawnSync(process.execPath, [path.join(work, "bin/provider-sync.js"), "update", ...args], {
    encoding: "utf8",
    env: { ...hermeticEnv(home), ...(opts.env || {}) },
    ...opts,
  });
}

const headOf = (repo) => git(repo, ["rev-parse", "HEAD"]);
const versionOf = (repo) => JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version;

test("versionDate reads the ISO date from a CHANGELOG heading", () => {
  assert.equal(versionDate("# Changelog\n\n## 1.2.2 — 2026-10-18\n", "1.2.2"), "2026-10-18");
  assert.equal(versionDate("## 1.3.0 - 2026-11-25\n", "1.3.0"), "2026-11-25");
  assert.equal(versionDate("## [1.4.0] - 2026-12-01\n", "1.4.0"), "2026-12-01");
  assert.equal(versionDate("## v1.4.0 (2026-12-01)\n", "1.4.0"), "2026-12-01");
});

test("versionDate does not confuse a version prefix with a longer one", () => {
  assert.equal(versionDate("## 1.2.20 — 2026-10-18\n", "1.2.2"), null);
});

test("versionDate returns null when the release has no date", () => {
  assert.equal(versionDate("## 1.0.0\n", "1.0.0"), null);
  assert.equal(versionDate("## Unreleased\n", "1.2.2"), null);
});

test("update fast-forwards and reports the old and new version with dates", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { seed, work } = installedCopy();
  publish(seed, { version: "1.3.0", date: "2026-11-25", marker: "NEWS" });

  const r = runUpdate(work);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /current:\s+1\.2\.2 \(2026-10-18\)/);
  assert.match(r.stdout, /new:\s+1\.3\.0 \(2026-11-25\)/);
  assert.match(r.stdout, /updated/);
  assert.equal(versionOf(work), "1.3.0");
  assert.equal(headOf(work), headOf(seed));
  assert.equal(readFileSync(path.join(work, "NEWS"), "utf8"), "new\n");
});

test("update --dry-run reports the plan and moves nothing", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { seed, work } = installedCopy();
  publish(seed, { version: "1.3.0", date: "2026-11-25" });
  const before = headOf(work);

  const r = runUpdate(work, ["--dry-run"]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\.2\.2 \(2026-10-18\)/);
  assert.match(r.stdout, /1\.3\.0 \(2026-11-25\)/);
  assert.match(r.stdout, /would/);
  assert.equal(headOf(work), before);
  assert.equal(versionOf(work), "1.2.2");
});

test("update says already up to date when origin has nothing new", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { work } = installedCopy();

  const r = runUpdate(work);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\.2\.2 \(2026-10-18\)/);
  assert.match(r.stdout, /already up to date/);
});

test("update refuses a dirty working tree and changes nothing", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { seed, work } = installedCopy();
  publish(seed, { version: "1.3.0", date: "2026-11-25" });
  const before = headOf(work);
  writeFileSync(path.join(work, "CHANGELOG.md"), "# Changelog\n\nlocal edit\n");

  const r = runUpdate(work);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uncommitted|working tree/i);
  assert.equal(headOf(work), before);
  assert.equal(versionOf(work), "1.2.2");
});

test("update refuses a directory that is not a git checkout", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const root = tmp();
  writeProject(root, "1.2.2", "2026-10-18");

  const r = spawnSync(process.execPath, [path.join(root, "bin/provider-sync.js"), "update"], {
    encoding: "utf8",
    env: hermeticEnv(tmp("ps-update-home-")),
  });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a git checkout/i);
});

test("update follows the real path of a symlinked install", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  if (process.platform === "win32") return t.skip("symlinks need extra privileges on Windows");
  const { seed, work, base } = installedCopy();
  publish(seed, { version: "1.3.0", date: "2026-11-25" });
  const bin = path.join(base, "bin");
  mkdirSync(bin);
  const link = path.join(bin, "provider-sync");
  symlinkSync(path.join(work, "bin/provider-sync.js"), link, "file");

  const r = spawnSync(process.execPath, [link, "update"], {
    encoding: "utf8",
    env: hermeticEnv(tmp("ps-update-home-")),
  });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(versionOf(work), "1.3.0");
});

test("update reports a local branch that is ahead but does not fail", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { work } = installedCopy();
  writeFileSync(path.join(work, "LOCAL"), "local\n");
  commit(work, "local work", "2026-11-01");

  const r = runUpdate(work);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ahead/);
});

test("update refuses diverged history instead of guessing a merge", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { seed, work } = installedCopy();
  publish(seed, { version: "1.3.0", date: "2026-11-25" });
  writeFileSync(path.join(work, "LOCAL"), "local\n");
  commit(work, "local work", "2026-11-01");
  const before = headOf(work);

  const r = runUpdate(work);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /diverged/i);
  assert.equal(headOf(work), before);
});

test("update refuses a branch without an upstream", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { work } = installedCopy();
  git(work, ["branch", "--unset-upstream"]);

  const r = runUpdate(work);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /upstream/i);
});

test("update refuses a detached HEAD", (t) => {
  if (!HAS_GIT) return t.skip("git is not installed");
  const { work } = installedCopy();
  git(work, ["checkout", "-q", "--detach"]);

  const r = runUpdate(work);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /detached/i);
});
