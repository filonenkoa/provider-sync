// dsh (DeepSeek Harness) provider yaml — pure functions only: no fs, no http,
// no state. provider-sync edits two documents:
//
//   settings.yaml     the pre-0.2 document; dsh imports it into the active
//                     profile at its next boot. Owned region: the
//                     llm-pi-ai.providers block.
//   cordis.patch.yml  the profile's live patch layer (a top-level list of
//                     loader patch items). Owned region: config.providers of
//                     the `- id: llm-pi-ai` item.
//
// Both are edited surgically, line by line: only the providers subtree is
// regenerated, everything around it survives byte for byte. The subset of
// YAML accepted inside that subtree is deliberately small — block mappings,
// block lists, one-line flow lists and scalars. Anything else (comments,
// anchors, aliases, tags, block scalars, flow mappings) refuses to rewrite
// with a reason instead of being dropped silently.

export const PROVIDER_ID = "llm-pi-ai";
export const ENTRY_NAME = "@deepseek-ai/dsh-llm-pi-ai";
// the comment header dsh puts on a fresh profile patch layer
export const PATCH_HEADER = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
];

class DshError extends Error {}

const pad = (n) => " ".repeat(n);
const indentOf = (l) => l.length - l.trimStart().length;
const nextNonBlank = (lines, i, end) => {
  while (i < end && lines[i].trim() === "") i++;
  return i;
};
const trimBlankEnd = (lines, a, b) => {
  while (b > a && lines[b - 1].trim() === "") b--;
  return b;
};
const joinEol = (arr, eol) => {
  if (!arr.length) return "";
  let t = arr.join(eol);
  if (!t.endsWith(eol)) t += eol;
  return t;
};
const err = (where, ln, why) => new DshError(`${where}: line ${ln + 1}: ${why}`);

// a plain YAML scalar is not necessarily a string — quote anything ambiguous.
// JSON quoting is always valid YAML, so over-quoting is harmless.
const YAML_BOOL = /^(?:true|false|y|n|yes|no|on|off)$/i;
const YAML_NULL = /^(?:~|null)$/i;
const YAML_NUM = /^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][-+]?\d+)?$/;
const YAML_ODD = /^(?:[-+]?\.(?:inf|nan)|0[xX][0-9a-fA-F]+|0[oO][0-7]+)$/i;
const resolvesToNonString = (s) => YAML_BOOL.test(s) || YAML_NULL.test(s) || YAML_NUM.test(s) || YAML_ODD.test(s);
// dsh's own writer leaves URLs, ids and names with spaces plain; keep that
// style where the value is plainly safe, quote everything else
const PLAIN_BODY = /^[A-Za-z0-9_.\/@+\-() :]*$/;
export function dq(s) {
  s = String(s);
  if (
    s !== "" && s === s.trim() && /^[A-Za-z0-9_]/.test(s) && PLAIN_BODY.test(s) &&
    !/:\s/.test(s) && !s.endsWith(":") && !resolvesToNonString(s)
  ) return s;
  return JSON.stringify(s);
}

// split "key: rest" at the colon that terminates a YAML key; null when the
// text is not a key line
function matchKey(content) {
  if (content[0] === '"' || content[0] === "'") {
    const q = content[0];
    let k = 1, raw = "";
    while (k < content.length) {
      const c = content[k];
      if (q === '"' && c === "\\") { raw += content.slice(k, k + 2); k += 2; continue; }
      if (c === q) {
        if (q === "'" && content[k + 1] === "'") { raw += "''"; k += 2; continue; }
        break;
      }
      raw += c; k++;
    }
    if (content[k] !== q || content[k + 1] !== ":") return null;
    let key;
    if (q === '"') { try { key = JSON.parse(`"${raw}"`); } catch { return null; } }
    else key = raw.replace(/''/g, "'");
    return { key, rest: content.slice(k + 2).trim() };
  }
  for (let k = 0; k < content.length; k++)
    if (content[k] === ":" && (k + 1 === content.length || content[k + 1] === " ")) {
      if (k === 0) return null;
      return { key: content.slice(0, k), rest: content.slice(k + 1).trim() };
    }
  return null;
}

