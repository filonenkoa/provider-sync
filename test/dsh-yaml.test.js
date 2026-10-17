// The dsh provider yaml lib, pure side: parsing the subset it can rewrite,
// refusing the rest, emitting dsh's own style, and surgical splicing that
// leaves everything outside the providers block byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_ID, PATCH_HEADER, dq, dshRefName,
  parseDshSettings, writeDshSettings,
  parseDshPatch, writeDshPatch,
  parseDshStore, setDshStoreRef,
} from "../lib/dsh-yaml.js";

const SAMPLE = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    m4max:
      displayName: M4 Max
      api: openai-completions
      baseURL: http://192.168.9.58:1234/v1
      models:
        - id: unsloth/qwen3.8-27b
          contextWindow: 262144
        - id: plain name
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - id: inclusionai/ling-3.0-flash:free
`;

test("settings: parses providers, keeps values typed", () => {
  const p = parseDshSettings(SAMPLE);
  assert.equal(p.error, null);
  assert.deepEqual(Object.keys(p.providers), ["m4max", "openrouter"]);
  assert.equal(p.providers.m4max.api, "openai-completions");
  assert.equal(p.providers.m4max.models[0].contextWindow, 262144);
  assert.equal(p.providers.m4max.models[1].id, "plain name");
  assert.equal(p.providers.openrouter.models[0].id, "inclusionai/ling-3.0-flash:free");
});

test("settings: writing is byte-identical outside the providers block", () => {
  const p = parseDshSettings(SAMPLE);
  const out = writeDshSettings(SAMPLE, p.providers).text;
  assert.equal(out.slice(0, out.indexOf("llm-pi-ai:")), SAMPLE.slice(0, SAMPLE.indexOf("llm-pi-ai:")));
  const back = parseDshSettings(out);
  assert.deepEqual(back.providers, p.providers, "round-trips unchanged");
});

test("settings: emits dsh's quoting style", () => {
  const out = writeDshSettings(SAMPLE, {
    p: {
      models: [
        { id: "4090", name: "MCP: test" },
        { id: "a/b:free", name: "simple-thing" },
        { id: "true", name: "- leading dash" },
      ],
    },
  }).text;
  assert.match(out, /- id: "4090"/, "number-like ids stay strings");
  assert.match(out, /name: "MCP: test"/, "colon-space forces quotes");
  assert.match(out, /- id: a\/b:free/, "slash and inner colon stay plain");
  assert.match(out, /name: simple-thing/);
  assert.match(out, /- id: "true"/, "bool-like stays a string");
  assert.match(out, /name: "- leading dash"/);
  const back = parseDshSettings(out);
  assert.equal(back.providers.p.models[0].id, "4090");
  assert.equal(back.providers.p.models[0].name, "MCP: test");
  assert.equal(back.providers.p.models[2].id, "true");
});

test("settings: a comment inside the block is refused, not dropped", () => {
  const withComment = SAMPLE.replace("    openrouter:\n", "    # my note\n    openrouter:\n");
  const p = parseDshSettings(withComment);
  assert.match(p.error, /comment/);
  assert.throws(() => writeDshSettings(withComment, {}), /comment/);
});

test("settings: anchors, tags and flow mappings are refused", () => {
  for (const bad of ["api: !!js process.env.X", "api: &anchor vulkan", "limits: {a: 1}"]) {
    const doc = SAMPLE.replace("      api: openai-completions\n", "      " + bad + "\n");
    assert.match(parseDshSettings(doc).error, /provider-sync will not/, bad);
    assert.throws(() => writeDshSettings(doc, {}), /provider-sync will not/);
  }
});

test("settings: a missing section is created, an empty one gets providers", () => {
  const fresh = writeDshSettings("", { p: { api: "openai-completions", models: [{ id: "x" }] } }).text;
  assert.match(fresh, /^llm-pi-ai:\n  providers:\n    p:\n/);
  assert.deepEqual(parseDshSettings(fresh).providers.p.models, [{ id: "x" }]);

  const noProviders = writeDshSettings("ui-onboarding:\n  done: true\nllm-pi-ai:\n", { p: { models: [] } }).text;
  assert.match(noProviders, /llm-pi-ai:\n  providers:\n    p:\n      models: \[\]\n/);
  assert.match(noProviders, /^ui-onboarding:\n  done: true\n/, "the rest survives");

  const empty = writeDshSettings("llm-pi-ai:\n  providers: {}\n", { p: { models: [] } }).text;
  assert.match(empty, /providers:\n    p:\n/);
});

test("settings: a flow-style providers value is refused", () => {
  const doc = "llm-pi-ai:\n  providers: {a: {}}\n";
  assert.throws(() => writeDshSettings(doc, { p: { models: [] } }), /will not rewrite it/);
  // exactly `{}` is what dsh's own writer emits for an empty map: accepted
  const empty = "llm-pi-ai:\n  providers: {}\n";
  assert.match(writeDshSettings(empty, { p: { models: [] } }).text, /providers:\n    p:\n/);
});

const PATCH = `${PATCH_HEADER.join("\n")}

