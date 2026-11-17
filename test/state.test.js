// tombstones: the user's "I removed this" intent, kept outside every harness
// config because none of them has a portable per-model disable flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState, normalizeState, isExcluded, excludeModels, restoreModels,
  dropProvider, filterServerModels, hiddenCount,
} from "../lib/state.js";

const HERMES = { target: "hermes", provider: "ollama", baseURL: "http://127.0.0.1:11434/v1" };

test("an empty state excludes nothing", () => {
  const s = emptyState();
  assert.deepEqual(s, { version: 1, excluded: [] });
  assert.equal(isExcluded(s, { ...HERMES, model: "m1" }), false);
});

test("excluded models match by provider id or by normalized base URL", () => {
  const s = excludeModels(emptyState(), { ...HERMES, models: ["m1"] });
  assert.equal(isExcluded(s, { ...HERMES, model: "m1" }), true);
  // the server moved: the provider id still matches
  assert.equal(isExcluded(s, { ...HERMES, baseURL: "http://127.0.0.1:9999/v1", model: "m1" }), true);
  // the provider was renamed: the base URL still matches
  assert.equal(isExcluded(s, { ...HERMES, provider: "renamed", model: "m1" }), true);
  // localhost and 127.0.0.1 are the same host, as everywhere else in the tool
  assert.equal(isExcluded(s, { ...HERMES, provider: null, baseURL: "http://localhost:11434/v1", model: "m1" }), true);
});

test("a different target, provider or model does not match", () => {
  const s = excludeModels(emptyState(), { ...HERMES, models: ["m1"] });
  assert.equal(isExcluded(s, { ...HERMES, target: "opencode", model: "m1" }), false);
  assert.equal(isExcluded(s, { ...HERMES, provider: "other", baseURL: "http://other/v1", model: "m1" }), false);
  assert.equal(isExcluded(s, { ...HERMES, model: "m2" }), false);
});

test("excluding the same model twice keeps one record", () => {
  let s = excludeModels(emptyState(), { ...HERMES, models: ["m1", "m2"] });
  s = excludeModels(s, { ...HERMES, models: ["m2", "m2"] });
  assert.equal(s.excluded.length, 1);
  assert.deepEqual(s.excluded[0].models, ["m1", "m2"]);
});

test("restore removes one model and drops empty records", () => {
  let s = excludeModels(emptyState(), { ...HERMES, models: ["m1", "m2"] });
  s = restoreModels(s, { ...HERMES, models: ["m1"] });
  assert.deepEqual(s.excluded[0].models, ["m2"]);
  s = restoreModels(s, { ...HERMES, models: ["m2"] });
  assert.deepEqual(s.excluded, []);
});

test("restore without models clears every tombstone for that provider", () => {
  let s = excludeModels(emptyState(), { ...HERMES, models: ["m1", "m2"] });
  s = excludeModels(s, { target: "hermes", provider: "other", baseURL: "http://other/v1", models: ["x"] });
  s = restoreModels(s, HERMES);
  assert.equal(s.excluded.length, 1);
  assert.equal(s.excluded[0].provider, "other");
});

test("dropProvider removes only the matching provider", () => {
  let s = excludeModels(emptyState(), { ...HERMES, models: ["m1"] });
  s = excludeModels(s, { target: "opencode", provider: "ollama", baseURL: HERMES.baseURL, models: ["m1"] });
  s = dropProvider(s, HERMES);
  assert.equal(s.excluded.length, 1);
  assert.equal(s.excluded[0].target, "opencode");
});

test("filterServerModels reports what it hid and keeps server order", () => {
  const s = excludeModels(emptyState(), { ...HERMES, models: ["m2"] });
  const server = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
  const out = filterServerModels(server, s, HERMES);
  assert.deepEqual(out.server.map((m) => m.id), ["m1", "m3"]);
  assert.deepEqual(out.hidden, ["m2"]);
  assert.equal(hiddenCount(s, HERMES), 1);
});

test("normalizeState tolerates a missing or broken file instead of throwing", () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState("nope"), emptyState());
  assert.deepEqual(normalizeState({ version: 99, excluded: "x" }), emptyState());
  const s = normalizeState({
    version: 1,
    excluded: [
      { target: "hermes", provider: "p", baseURL: "http://h/v1", models: ["m", "m"] },
      { target: "hermes", provider: "p", baseURL: "http://h/v1", models: ["n"] },
      { target: 42, models: ["x"] },
      { target: "hermes", provider: "q", models: [] },
    ],
  });
  assert.equal(s.excluded.length, 1);
  assert.deepEqual(s.excluded[0].models, ["m", "n"]);
});