// split the inside of a one-line flow list on commas that are not inside
// quotes; null for anything nested, which provider-sync will not rewrite
function splitFlow(inner) {
  const parts = [];
  let cur = "", q = null;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (q) {
      cur += ch;
      if (q === '"' && ch === "\\") { cur += inner[++k] ?? ""; continue; }
      if (ch === q) { if (q === "'" && inner[k + 1] === "'") { cur += "'"; k++; continue; } q = null; }
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "]" || ch === "{" || ch === "}") return null;
    if (ch === ",") { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (q) return null;
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts.filter((p) => p !== "");
}

function parseScalar(s, ln, where) {
  s = s.trim();
  const c = s[0];
  if (c === '"') {
    let k = 1, closed = -1;
    while (k < s.length) {
      if (s[k] === "\\") { k += 2; continue; }
      if (s[k] === '"') { closed = k; break; }
      k++;
    }
    if (closed < 0) throw err(where, ln, "an unterminated double-quoted string");
    const tail = s.slice(closed + 1).trim();
    if (tail !== "") throw err(where, ln, `text after a value ("${tail.slice(0, 20)}") — provider-sync will not rewrite it`);
    try { return JSON.parse(s.slice(0, closed + 1)); }
    catch { throw err(where, ln, "a double-quoted string with an escape provider-sync cannot decode"); }
  }
  if (c === "'") {
    let k = 1, out = "";
    for (;;) {
      if (k >= s.length) throw err(where, ln, "an unterminated single-quoted string");
      if (s[k] === "'") {
        if (s[k + 1] === "'") { out += "'"; k += 2; continue; }
        break;
      }
      out += s[k++];
    }
    const tail = s.slice(k + 1).trim();
    if (tail !== "") throw err(where, ln, "text after a value — provider-sync will not rewrite it");
    return out;
  }
  if (c === "[") {
    if (!s.endsWith("]")) throw err(where, ln, "a flow list provider-sync cannot read");
    const inner = s.slice(1, -1);
    if (inner.trim() === "") return [];
    const items = splitFlow(inner);
    if (items === null) throw err(where, ln, "a nested flow collection — provider-sync will not rewrite it");
    return items.map((t) => parseScalar(t, ln, where));
  }
  if (c === "{") throw err(where, ln, "a flow mapping ({...}) — provider-sync will not rewrite it");
  if (c === "&") throw err(where, ln, "a YAML anchor (&...) — provider-sync will not rewrite it");
  if (c === "*") throw err(where, ln, "a YAML alias (*...) — provider-sync will not rewrite it");
  if (c === "!") throw err(where, ln, "a YAML tag (!!js and friends) — provider-sync will not rewrite it");
  if (c === "|") throw err(where, ln, "a block scalar (|...) — provider-sync will not rewrite it");
  if (c === ">") throw err(where, ln, "a folded block scalar (>...) — provider-sync will not rewrite it");
  if (/(^|\s)#/.test(s)) throw err(where, ln, "a comment next to a value — provider-sync rewrites this block as a whole and will not drop it");
  if (/^[-+]?\d+$/.test(s)) { const n = Number(s); return Number.isSafeInteger(n) ? n : s; }
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^(?:true|True|TRUE)$/.test(s)) return true;
  if (/^(?:false|False|FALSE)$/.test(s)) return false;
  if (/^(?:~|null|Null|NULL)$/.test(s)) return null;
  return s;
}

// recursive descent over the block subset; every node is entered at the
// exact indentation of its first line, so files indented by anything (2, 4,
// tabs excluded) parse the same way
function parseNode(lines, i, indent, end, where) {
  const content = lines[i].slice(indent);
  if (content.startsWith("#")) throw err(where, i, "a comment — provider-sync rewrites this block as a whole and will not drop it");
  if (content.includes("\t")) throw err(where, i, "a tab character");
  if (/^-(\s|$)/.test(content)) return parseSeq(lines, i, indent, end, where);
  return parseMap(lines, i, indent, end, where);
}

function parseMap(lines, i, indent, end, where) {
  const obj = {};
  let j = i;
  while (j < end) {
    const l = lines[j];
    if (l.trim() === "") { j++; continue; }
    const ind = indentOf(l);
    if (ind < indent) break;
    if (ind > indent) throw err(where, j, `unexpected indentation (${ind} spaces inside a mapping at ${indent})`);
    const content = l.slice(indent);
    if (content.startsWith("#")) throw err(where, j, "a comment — provider-sync rewrites this block as a whole and will not drop it");
    if (content.includes("\t")) throw err(where, j, "a tab character");
    if (/^-(\s|$)/.test(content)) throw err(where, j, "a list item where a mapping key was expected");
    const kv = matchKey(content);
    if (!kv) throw err(where, j, `"${content.length > 40 ? content.slice(0, 40) + "…" : content}" is neither a key nor a list item`);
    if (kv.rest === "") {
      const ni = nextNonBlank(lines, j + 1, end);
      if (ni < end && indentOf(lines[ni]) > indent) {
        const r = parseNode(lines, ni, indentOf(lines[ni]), end, where);
        obj[kv.key] = r.value;
        j = r.end;
      } else {
        obj[kv.key] = null;
        j++;
      }
    } else {
      obj[kv.key] = parseScalar(kv.rest, j, where);
      j++;
    }
  }
  return { value: obj, end: j };
}

function parseSeq(lines, i, indent, end, where) {
  const arr = [];
  let j = i;
  while (j < end) {
    const l = lines[j];
    if (l.trim() === "") { j++; continue; }
    const ind = indentOf(l);
    if (ind < indent) break;
    if (ind > indent) throw err(where, j, `unexpected indentation (${ind} spaces inside a list at ${indent})`);
    const content = l.slice(indent);
    if (content.startsWith("#")) throw err(where, j, "a comment — provider-sync rewrites this block as a whole and will not drop it");
    if (content.includes("\t")) throw err(where, j, "a tab character");
    if (!/^-(\s|$)/.test(content)) throw err(where, j, "a mapping key where a list item was expected");
    const rest = content.replace(/^-\s*/, "");
    if (rest === "") {
      const ni = nextNonBlank(lines, j + 1, end);
      if (ni < end && indentOf(lines[ni]) > indent) {
        const r = parseNode(lines, ni, indentOf(lines[ni]), end, where);
        arr.push(r.value);
        j = r.end;
      } else { arr.push(null); j++; }
      continue;
    }
    const kv = matchKey(rest);
    if (kv) {
      // a list item that starts with "key:" is a mapping whose first pair
      // sits on the dash line
      const obj = {};
      let k;
      if (kv.rest === "") {
        const ni = nextNonBlank(lines, j + 1, end);
        if (ni < end && indentOf(lines[ni]) > indent) {
          const r = parseNode(lines, ni, indentOf(lines[ni]), end, where);
          obj[kv.key] = r.value; k = r.end;
        } else { obj[kv.key] = null; k = j + 1; }
      } else { obj[kv.key] = parseScalar(kv.rest, j, where); k = j + 1; }
      const ni2 = nextNonBlank(lines, k, end);
      if (ni2 < end && indentOf(lines[ni2]) > indent && !/^-(\s|$)/.test(lines[ni2].slice(indentOf(lines[ni2])))) {
        const r2 = parseMap(lines, ni2, indentOf(lines[ni2]), end, where);
        Object.assign(obj, r2.value);
        j = r2.end;
      } else j = k;
      arr.push(obj);
      continue;
    }
    arr.push(parseScalar(rest, j, where));
    j++;
  }
  return { value: arr, end: j };
}

function parseRegion(lines, a, b, where) {
  const i = nextNonBlank(lines, a, b);
  if (i >= b) return null;
  const r = parseNode(lines, i, indentOf(lines[i]), b, where);
  const j = nextNonBlank(lines, r.end, b);
  if (j < b) throw err(where, j, "unexpected content after the block");
  return r.value;
}

const isScalar = (v) => v === null || typeof v !== "object";
const scalarText = (v) =>
  v === null ? "null" :
  typeof v === "number" ? String(v) :
  typeof v === "boolean" ? (v ? "true" : "false") :
  dq(String(v));

function emitNode(value, indent, out = []) {
  if (Array.isArray(value)) {
    if (!value.length) { out.push(pad(indent) + "[]"); return out; }
    for (const item of value) {
      if (isScalar(item)) { out.push(pad(indent) + "- " + scalarText(item)); continue; }
      const inner = emitNode(item, indent + 2);
      if (!inner.length) { out.push(pad(indent) + "- {}"); continue; }
      out.push(pad(indent) + "- " + inner[0].slice(indent + 2));
      for (let i = 1; i < inner.length; i++) out.push(inner[i]);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const key = dq(k);
      if (isScalar(v)) out.push(pad(indent) + key + ": " + scalarText(v));
      else if (Array.isArray(v) && v.length === 0) out.push(pad(indent) + key + ": []");
      else if (!Array.isArray(v) && Object.keys(v).length === 0) out.push(pad(indent) + key + ": {}");
      else { out.push(pad(indent) + key + ":"); emitNode(v, indent + 2, out); }
    }
  } else {
    out.push(pad(indent) + scalarText(value));
  }
  return out;
}

// ---------- settings.yaml (pre-0.2 document) ----------

function sectionEnd(lines, keyIdx, keyIndent) {
  for (let k = keyIdx + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) <= keyIndent) return k;
  }
  return lines.length;
}

