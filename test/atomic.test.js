// atomicWrite: content correctness, no leftovers, and that a failed write
// cannot destroy the previous file
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite } from "../bin/provider-sync.js";

const made = [];
let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "ps-atomic-")); made.push(dir); });
// only ever remove the directories this test created, never tmpdir() itself
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("writes the file and leaves no temp file behind", () => {
  const f = path.join(dir, "config.json");
  atomicWrite(f, '{"a":1}\n');
  assert.equal(readFileSync(f, "utf8"), '{"a":1}\n');
  assert.deepEqual(readdirSync(dir), ["config.json"]);
});

test("creates missing parent directories", () => {
  const f = path.join(dir, "deep", "nested", "config.yaml");
  atomicWrite(f, "custom_providers:\n");
  assert.equal(readFileSync(f, "utf8"), "custom_providers:\n");
});

test("overwrites an existing file in place", () => {
  const f = path.join(dir, "c.json");
  writeFileSync(f, "old\n");
  atomicWrite(f, "new\n");
  assert.equal(readFileSync(f, "utf8"), "new\n");
  assert.deepEqual(readdirSync(dir), ["c.json"]);
});

test("a write that fails leaves the previous file intact", () => {
  // a directory where the temp file should go makes openSync fail
  const f = path.join(dir, "c.json");
  writeFileSync(f, "previous\n");
  mkdirSync(f + ".tmp-provider-sync");
  assert.throws(() => atomicWrite(f, "new\n"), /EISDIR|EACCES|EPERM/);
  assert.equal(readFileSync(f, "utf8"), "previous\n", "original content survived");
  assert.ok(existsSync(f), "target file still there");
});

test("binary-ish content round trips byte for byte", () => {
  const f = path.join(dir, "b.bin");
  const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
  atomicWrite(f, data);
  assert.deepEqual(readFileSync(f), data);
});

// A config kept in a dotfiles repository and symlinked into place is a normal
// setup. Renaming a temp file over the link would quietly replace the link
// with a regular file: the real config would never change, and the next sync
// would report the same drift forever.
test("a symlinked config stays a symlink and its target is updated", (t) => {
  if (process.platform === "win32") return t.skip("symlinks need extra privileges on Windows");
  const target = path.join(dir, "dotfiles", "config.yaml");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "old\n");
  const link = path.join(dir, "config.yaml");
  symlinkSync(target, link);

  atomicWrite(link, "new\n");

  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
  assert.equal(readlinkSync(link), target, "the link still points at the same file");
  assert.equal(readFileSync(target, "utf8"), "new\n", "the target got the new content");
});

test("a relative symlink is resolved from the link's own directory", (t) => {
  if (process.platform === "win32") return t.skip("symlinks need extra privileges on Windows");
  mkdirSync(path.join(dir, "dotfiles"), { recursive: true });
  const target = path.join(dir, "dotfiles", "config.yaml");
  writeFileSync(target, "old\n");
  const link = path.join(dir, "config.yaml");
  symlinkSync(path.join("dotfiles", "config.yaml"), link);

  atomicWrite(link, "new\n");

  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(target, "utf8"), "new\n");
});

test("a symlink chain is followed to the file that actually holds the data", (t) => {
  if (process.platform === "win32") return t.skip("symlinks need extra privileges on Windows");
  mkdirSync(path.join(dir, "dotfiles"), { recursive: true });
  const target = path.join(dir, "dotfiles", "config.yaml");
  writeFileSync(target, "old\n");
  const mid = path.join(dir, "mid.yaml");
  symlinkSync(target, mid);
  const link = path.join(dir, "config.yaml");
  symlinkSync(mid, link);

  atomicWrite(link, "new\n");

  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(lstatSync(mid).isSymbolicLink());
  assert.equal(readFileSync(target, "utf8"), "new\n");
});

test("a dangling symlink gets its target created instead of being replaced", (t) => {
  if (process.platform === "win32") return t.skip("symlinks need extra privileges on Windows");
  const target = path.join(dir, "dotfiles", "config.yaml");
  mkdirSync(path.dirname(target), { recursive: true });
  const link = path.join(dir, "config.yaml");
  symlinkSync(target, link);

  atomicWrite(link, "new\n");

  assert.ok(lstatSync(link).isSymbolicLink(), "the link survived");
  assert.equal(readFileSync(target, "utf8"), "new\n", "the missing target was created");
});

test("a symlink loop is refused instead of replaced", (t) => {
  if (process.platform === "win32") return t.skip("symlinks need extra privileges on Windows");
  const a = path.join(dir, "a.yaml");
  const b = path.join(dir, "b.yaml");
  symlinkSync(b, a);
  symlinkSync(a, b);

  assert.throws(() => atomicWrite(a, "new\n"), /ELOOP|symbolic links/);
  assert.ok(lstatSync(a).isSymbolicLink(), "the loop was left alone");
  assert.ok(lstatSync(b).isSymbolicLink(), "the loop was left alone");
});