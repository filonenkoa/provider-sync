// The post-write validator against OpenCode's published schema
// (https://opencode.ai/config.json): every model map sets
// additionalProperties:false, so an unknown key really is an error — but so is
// calling a key OpenCode accepts "unknown". A false error on a valid config
// would send the user hunting for a problem that does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../bin/provider-sync.js";

const legacy = (models) => ({ provider: { p: { npm: "x", options: {}, models } } });
const native = (models) => ({ providers: { p: { package: "x", settings: {}, models } } });

test("legacy: every key OpenCode's schema allows is accepted", () => {
  const errs = validate(legacy({
    m: {
      name: "m", family: "qwen", release_date: "2026-01-01", attachment: true,
      reasoning: true, temperature: true, tool_call: true, status: "active",
      experimental: false, id: "m",
      interleaved: { field: "reasoning_content" },
      cost: { input: 1, output: 2 },
      headers: { "x-a": "b" },
      options: { anything: true },
      variants: { fast: { disabled: true } },
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 4096, output: 1024 },
    },
  }));
  assert.deepEqual(errs, []);
});

test("legacy: a key outside the schema is still reported", () => {
  assert.deepEqual(validate(legacy({ m: { name: "m", contex: 4096 } })),
    ["p/m: unknown model key \"contex\""]);
});

test("legacy: a bad modality and an incomplete limit are reported", () => {
  assert.deepEqual(validate(legacy({ m: { modalities: { input: ["text", "telepathy"] } } })),
    ['p/m: bad modality "telepathy"']);
  assert.deepEqual(validate(legacy({ m: { limit: { context: 4096 } } })),
    ["p/m: limit needs context+output"]);
  assert.deepEqual(validate(legacy({ m: { modalities: { input: ["image"] } } })),
    ['p/m: input must include "text"']);
});

test("native: a 2.x model entry is checked against its own schema", () => {
  assert.deepEqual(validate(native({
    m: {
      name: "m", modelID: "m", family: "qwen", releaseDate: "2026-01-01",
      package: "x", settings: {}, headers: { "x-a": "b" }, body: {},
      compatibility: { requireReasoning: false },
      cost: { input: 1, output: 2 },
      disabled: false,
      variants: [{ id: "fast" }],
      capabilities: { tools: true, input: ["text", "image"], output: ["text"], reasoning: { supported: true } },
      // a native limit may carry context alone — the schema requires neither
      limit: { context: 4096 },
    },
  })), []);
  // the capability input list is free-form in the schema, so no enum check
  assert.deepEqual(validate(native({ m: { capabilities: { input: ["text", "hologram"] } } })), []);
  assert.deepEqual(validate(native({ m: { modelz: 1 } })), ['p/m: unknown model key "modelz"']);
  assert.deepEqual(validate(native({ m: { capabilities: { toolz: true } } })),
    ['p/m: unknown capability "toolz"']);
  assert.deepEqual(validate(native({ m: { capabilities: { tools: "yes" } } })),
    ["p/m: capabilities.tools must be true or false"]);
  assert.deepEqual(validate(native({ m: { capabilities: { input: "text" } } })),
    ["p/m: capabilities.input must be a list of strings"]);
  assert.deepEqual(validate(native({ m: { capabilities: [] } })),
    ["p/m: capabilities must be an object"]);
});

test("both shapes: a model entry that is not an object is reported", () => {
  assert.deepEqual(validate(legacy({ m: "nope" })), ["p/m: model entry is not an object"]);
  assert.deepEqual(validate(native({ m: null })), ["p/m: model entry is not an object"]);
});