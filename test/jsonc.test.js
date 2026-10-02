// JSONC handling: the scanner must only touch comments and trailing commas
// that live outside string literals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../bin/provider-sync.js";

const parse = (src) => JSON.parse(parseJsonc(src).text);

test("strips line and block comments outside strings", () => {
  const { text, hadComments } = parseJsonc(`{
    // a line comment
    "a": 1, /* inline */ "b": 2
  }`);
  assert.equal(hadComments, true);
  assert.deepEqual(parse(text), { a: 1, b: 2 });
});

test("hadComments is false when only trailing commas were removed", () => {
  const { hadComments } = parseJsonc('{"a": 1,\n}\n');
  assert.equal(hadComments, false);
});

test("keeps ', }' and ', ]' inside string literals", () => {
  const src = '{"models":{"weird, }name":{},"c, ]d":{}}}';
  assert.deepEqual(Object.keys(parse(src).models), ["weird, }name", "c, ]d"]);
});

test("keeps comment-like sequences inside strings", () => {
  const src = '{"url":"http://h/v1","note":"a /* not a comment */ b","esc":"say \\"hi\\""}';
  const p = parse(src);
  assert.equal(p.url, "http://h/v1");
  assert.equal(p.note, "a /* not a comment */ b");
  assert.equal(p.esc, 'say "hi"');
});

test("removes trailing commas before closers, across newlines", () => {
  const src = '{\n  "a": [1, 2, ] ,\n  "b": 3,\n}\n';
  assert.deepEqual(parse(src), { a: [1, 2], b: 3 });
});

test("a comma at end of file is left alone (invalid json stays invalid)", () => {
  const { text } = parseJsonc('{"a":1},\n');
  assert.equal(text, '{"a":1},\n');
});

test("escaped backslash before a quote does not end the string", () => {
  const src = '{"winpath":"D:\\\\models\\\\qwen.gguf","n":1}';
  assert.equal(parse(src).winpath, "D:\\models\\qwen.gguf");
});