// find the llm-pi-ai section and its providers block; null when the section
// is absent; throws (DshError) when it is present in a shape not safe to edit
function locateSettings(lines, where) {
  const secIdx = lines.findIndex((l) => /^llm-pi-ai:/.test(l));
  if (secIdx < 0) return null;
  if (lines[secIdx].trimEnd() !== "llm-pi-ai:")
    throw err(where, secIdx, "the llm-pi-ai key is not a plain block mapping — provider-sync will not touch it");
  const end0 = sectionEnd(lines, secIdx, 0);
  const body = nextNonBlank(lines, secIdx + 1, end0);
  const bodyIndent = body < end0 ? indentOf(lines[body]) : 2;
  if (body < end0 && bodyIndent === 0)
    throw err(where, body, "the llm-pi-ai section is not indented — provider-sync will not touch it");
  let provIdx = -1;
  for (let k = secIdx + 1; k < end0; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) < bodyIndent) break;
    if (indentOf(l) === bodyIndent && /^providers:/.test(l.slice(bodyIndent))) { provIdx = k; break; }
  }
  if (provIdx < 0) return { secIdx, bodyIndent, provIdx: -1, a: -1, b: -1, providers: null };
  const provLine = lines[provIdx].trimEnd();
  const provInlineEmpty = provLine === pad(bodyIndent) + "providers: {}";
  if (provLine !== pad(bodyIndent) + "providers:" && !provInlineEmpty)
    throw err(where, provIdx, "providers: has a value on the same line — provider-sync will not rewrite it");
  let b = end0;
  for (let k = provIdx + 1; k < end0; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) <= bodyIndent) { b = k; break; }
  }
  b = trimBlankEnd(lines, provIdx + 1, b);
  const parsed = parseRegion(lines, provIdx + 1, b, where);
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed)))
    throw err(where, provIdx + 1, "providers is not a mapping — provider-sync will not touch it");
  return { secIdx, bodyIndent, provIdx, a: provIdx + 1, b, providers: parsed ?? {} };
}

