// atomicWrite: content correctness, no leftovers, and that a failed write
// cannot destroy the previous file
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
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