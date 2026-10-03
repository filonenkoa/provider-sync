// `list` must report every harness independently: a Hermes-only or
// OpenCode-only machine has to show what it has, not just a skip line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLI = new URL("../bin/provider-sync.js", import.meta.url).pathname;
const made = [];

const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-list-"));
  made.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};

// column widths are a formatting choice, not part of the contract
const flat = (s) => s.replace(/[ \t]+/g, " ");
const list = (home, args = []) =>
  flat(execFileSync(process.execPath, [CLI, "list", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  }));

test.after(() => { for (const h of made) rmSync(h, { recursive: true, force: true }); });

const OC_CFG = `{
  "provider": {
    "p1": { "options": { "baseURL": "http://h:1/v1" }, "models": { "m": {}, "n": {} } }
  }
}
`;
const AUTH = '{ "p1": { "type": "api", "key": "sk-x" } }';
const HERMES_CFG = `custom_providers:
  - name: Local
    base_url: http://127.0.0.1:8080/v1
    api_key: dummy
    models:
      gemma:
        context_length: 131072
  - name: WithEnv
    base_url: http://10.0.0.1:1234/v1
    api_key: \${SOME_KEY}
    models:
      m1:
        context_length: 4096
`;

test("hermes-only machine: hermes providers are listed, opencode is skipped", () => {
  const out = list(homeWith({ ".hermes/config.yaml": HERMES_CFG }));
  assert.match(out, /opencode .*not found — skipped/);
  assert.match(out, /hermes \S*config\.yaml/);
  assert.match(out, /Local 1 models http:\/\/127\.0\.0\.1:8080\/v1 no-key/);
  assert.match(out, /WithEnv 1 models .* key \(env\)/);
});

test("opencode-only machine: opencode providers are listed, hermes is skipped", () => {
  const out = list(homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG,
    ".local/share/opencode/auth.json": AUTH,
  }));
  assert.match(out, /opencode \S*opencode\.jsonc/);
  assert.match(out, /p1 2 models http:\/\/h:1\/v1 key/);
  assert.match(out, /hermes .*not found — skipped/);
});

test("neither harness installed: both reported as skipped, exit 0", () => {
  const out = list(homeWith({ ".keep": "" }));
  assert.match(out, /opencode .*not found — skipped/);
  assert.match(out, /hermes .*not found — skipped/);
});

test("both harnesses: both sections are present", () => {
  const out = list(homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG,
    ".local/share/opencode/auth.json": AUTH,
    ".hermes/config.yaml": HERMES_CFG,
  }));
  assert.match(out, /opencode \S*opencode\.jsonc/);
  assert.match(out, /hermes \S*config\.yaml/);
  assert.match(out, /p1 2 models/);
  assert.match(out, /Local 1 models/);
});

test("--target narrows the output to a single harness", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG, ".hermes/config.yaml": HERMES_CFG });
  const onlyH = list(home, ["--target", "hermes"]);
  assert.doesNotMatch(onlyH, /opencode/);
  assert.match(onlyH, /Local 1 models/);
  const onlyO = list(home, ["--target", "opencode"]);
  assert.doesNotMatch(onlyO, /hermes/);
  assert.match(onlyO, /p1 2 models/);
});

test("an invalid --target is refused", () => {
  assert.throws(() => list(homeWith({ ".keep": "" }), ["--target", "bogus"]), /bad --target/);
});

test("an empty opencode provider section says so instead of printing nothing", () => {
  const out = list(homeWith({ ".config/opencode/opencode.jsonc": '{\n  "provider": {}\n}\n' }));
  assert.match(out, /\(no providers\)/);
});

test("a hermes config without custom_providers says so", () => {
  const out = list(homeWith({ ".hermes/config.yaml": "model:\n  default: x\n" }));
  assert.match(out, /no custom_providers section/);
});

test("a key borrowed from opencode is labelled with its source", () => {
  const out = list(homeWith({
    ".config/opencode/opencode.jsonc": `{
  "provider": { "oc1": { "options": { "baseURL": "http://10.0.0.1:1234/v1" }, "models": {} } }
}
`,
    ".local/share/opencode/auth.json": '{ "oc1": { "type": "api", "key": "sk-x" } }',
    ".hermes/config.yaml": `custom_providers:
  - name: Borrowed
    base_url: http://10.0.0.1:1234/v1
    api_key: dummy
    models:
      m:
        context_length: 1
`,
  }));
  assert.match(out, /Borrowed 1 models .* key \(borrowed from oc1\)/);
});

test("an unset key_env is explained instead of a bare no-key", () => {
  const out = list(homeWith({
    ".hermes/config.yaml": `custom_providers:
  - name: E
    base_url: http://h/v1
    key_env: MISSING_KEY
    models:
      m:
        context_length: 1
`,
  }));
  assert.match(out, /no-key \(MISSING_KEY is unset in ~\/\.hermes\/\.env\)/);
});

test("an unusually indented hermes file is still parsed and listed", () => {
  const out = list(homeWith({
    ".hermes/config.yaml": `custom_providers:
    - name: Odd
        base_url: http://h/v1
        api_key: dummy
        models:
            m:
                context_length: 1
`,
  }));
  assert.match(out, /Odd 1 models http:\/\/h\/v1/);
});

test("a list item without a name is counted and reported, not silently dropped", () => {
  const out = list(homeWith({
    ".hermes/config.yaml": `custom_providers:
  - opaque: 1
    other: 2
  - name: Ok
    base_url: http://h/v1
    api_key: dummy
    models:
      m:
        context_length: 1
`,
  }));
  assert.match(out, /Ok 1 models/, "the parsable entry is still listed");
  assert.match(out, /1 item\(s\) in an unexpected layout/, "and the odd one is reported");
});

test("a hermes list with nothing parsable says so instead of looking empty", () => {
  const out = list(homeWith({
    ".hermes/config.yaml": "custom_providers:\n  - opaque: 1\n    other: 2\n",
  }));
  assert.match(out, /custom_providers present but no entries parsed/);
  assert.match(out, /1 item\(s\) in an unexpected layout/);
});