export function parseDshSettings(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const where = "settings.yaml: the llm-pi-ai provider block";
  try {
    const loc = locateSettings(lines, where);
    if (!loc) return { present: false, providers: null, error: null, eol };
    return { present: true, providers: loc.providers, error: null, eol };
  } catch (e) {
    return { present: true, providers: null, error: e.message, eol };
  }
}

export function writeDshSettings(text, providers) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    throw new Error("internal: providers must be an object");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const where = "settings.yaml: the llm-pi-ai provider block";
  const empty = Object.keys(providers).length === 0;
  const loc = locateSettings(lines, where);
  if (!loc) {
    const at = trimBlankEnd(lines, 0, lines.length);
    const out = [
      ...lines.slice(0, at),
      ...(at > 0 ? [""] : []),
      "llm-pi-ai:",
      pad(2) + (empty ? "providers: {}" : "providers:"),
      ...(empty ? [] : emitNode(providers, 4)),
    ];
    return { text: joinEol(out, eol) };
  }
  const keyLine = pad(loc.bodyIndent) + (empty ? "providers: {}" : "providers:");
  const bodyLines = empty ? [] : emitNode(providers, loc.bodyIndent + 2);
  if (loc.provIdx >= 0) lines.splice(loc.provIdx, loc.b - loc.provIdx, keyLine, ...bodyLines);
  else lines.splice(loc.secIdx + 1, 0, keyLine, ...bodyLines);
  return { text: joinEol(lines, eol) };
}

