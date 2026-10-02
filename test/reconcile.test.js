// merge logic: what changes between the config and what the server reports
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, guessCtx } from "../bin/provider-sync.js";

const srv = (id, extra = {}) => ({ id, ctx: null, input: null, ...extra });

test("adds new models and reports them", () => {
  const r = reconcile({}, [srv("a", { ctx: 4096 })], { out: 1024, ctxMap: {} });
  assert.deepEqual(r.added, ["a"]);
  assert.equal(r.models.a.limit.context, 4096);
  assert.equal(r.models.a.modalities.input.length, 1, "text only by default");
});

test("removes models the server no longer reports", () => {
  const r = reconcile({ gone: { name: "gone" }, kept: { name: "kept" } }, [srv("kept")], { out: 1024, ctxMap: {} });
  assert.deepEqual(r.removed, ["gone"]);
  assert.deepEqual(Object.keys(r.models), ["kept"]);
});

test("never clobbers a configured ctx when the server reports none", () => {
  const r = reconcile({ m: { name: "m", limit: { context: 999999, output: 8 } } }, [srv("m")], { out: 1024, ctxMap: { m: 123 } });
  assert.equal(r.models.m.limit.context, 999999);
  assert.deepEqual(r.ctx, []);
});

test("server ctx is authoritative and the change is reported", () => {
  const r = reconcile({ m: { name: "m", limit: { context: 4096, output: 8 } } }, [srv("m", { ctx: 262144 })], { out: 1024, ctxMap: {} });
  assert.deepEqual(r.ctx, [["m", 4096, 262144]]);
  assert.equal(r.models.m.limit.context, 262144);
  assert.equal(r.models.m.limit.output, 8, "output is kept from the old entry");
});

test("preserves skipped (embeddings) models even when absent from the server list", () => {
  const r = reconcile({ emb: { name: "emb" } }, [srv("emb", { skip: true })], { out: 1024, ctxMap: {} });
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.ok(r.models.emb);
});

test("server-reported modalities override the entry, unknown fields survive", () => {
  const old = { name: "m", attachment: true, modalities: { input: ["text"], output: ["text"] }, custom_thing: 7 };
  const r = reconcile({ m: old }, [srv("m", { input: ["text", "image"] })], { out: 1024, ctxMap: {} });
  assert.deepEqual(r.mods, [["m", ["text"], ["text", "image"]]]);
  assert.deepEqual(r.models.m.modalities.input, ["text", "image"]);
  assert.equal(r.models.m.custom_thing, 7);
});

test("ctxMap guess applies only to models with no server value", () => {
  const r = reconcile({}, [srv("a"), srv("b", { ctx: 8192 })], { out: 1024, ctxMap: { a: 32768 } });
  assert.equal(r.models.a.limit.context, 32768);
  assert.equal(r.models.b.limit.context, 8192);
});

test("ctx 0 in ctxMap omits the limit entirely", () => {
  const r = reconcile({}, [srv("a")], { out: 1024, ctxMap: { a: 0 } });
  assert.equal("limit" in r.models.a, false);
});

test("guessed context windows are sane powers of two", () => {
  assert.equal(guessCtx("model-128K"), 131072);
  assert.equal(guessCtx("Qwen3.8-Flash-262Kctx"), 262144);
  assert.equal(guessCtx("gpt-4"), 131072);
  assert.equal(guessCtx("gemma-4-12b-it"), 131072);
  for (const id of ["model-1M", "model-262Kctx", "model-96K", "qwen3.8-30b"])
    assert.equal(Number.isInteger(Math.log2(guessCtx(id))), true, `${id} -> power of two`);
});