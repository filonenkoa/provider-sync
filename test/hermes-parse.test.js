// hermes custom_providers parsing: indentation, dashes, line endings, models blocks
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHermes, parseHermesProviders, parseHermesConfig, renderModels, yq, deq, parseFlowMap } from "../lib/hermes-yaml.js";

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

test("one unparseable providers entry does not hide the rest", () => {
  const h = parseHermesConfig(`providers:
  good:
    api: http://good/v1
    default_model: m1
    models:
      - id: m1
        context_length: 4096
  bad:
    api: http://bad/v1
    models: {x: 1}
  later:
    api: http://later/v1
    models: []
`);
  const dict = h.docs.find((d) => d.form === "dict");
  assert.equal(dict.error, null);
  assert.deepEqual(dict.entries.map((e) => e.key), ["good", "later"]);
  assert.equal(dict.unparsed, 1);
  assert.equal(dict.unparsedEntries[0].key, "bad");
  assert.match(dict.unparsedEntries[0].note, /inline value/);
});

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

test("parses entries whose fields are sorted alphabetically (name last)", () => {
  // editors and other tools may reorder fields; the entry must still parse
  const h = parseHermes(`custom_providers:
  - api_key: secret
    base_url: http://a/v1
    model: m1
    models:
      m1:
        context_length: 4096
    models_discovered: true
    name: Alpha
  - base_url: http://b/v1
    models:
      m2: {}
    name: Beta
`);
  assert.equal(h.unparsed, 0);
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[0].name, "Alpha");
  assert.equal(h.entries[0].base_url, "http://a/v1");
  assert.equal(h.entries[0].api_key, "secret");
  assert.equal(h.entries[0].model, "m1");
  assert.equal(h.entries[0].modelsDiscovered, true);
  assert.equal(h.entries[0].models[0].id, "m1");
  assert.equal(h.entries[0].models[0].ctx, 4096);
  assert.equal(h.entries[1].name, "Beta");
  assert.equal(h.entries[1].models[0].id, "m2");
});

test("an entry with known fields but no name still parses, named by base_url", () => {
  const h = parseHermes("custom_providers:\n  - base_url: http://c/v1\n    models:\n      m: {}\n");
  assert.equal(h.unparsed, 0);
  assert.equal(h.entries[0].name, "http://c/v1");
});

test("a flow-style entry is read, not counted as unparsed", () => {
  const h = parseHermes(`custom_providers:
  - {name: Flow, base_url: "http://127.0.0.1:8080/v1", api_key: dummy, models: {gemma: {context_length: 131072}, other: {}}}
`);
  assert.equal(h.unparsed, 0);
  assert.equal(h.entries.length, 1);
  const e = h.entries[0];
  assert.equal(e.flow, true);
  assert.equal(e.modelsOk, true);
  assert.equal(e.name, "Flow");
  assert.equal(e.base_url, "http://127.0.0.1:8080/v1");
  assert.equal(e.api_key, "dummy");
  assert.deepEqual(e.models.map((m) => [m.id, m.ctx]), [["gemma", 131072], ["other", null]]);
});

test("a flow entry with an unreadable models shape says so", () => {
  const h = parseHermes("custom_providers:\n  - {name: F, base_url: http://h/v1, models: weird}\n");
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].flow, true);
  assert.equal(h.entries[0].modelsOk, false);
});

test("flow entries and block entries can coexist", () => {
  const h = parseHermes(`custom_providers:
  - {name: A, base_url: http://a/v1, models: {m: {}}}
  - name: B
    base_url: http://b/v1
    models:
      m:
        context_length: 4096
`);
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[0].flow, true);
  assert.equal(h.entries[1].flow, undefined);
  assert.equal(h.entries[1].models[0].ctx, 4096);
});

test("parseFlowMap keeps nested braces and colons intact", () => {
  const pairs = parseFlowMap('{a: 1, b: {c: "x:y"}, d: "z, w"}');
  assert.deepEqual(pairs, [{ key: "a", value: "1" }, { key: "b", value: '{c: "x:y"}' }, { key: "d", value: '"z, w"' }]);
  assert.equal(parseFlowMap("not a map"), null);
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

test("parses canonical v12: api, default_model and a models list", () => {
  const h = parseHermesProviders(`providers:
  ollama-launch:
    api: http://127.0.0.1:11434/v1
    default_model: qwen3.6:35b-a3b-coding-nvfp4
    models:
      - qwen3.6:35b-a3b-coding-nvfp4
      - qwen3.6:27b-coding-nvfp4
    name: Ollama
`);
  const e = h.entries[0];
  assert.equal(h.error, null);
  assert.equal(e.base_url, "http://127.0.0.1:11434/v1");
  assert.equal(e.baseField, "api");
  assert.equal(e.model, "qwen3.6:35b-a3b-coding-nvfp4");
  assert.equal(e.modelField, "default_model");
  assert.equal(e.modelsShape, "list");
  assert.deepEqual(e.models.map((m) => m.id), ["qwen3.6:35b-a3b-coding-nvfp4", "qwen3.6:27b-coding-nvfp4"]);
});

test("parses a canonical models list with id rows and context_length", () => {
  const h = parseHermesProviders(`providers:
  p:
    api: http://h/v1
    models:
      - id: alpha
        context_length: 4096
      - beta
`);
  assert.deepEqual(h.entries[0].models.map((m) => [m.id, m.ctx]), [["alpha", 4096], ["beta", null]]);
});

test("parses canonical aliases in the legacy custom_providers list", () => {
  const h = parseHermes(`custom_providers:
  - name: Canonical
    api: http://h/v1
    default_model: alpha
    models:
      - alpha
      - beta
    enabled: false
`);
  const e = h.entries[0];
  assert.equal(e.base_url, "http://h/v1");
  assert.equal(e.model, "alpha");
  assert.equal(e.modelsShape, "list");
  assert.equal(e.enabled, false);
});

test("one unknown field does not discard the whole providers section", () => {
  const h = parseHermesProviders(`providers:
  broken:
    api: http://a/v1
    default_model: a
    models:
      - a
  good:
    api: http://b/v1
    default_model: b
    models:
      - b
    some_future_field:
      nested: value
`);
  assert.equal(h.error, null);
  assert.equal(h.entries.length, 2);
  assert.deepEqual(h.entries.map((e) => e.base_url), ["http://a/v1", "http://b/v1"]);
});

test("parseHermesConfig returns both surfaces in one document", () => {
  const d = parseHermesConfig(`providers:
  p:
    api: http://p/v1
    models:
      - p1
custom_providers:
  - name: L
    base_url: http://l/v1
    models:
      l1: {}
`);
  assert.equal(d.docs.length, 2);
  assert.deepEqual(d.docs.map((x) => x.section), ["providers", "custom_providers"]);
  assert.equal(d.entries.length, 2);
  assert.equal(d.entries[0].section, "providers");
  assert.equal(d.entries[1].section, "custom_providers");
});