// ---------- cordis.patch.yml (the live patch layer) ----------

const decodeLite = (s) => {
  s = (s ?? "").trim();
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s; } }
  return s.replace(/^(['"])(.*)\1$/, "$2");
};

// locate the `- id: llm-pi-ai` item and its config.providers block; null when
// the file has no such item; throws when ours is present in a shape not safe
// to edit (or when the item cannot be located uniquely)
function locatePatch(lines) {
  const starts = [];
  let markerIdx = -1;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (/^-(?:[ \t]|$)/.test(l)) { starts.push(k); continue; }
    if (!starts.length) {
      if (l.trim().startsWith("#")) continue;
      if (l.trim() === "[]") { markerIdx = k; continue; }
      throw err("cordis.patch.yml", k, "content before the first patch item that is not a comment and not [] — provider-sync will not touch this file");
    }
  }
  if (!starts.length) return null;
  const blocks = starts.map((s, i) => ({ s, e: i + 1 < starts.length ? starts[i + 1] : lines.length }));
  const ours = [];
  for (const b of blocks) {
    const pairs = [];
    const first = lines[b.s].replace(/^-(\s+|$)/, "").trim();
    const kv0 = first ? matchKey(first) : null;
    if (kv0) pairs.push({ ...kv0, lineIdx: b.s });
    for (let k = b.s + 1; k < b.e; k++) {
      const l = lines[k];
      if (l.trim() === "" || l.trim().startsWith("#")) continue;
      if (indentOf(l) !== 2) continue;
      const kv = matchKey(l.slice(2));
      if (kv) pairs.push({ ...kv, lineIdx: k });
    }
    const idP = pairs.find((p) => p.key === "id");
    if (idP && decodeLite(idP.rest) === PROVIDER_ID) ours.push({ ...b, pairs });
  }
  if (ours.length > 1)
    throw new DshError("cordis.patch.yml: more than one llm-pi-ai patch item — provider-sync will not guess which one is live");
  // a nested llm-pi-ai (inside an insert: list) cannot be located uniquely —
  // refuse before deciding whether a top-level one exists
  for (const b of blocks) {
    for (let k = b.s; k < b.e; k++) {
      const m = lines[k].match(/^(\s+)-(\s+|$)(.*)$/);
      if (!m) continue;
      const kv = matchKey(m[3].trim());
      if (kv && kv.key === "id" && decodeLite(kv.rest) === PROVIDER_ID)
        throw new DshError("cordis.patch.yml: llm-pi-ai also appears inside an insert: list — provider-sync will not touch a config it cannot locate uniquely");
    }
  }
  if (!ours.length) return null;
  const ob = ours[0];
  for (let k = ob.s; k < ob.e; k++) {
    if (lines[k].includes("\t")) throw err("cordis.patch.yml", k, "a tab character inside the llm-pi-ai item");
    if (k > ob.s && lines[k].trim().startsWith("#"))
      throw err("cordis.patch.yml", k, "a comment inside the llm-pi-ai item — provider-sync rewrites this item's providers as a whole and will not drop it");
  }
  const insertP = ob.pairs.find((p) => p.key === "insert");
  if (insertP) throw err("cordis.patch.yml", insertP.lineIdx, "the llm-pi-ai item carries an insert: key — provider-sync will not rewrite it");
  const disP = ob.pairs.find((p) => p.key === "disabled");
  const disabled = !!disP && /^(true|yes|on|1)$/i.test(disP.rest.trim());
  const cfgP = ob.pairs.find((p) => p.key === "config");
  const base = { block: ob, markerIdx, disabled };
  if (!cfgP) return { ...base, cfgIdx: -1, cfgInd: 4, cEnd: ob.e, provIdx: -1, a: -1, b: -1, providers: null };
  if (cfgP.rest !== "")
    throw err("cordis.patch.yml", cfgP.lineIdx, "the llm-pi-ai config: is written on one line — provider-sync will not rewrite it");
  let cEnd = ob.e;
  for (let k = cfgP.lineIdx + 1; k < ob.e; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) <= 2) { cEnd = k; break; }
  }
  const cb = nextNonBlank(lines, cfgP.lineIdx + 1, cEnd);
  const cfgInd = cb < cEnd ? indentOf(lines[cb]) : 4;
  let provIdx = -1;
  for (let k = cfgP.lineIdx + 1; k < cEnd; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) === cfgInd && /^providers:/.test(l.slice(cfgInd))) { provIdx = k; break; }
  }
  if (provIdx < 0) return { ...base, cfgIdx: cfgP.lineIdx, cfgInd, cEnd, provIdx: -1, a: -1, b: -1, providers: null };
  const provLine = lines[provIdx].trimEnd();
  const provInlineEmpty = provLine === pad(cfgInd) + "providers: {}";
  if (provLine !== pad(cfgInd) + "providers:" && !provInlineEmpty)
    throw err("cordis.patch.yml", provIdx, "providers: has a value on the same line — provider-sync will not rewrite it");
  let b = cEnd;
  for (let k = provIdx + 1; k < cEnd; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) <= cfgInd) { b = k; break; }
  }
  b = trimBlankEnd(lines, provIdx + 1, b);
  const parsed = parseRegion(lines, provIdx + 1, b, "cordis.patch.yml: the llm-pi-ai config.providers block");
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed)))
    throw err("cordis.patch.yml", provIdx + 1, "providers is not a mapping — provider-sync will not touch it");
  return { ...base, cfgIdx: cfgP.lineIdx, cfgInd, cEnd, provIdx, a: provIdx + 1, b, providers: parsed ?? {} };
}

