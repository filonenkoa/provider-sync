// hermes custom_providers parsing: indentation, dashes, line endings, models blocks
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHermes, renderModels, yq, deq } from "../lib/hermes-yaml.js";

const STD = `model:
  default: x

# a comment
custom_providers:
  - name: Local
    base_url: http://127.0.0.1:8080/v1
    api_key: dummy
    model: gemma-4-12b-it
    models:
      gemma-4-12b-it:
        context_length: 131072
      qwen3.8-27b: {}
    models_discovered: true

trailing_key:
  keep: me
`;

test("parses a standard 2-space config", () => {
  const h = parseHermes(STD);
  assert.equal(h.entries.length, 1);
  const e = h.entries[0];
  assert.equal(e.name, "Local");
  assert.equal(e.base_url, "http://127.0.0.1:8080/v1");
  assert.equal(e.api_key, "dummy");
  assert.equal(e.model, "gemma-4-12b-it");
  assert.equal(e.modelsDiscovered, true);
  assert.equal(h.listInd, 2);
  assert.equal(h.fldInd, 4);
  assert.equal(h.unparsed, 0);
  assert.equal(h.listEnd, STD.split("\n").length - 3);
});

test("parses models in block and flow form, keeping context_length", () => {
  const [a, b] = parseHermes(STD).entries[0].models;
  assert.deepEqual([a.id, a.ctx], ["gemma-4-12b-it", 131072]);
  assert.deepEqual([b.id, b.ctx], ["qwen3.8-27b", null]);
});

test("flags model entries holding fields other than context_length", () => {
  const h = parseHermes(`custom_providers:
  - name: X
    base_url: http://h/v1
    models:
      m1:
        context_length: 100
        max_tokens: 8192
      m2: {context_length: 200, temperature: 0.7}
`);
  assert.equal(h.entries[0].models[0].extra, true);
  assert.equal(h.entries[0].models[1].extra, true);
});

test("detects indentation instead of assuming 2/4", () => {
  const h = parseHermes(`custom_providers:
    - name: Deep
      base_url: http://h/v1
      models:
        m:
          context_length: 4096
`);
  assert.equal(h.listInd, 4);
  assert.equal(h.fldInd, 6);
  assert.equal(h.entries[0].name, "Deep");
  assert.equal(h.entries[0].models[0].ctx, 4096);
});

test("tolerates extra spaces after the dash", () => {
  const h = parseHermes("custom_providers:\n    -   name: Spaced\n        base_url: http://h/v1\n");
  assert.equal(h.entries[0].name, "Spaced");
  assert.equal(h.entries[0].base_url, "http://h/v1");
});

test("counts list items it cannot parse instead of guessing", () => {
  const h = parseHermes("custom_providers:\n  - weird_key: 1\n    other: 2\n  - name: Ok\n    base_url: http://h/v1\n");
  assert.equal(h.unparsed, 1);
  assert.equal(h.entries.length, 1);
});

test("returns null when there is no custom_providers section", () => {
  assert.equal(parseHermes("model:\n  default: x\n"), null);
});

test("handles CRLF and reports it back for writing", () => {
  const h = parseHermes(STD.replace(/\n/g, "\r\n"));
  assert.equal(h.eol, "\r\n");
  assert.equal(h.entries[0].base_url, "http://127.0.0.1:8080/v1");
  assert.equal(h.entries[0].models[0].ctx, 131072);
});

test("ids with colons and quotes survive a render/parse round trip", () => {
  const ids = ["weird:model", 'he said "hi".gguf', "with space", "D:\\models\\q.gguf"];
  const src = "custom_providers:\n  - name: X\n    base_url: http://h/v1\n    models:\n"
    + renderModels(ids.map((id) => ({ id, ctx: 4096 })), 6, 8).join("\n") + "\n";
  const h = parseHermes(src);
  assert.deepEqual(h.entries[0].models.map((m) => m.id), ids);
  assert.deepEqual(h.entries[0].models.map((m) => m.ctx), ids.map(() => 4096));
});

test("yq only quotes when a plain scalar would be ambiguous", () => {
  assert.equal(yq("gemma-4-12b-it"), "gemma-4-12b-it");
  assert.equal(yq("127.0.0.1:1234"), "127.0.0.1:1234");
  assert.equal(yq("Local Gemma 4 12B"), "Local Gemma 4 12B");
  assert.equal(yq("a: b"), '"a: b"');
  assert.equal(yq("has # hash"), '"has # hash"');
  assert.equal(yq(" pad "), '" pad "');
});

test("deq round trips what yq produced", () => {
  for (const s of ["plain", "a: b", 'he said "hi"', "D:\\m\\q.gguf", "a, }b"])
    assert.equal(deq(yq(s)), s);
});