// Updating provider-sync itself. The CLI knows where it lives, and a git clone
// is the supported install, so update is a fetch plus a fast-forward — nothing
// here touches a harness config or the tombstone state file.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// A fetch against an unreachable remote can hang on a broken network; fail
// with git's own message instead of waiting forever.
const GIT_TIMEOUT = 120_000;

// "## 1.2.2 — 2026-10-18" (also "-" and "[1.2.2]"); the date lives on the same
// line as the heading, so a missing date must not borrow the next one.
export function versionDate(changelog, version) {
  if (typeof changelog !== "string" || !version) return null;
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+\\[?v?${esc}\\]?(?=\\s|$)[^\\n]*?(\\d{4}-\\d{2}-\\d{2})`, "m");
  const m = changelog.match(re);
  return m ? m[1] : null;
}

function runGit(root, args, opts = {}) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT, ...opts });
  if (r.error) {
    if (r.error.code === "ENOENT")
      throw new Error("git is not installed — update fetches the checkout with git");
    throw new Error(`cannot run git: ${r.error.message}`);
  }
  return r;
}

function gitOut(root, args, opts) {
  const r = runGit(root, args, opts);
  return r.status === 0 ? r.stdout.trim() : null;
}

function gitShow(root, ref, file) {
  const r = runGit(root, ["show", `${ref}:${file}`]);
  if (r.status !== 0) throw new Error(`cannot read ${file} from ${ref}`);
  return r.stdout;
}

const isAncestor = (root, a, b) => runGit(root, ["merge-base", "--is-ancestor", a, b]).status === 0;

const real = (p) => {
  try { return realpathSync(p); } catch { return path.resolve(p); }
};
const samePath = (a, b) =>
  process.platform === "win32"
    ? real(a).toLowerCase() === real(b).toLowerCase()
    : real(a) === real(b);

// The version and the release date belong together: package.json names the
// version, CHANGELOG.md dates the release, a tag dates it when the changelog
// has no heading. A checkout that is N commits past its tag says so, because
// otherwise "1.2.2 (2026-10-18)" would describe code from three weeks later.
export function describeVersion(root, ref, { worktree = false } = {}) {
  const pkgText = worktree
    ? readFileSync(path.join(root, "package.json"), "utf8")
    : gitShow(root, ref, "package.json");
  let version;
  try { version = JSON.parse(pkgText).version || "unknown"; }
  catch { throw new Error(`cannot read the version from ${worktree ? "package.json" : `${ref}:package.json`}`); }

  let changelog = "";
  try {
    changelog = worktree ? readFileSync(path.join(root, "CHANGELOG.md"), "utf8") : gitShow(root, ref, "CHANGELOG.md");
  } catch { /* no changelog: fall back to the tag or the commit date */ }

  const headDate = gitOut(root, ["log", "-1", "--format=%cs", ref]) || null;
  const date = versionDate(changelog, version)
    || gitOut(root, ["log", "-1", "--format=%cs", `v${version}`])
    || headDate;

  let commitsSinceTag = null;
  const tag = `v${version}`;
  if (gitOut(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]) && isAncestor(root, tag, ref)) {
    const count = gitOut(root, ["rev-list", "--count", `${tag}..${ref}`]);
    if (count !== null) {
      const n = Number(count);
      if (Number.isFinite(n)) commitsSinceTag = n;
    }
  }
  return { version, date, headDate, commitsSinceTag };
}

export function formatVersion(info) {
  const date = info.date ? ` (${info.date})` : "";
  const extra = info.commitsSinceTag > 0
    ? ` +${info.commitsSinceTag} commits (${info.headDate || "date unknown"})`
    : "";
  return `${info.version}${date}${extra}`;
}

// Refuse anything that would make a fast-forward unsafe or update the wrong
// repository: a copy inside another checkout, a dirty tree, a detached HEAD,
// a branch with no remote to compare against.
function preflight(root) {
  const top = gitOut(root, ["rev-parse", "--show-toplevel"]);
  if (!top)
    throw new Error(`not a git checkout — ${root} is not inside a git working tree; reinstall from https://github.com/filonenkoa/provider-sync`);
  if (!samePath(top, root))
    throw new Error(`not a provider-sync checkout — ${root} is inside ${top}; refusing to update another repository`);

  const branch = gitOut(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch)
    throw new Error("detached HEAD — check out a branch with an upstream before running update");

  const upstream = gitOut(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream)
    throw new Error(`branch "${branch}" has no upstream — set one with "git branch --set-upstream-to=origin/${branch}"`);

  const remote = gitOut(root, ["config", `branch.${branch}.remote`]);
  if (!remote || remote === ".")
    throw new Error(`branch "${branch}" does not track a remote — update needs a clone of the provider-sync repository`);

  const dirty = gitOut(root, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    const n = dirty.split("\n").filter(Boolean).length;
    throw new Error(`working tree has uncommitted changes (${n} file${n === 1 ? "" : "s"}) — commit or stash them before running update`);
  }
  return { branch, upstream, remote };
}

function countCommits(root, range) {
  const raw = gitOut(root, ["rev-list", "--count", range]);
  if (raw === null) throw new Error(`cannot compare local history with ${range}`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`cannot compare local history with ${range}`);
  return n;
}

export function updateRepo(root, { dryRun = false } = {}) {
  const { branch, upstream, remote } = preflight(root);

  const fetch = runGit(root, ["fetch", "--quiet", remote]);
  if (fetch.status !== 0) {
    const detail = (fetch.stderr || fetch.stdout).trim().split("\n").pop() || `git fetch ${remote} failed`;
    throw new Error(`cannot reach ${remote}: ${detail}`);
  }

  const behind = countCommits(root, "HEAD..@{u}");
  const ahead = countCommits(root, "@{u}..HEAD");
  const plan = {
    root,
    branch,
    upstream,
    remote,
    behind,
    ahead,
    current: describeVersion(root, "HEAD", { worktree: true }),
    next: describeVersion(root, "@{u}"),
    dryRun,
    updated: false,
    after: null,
  };

  if (behind === 0) return plan;
  if (ahead > 0)
    throw new Error(`local branch and ${upstream} have diverged (${ahead} local commit${ahead === 1 ? "" : "s"}, ${behind} upstream) — resolve this manually with git pull --rebase or git merge`);
  if (dryRun) return plan;

  const merge = runGit(root, ["merge", "--ff-only", "--quiet", "@{u}"]);
  if (merge.status !== 0) {
    const detail = (merge.stderr || merge.stdout).trim() || "fast-forward failed";
    throw new Error(`cannot fast-forward to ${upstream}: ${detail}`);
  }
  plan.updated = true;
  plan.after = describeVersion(root, "HEAD", { worktree: true });
  return plan;
}