export function parseDshPatch(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  try {
    const loc = locatePatch(lines);
    if (!loc) return { present: false, providers: null, disabled: false, error: null, eol };
    return { present: true, providers: loc.providers, disabled: loc.disabled, error: null, eol };
  } catch (e) {
    return { present: false, providers: null, disabled: false, error: e.message, eol };
  }
}

export function writeDshPatch(text, providers) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    throw new Error("internal: providers must be an object");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const empty = Object.keys(providers).length === 0;
  const loc = locatePatch(lines);
  if (!loc) {
    // no llm-pi-ai item yet: create one (replacing an empty [] marker if the
    // file has one, appending after the existing items otherwise)
    const block = [
      "- id: " + PROVIDER_ID,
      "  name: " + JSON.stringify(ENTRY_NAME),
      "  config:",
      "    " + (empty ? "providers: {}" : "providers:"),
      ...(empty ? [] : emitNode(providers, 6)),
    ];
    if (loc === null) {
      const firstItem = lines.findIndex((l) => /^-(?:[ \t]|$)/.test(l));
      let at = -1;
      if (firstItem < 0) at = lines.findIndex((l) => l.trim() === "[]");
      if (at >= 0) {
        lines.splice(at, 1, ...block);
        return { text: joinEol(lines, eol) };
      }
      const cut = trimBlankEnd(lines, 0, lines.length);
      lines.splice(cut, lines.length - cut, ...block, "");
      return { text: joinEol(lines, eol) };
    }
  }
  const keyLine = pad(loc.cfgInd) + (empty ? "providers: {}" : "providers:");
  const bodyLines = empty ? [] : emitNode(providers, loc.cfgInd + 2);
  if (loc.cfgIdx < 0) {
    lines.splice(loc.block.e, 0, "  config:", (empty ? "    providers: {}" : "    providers:"), ...(empty ? [] : emitNode(providers, 6)));
  } else if (loc.provIdx < 0) {
    lines.splice(loc.cEnd, 0, keyLine, ...bodyLines);
  } else {
    lines.splice(loc.provIdx, loc.b - loc.provIdx, keyLine, ...bodyLines);
  }
  return { text: joinEol(lines, eol) };
}