- id: ui-settings
  name: "@deepseek-ai/dsh-ui-settings"
  config:
    theme: dark
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      m4max:
        api: openai-completions
        baseURL: http://192.168.9.58:1234/v1
        models:
          - id: qwen
            contextWindow: 4096
`;

test("patch: finds the llm-pi-ai item and parses its providers", () => {
  const p = parseDshPatch(PATCH);
  assert.equal(p.error, null);
  assert.deepEqual(Object.keys(p.providers), ["m4max"]);
  assert.equal(p.providers.m4max.models[0].id, "qwen");
});

test("patch: rewriting replaces only the providers subtree", () => {
  const p = parseDshPatch(PATCH);
  p.providers.m4max.models.push({ id: "new", contextWindow: 8192 });
  const out = writeDshPatch(PATCH, p.providers).text;
  const cut = (t) => t.slice(0, t.indexOf("    providers:"));
  assert.equal(cut(out), cut(PATCH), "the other item and the header are byte-identical");
  const back = parseDshPatch(out);
  assert.deepEqual(back.providers.m4max.models.map((m) => m.id), ["qwen", "new"]);
  assert.equal(writeDshPatch(out, back.providers).text, out, "re-writing is stable");
});

test("patch: a fresh file gets the item, an empty [] marker is replaced", () => {
  const fresh = writeDshPatch(PATCH_HEADER.join("\n") + "\n", { p: { models: [] } }).text;
  assert.match(fresh, /\n- id: llm-pi-ai\n  name: "@deepseek-ai\/dsh-llm-pi-ai"\n  config:\n    providers:\n      p:\n        models: \[\]\n/);
  assert.match(fresh.split("\n")[0], /^# Your patch layer/, "the header survives");

  const marker = writeDshPatch("# hdr\n[]\n", { p: { models: [{ id: "x" }] } }).text;
  assert.doesNotMatch(marker, /\[\]/);
  assert.equal(parseDshPatch(marker).providers.p.models[0].id, "x");

  const appended = writeDshPatch("- id: other\n  config:\n    a: 1\n", { p: { models: [] } }).text;
  assert.match(appended, /- id: other\n  config:\n    a: 1\n- id: llm-pi-ai\n/);
});

test("patch: disabled is detected and reported", () => {
  const doc = `- id: llm-pi-ai\n  disabled: true\n  config:\n    providers:\n      p:\n        models: []\n`;
  assert.equal(parseDshPatch(doc).disabled, true);
});

test("patch: two llm-pi-ai items are refused as ambiguous", () => {
  const doc = `- id: llm-pi-ai\n  config:\n    providers:\n      a: {}\n- id: llm-pi-ai\n  config:\n    providers:\n      b: {}\n`;
  const p = parseDshPatch(doc);
  assert.match(p.error, /more than one llm-pi-ai patch item/);
  assert.throws(() => writeDshPatch(doc, {}), /more than one/);
});

test("patch: a nested llm-pi-ai inside an insert list is refused", () => {
  const doc = `- id: base\n  insert:\n    - id: llm-pi-ai\n      config:\n        providers: {}\n`;
  assert.match(parseDshPatch(doc).error, /insert: list/);
});

test("patch: comments and exotic values inside the item are refused", () => {
  const commented = PATCH.replace("  name: \"@deepseek-ai/dsh-llm-pi-ai\"\n", "  # live\n  name: \"@deepseek-ai/dsh-llm-pi-ai\"\n");
  assert.match(parseDshPatch(commented).error, /comment/);
  const inlineCfg = PATCH.replace('  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n', '  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config: {}\n');
  assert.match(parseDshPatch(inlineCfg).error, /one line/);
  // a one-line empty providers map is what dsh's own writer produces for no
  // providers — it reads as empty and is expanded to block style on write
  const inlineProv = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers: {}
`;
  const ip = parseDshPatch(inlineProv);
  assert.equal(ip.error, null);
  assert.deepEqual(ip.providers, {});
  assert.match(writeDshPatch(inlineProv, { p: { models: [] } }).text, /providers:\n      p:\n/);
});