// ---------- .credentials.yaml (the credential store) ----------

export function parseDshStore(text) {
  const refs = new Map();
  const lines = text.split(/\r?\n/);
  const refsIdx = lines.findIndex((l) => l.trimEnd() === "refs:");
  if (refsIdx < 0)
    return { refs, error: text.trim() === "" ? null : "no refs: section — provider-sync cannot read stored keys" };
  let skipDeeper = -1;
  for (let k = refsIdx + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    const ind = indentOf(l);
    if (skipDeeper >= 0) {
      if (ind > skipDeeper) continue;
      skipDeeper = -1;
    }
    if (ind === 0) break;
    if (l.trim().startsWith("#")) continue;
    const m = l.match(/^ +([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    const raw = m[2].trim();
    const next = lines[k + 1] ?? "";
    const continued = next.trim() !== "" && indentOf(next) > ind;
    if (raw === "" || /^[|>]/.test(raw) || continued || /(^|\s)#/.test(raw)) {
      refs.set(name, { opaque: true });
      if (continued) skipDeeper = ind;
    } else if (/^".*"$/.test(raw)) {
      try { refs.set(name, { value: JSON.parse(raw) }); } catch { refs.set(name, { opaque: true }); }
    } else {
      refs.set(name, { value: raw.replace(/^'(.*)'$/, "$1") });
    }
  }
  return { refs, error: null };
}

export function setDshStoreRef(text, name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`"${name}" is not a credential reference name dsh can address`);
  if (typeof value !== "string" || /[\r\n]/.test(value))
    throw new Error("the key contains a line break — provider-sync will not write a multi-line credential");
  const line = `${name}: ${dq(value)}`;
  if (text.trim() === "") return { text: `version: 1\nrefs:\n  ${line}\n` };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let refsIdx = lines.findIndex((l) => /^refs:/.test(l));
  if (refsIdx >= 0 && lines[refsIdx].trimEnd() !== "refs:")
    throw err(".credentials.yaml", refsIdx, "refs: is written on one line — provider-sync will not rewrite it");
  if (refsIdx < 0) {
    const verIdx = lines.findIndex((l) => /^version:/.test(l));
    if (verIdx < 0)
      throw new Error(".credentials.yaml has no refs: section and no version: — provider-sync does not recognize this layout and will not rewrite it");
    lines.splice(verIdx + 1, 0, "refs:", "  " + line);
    return { text: joinEol(lines, eol) };
  }
  const entryRe = new RegExp("^( +)" + name + ":");
  for (let k = refsIdx + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    if (indentOf(l) === 0) break;
    const m = l.match(entryRe);
    if (!m) continue;
    const ind = m[1];
    let end = k + 1;
    while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > ind.length)) end++;
    end = trimBlankEnd(lines, k + 1, end);
    lines.splice(k, end - k, `${ind}${line}`);
    return { text: joinEol(lines, eol) };
  }
  lines.splice(refsIdx + 1, 0, "  " + line);
  return { text: joinEol(lines, eol) };
}

// the reference name dsh's own settings UI generates for a provider's key:
// <ID>_API_KEY; like that UI, replace every run of non-alphanumerics with "_"
export function dshRefName(id) {
  let n = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!n) n = "PROVIDER";
  if (/^[0-9]/.test(n)) n = "_" + n;
  return n + "_API_KEY";
}