test("store: parses refs and setDshStoreRef adds and replaces", () => {
  const doc = `version: 1
refs:
  M4MAX_API_KEY: sk-abc
  OPENROUTER_API_KEY: "sk-xy: z"
  BLOCK_API_KEY: |
    line one
    line two
`;
  const parsed = parseDshStore(doc);
  assert.equal(parsed.refs.get("M4MAX_API_KEY").value, "sk-abc");
  assert.equal(parsed.refs.get("OPENROUTER_API_KEY").value, "sk-xy: z");
  assert.equal(parsed.refs.get("BLOCK_API_KEY").opaque, true);

  const added = setDshStoreRef(doc, "NEW_API_KEY", "key with spaces").text;
  assert.match(added, /  NEW_API_KEY: key with spaces\n/);
  assert.equal(parseDshStore(added).refs.get("NEW_API_KEY").value, "key with spaces");
  assert.match(added, /M4MAX_API_KEY: sk-abc/, "existing refs untouched");

  const replaced = setDshStoreRef(doc, "M4MAX_API_KEY", "sk-new").text;
  assert.match(replaced, /  M4MAX_API_KEY: sk-new\n/);
  assert.doesNotMatch(replaced, /sk-abc/);

  const overwritten = setDshStoreRef(doc, "BLOCK_API_KEY", "sk-one-line").text;
  assert.doesNotMatch(overwritten, /line one/, "multi-line continuation lines are replaced too");
  assert.equal(parseDshStore(overwritten).refs.get("BLOCK_API_KEY").value, "sk-one-line");

  const fresh = setDshStoreRef("", "A_API_KEY", "sk").text;
  assert.equal(fresh, "version: 1\nrefs:\n  A_API_KEY: sk\n");
});

test("store: a key with a line break is refused", () => {
  assert.throws(() => setDshStoreRef("", "A_API_KEY", "a\nb"), /line break/);
});

test("dq quotes anything YAML would read as a non-string", () => {
  assert.equal(dq("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(dq("m4max"), "m4max");
  assert.equal(dq("4090"), '"4090"');
  assert.equal(dq("true"), '"true"');
  assert.equal(dq("on"), '"on"');
  assert.equal(dq("a: b"), '"a: b"');
  assert.equal(dq("ends:"), '"ends:"');
  assert.equal(dq(""), '""');
});

test("dshRefName follows dsh's own ID_upper_API_KEY convention", () => {
  assert.equal(dshRefName("m4max"), "M4MAX_API_KEY");
  assert.equal(dshRefName("ivan3090-lan"), "IVAN3090_LAN_API_KEY");
  assert.equal(dshRefName("my.provider v2"), "MY_PROVIDER_V2_API_KEY");
  assert.equal(dshRefName("4090"), "_4090_API_KEY");
  assert.equal(dshRefName("üü"), "PROVIDER_API_KEY");
});

test("PROVIDER_ID matches the loader entry dsh itself writes", () => {
  assert.equal(PROVIDER_ID, "llm-pi-ai");
});
