// hermes custom_providers yaml — pure functions only: no fs, no http, no state.
// Everything here is line-based on purpose. The config belongs to the user, so
// comments, blank lines and untouched sections must survive byte for byte; only
// the per-provider `models:` block is ever rewritten.

export const normUrl = (b) => (b || "").replace(/\/v1\/?$/i, "").replace(/\/+$/, "").toLowerCase().replace("localhost", "127.0.0.1");
// unquote a YAML scalar; double-quoted strings are JSON (yq quotes via JSON.stringify)
export const deq = (s) => {
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch {} }
  return s.replace(/^(['"])(.*)\1$/, "$2");
};
// a plain YAML scalar is not necessarily a string: 123, 1.5, true, yes, on, off,
// null and ~ all resolve to a number/bool/null, which would turn a model id key
// into something Hermes cannot look up. Quote anything ambiguous; JSON quoting
// is always valid YAML, so over-quoting is harmless.
const YAML_BOOL = /^(?:true|false|y|n|yes|no|on|off)$/i;
const YAML_NULL = /^(?:~|null)$/i;
const YAML_NUM = /^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][-+]?\d+)?$/;
const YAML_ODD = /^(?:[-+]?\.(?:inf|nan)|0[xX][0-9a-fA-F]+|0[oO][0-7]+)$/i;
const resolvesToNonString = (s) => YAML_BOOL.test(s) || YAML_NULL.test(s) || YAML_NUM.test(s) || YAML_ODD.test(s);
// quote a YAML scalar only when needed
export const yq = (s) => (!s || !/^[A-Za-z0-9_.@-]/.test(s) || /: /.test(s) || /^\s|\s$/.test(s) || s.includes("#") || resolvesToNonString(s) ? JSON.stringify(s) : s);
export const ind = (n) => " ".repeat(n);
const indentOf = (l) => l.length - l.trimStart().length;
// hermes yaml: indentation is detected from the file instead of assumed, so
// configs written with a different indent (or by a Windows editor) still parse
// split a yaml flow mapping "{a: 1, b: {c: 2}}" into top-level {key, value}
// pairs; returns null when the text is not a flow mapping
export function parseFlowMap(text) {
  const t = String(text).trim();
  if (!(t.startsWith("{") && t.endsWith("}"))) return null;
  const inner = t.slice(1, -1);
  const parts = [];
  let depth = 0, quote = null, cur = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += inner[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const m = p.match(/^\s*([^:]+?)\s*:\s*([\s\S]*?)\s*$/);
    return m ? { key: deq(m[1]), value: m[2] } : null;
  }).filter(Boolean);
}

// models inside a flow entry: {m1: {context_length: 4096}, m2: {}}
function flowModels(value) {
  const pairs = parseFlowMap(value);
  if (!pairs) return { models: [], ok: false };
  const models = [];
  for (const { key, value: v } of pairs) {
    const inner = parseFlowMap(v);
    if (!inner) return { models, ok: false }; // a shape we must not rewrite blindly
    let ctx = null, extra = false;
    for (const f of inner) {
      if (f.key === "context_length") ctx = parseInt(f.value);
      else extra = true;
    }
    models.push({ id: key, ctx, extra });
  }
  return { models, ok: true };
}

export function parseHermes(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^custom_providers:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const entries = [];
  let listInd = null;
  let dashes = 0; // list items we could not parse — appending next to them would corrupt the yaml
  let i = start + 1;
  while (i < lines.length) {
    const m = lines[i].match(/^( *)- +(.*)$/);
    if (!m) {
      if (lines[i].trim() === "") { i++; continue; }
      if (/^\S/.test(lines[i])) break;
      i++; continue;
    }
    const li = m[1].length;
    if (listInd === null) listInd = li;
    if (li > listInd) { i++; continue; } // a list nested inside the previous entry
    if (li < listInd) break; // the custom_providers list ended
    // an entry may start with any field — editors and other tools sort fields
    // alphabetically (base_url/api_key first); name is read from wherever it is
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > li)) j++;
    let e2 = j;
    while (e2 > i + 1 && lines[e2 - 1].trim() === "") e2--;
    let fi = null; // field indent = indent of the first field line (usually dash + 2)
    for (let k = i + 1; k < e2; k++)
      if (lines[k].trim() && indentOf(lines[k]) > li) { fi = indentOf(lines[k]); break; }
    if (fi === null) fi = li + 2;
    const fld = (k) => new RegExp("^ {" + fi + "}" + k + ":\\s*(\\S.*?)\\s*$");
    // the dash line itself may carry the first field, e.g. "- base_url: ...";
    // only known provider fields count — an unknown key is still "not understood"
    const KNOWN_FIELDS = "name|base_url|api_key|key_env|model|models|models_discovered|discover_models|free_only";
    // a flow entry ("- {name: x, base_url: y}") is read but never rewritten:
    // our surgical edits are indent based and cannot patch inside braces
    if (m[2].trim().startsWith("{")) {
      const pairs = parseFlowMap(m[2].trim()) || [];
      const entry = { idx: i, end: e2, name: null, flow: true, listInd: li, fldInd: li + 2, mdlInd: li + 4, ctxInd: li + 6, base_url: null, api_key: null, key_env: null, model: null, modelsIdx: -1, blockEnd: -1, models: [], modelsOk: false, modelsDiscovered: false };
      for (const { key, value } of pairs) {
        if (key === "name") entry.name = deq(value);
        else if (key === "base_url") entry.base_url = deq(value);
        else if (key === "api_key") entry.api_key = deq(value);
        else if (key === "key_env") entry.key_env = deq(value);
        else if (key === "model") entry.model = deq(value);
        else if (key === "models_discovered") entry.modelsDiscovered = /^(true|yes|1)$/i.test(value.trim());
        else if (key === "models") { const r = flowModels(value); entry.models = r.models; entry.modelsOk = r.ok; }
      }
      if (!entry.name) entry.name = entry.base_url || `unnamed (line ${i + 1})`;
      entries.push(entry);
      i = e2;
      continue;
    }
    const first = m[2].match(new RegExp("^(" + KNOWN_FIELDS + "):\\s*(\\S.*?)\\s*$"));
    const nm = m[2].match(/^name:\s*(.*)$/);
    const name0 = nm ? deq(nm[1].trim()) : null;
    if (!first && !name0) { dashes++; i++; continue; }
    const entry = { idx: i, end: e2, name: name0, listInd: li, fldInd: fi, mdlInd: fi + 2, ctxInd: fi + 4, base_url: null, api_key: null, key_env: null, model: null, modelsIdx: -1, blockEnd: -1, models: [], modelsDiscovered: false };
    if (first && !nm) {
      if (first[1] === "name") entry.name = deq(first[2]);
      else if (first[1] === "base_url") entry.base_url = deq(first[2]);
      else if (first[1] === "api_key") entry.api_key = deq(first[2]);
      else if (first[1] === "key_env") entry.key_env = deq(first[2]);
      else if (first[1] === "model") entry.model = deq(first[2]);
    }
    for (let k = i + 1; k < e2; k++) {
      const l = lines[k];
      let f;
      if ((f = l.match(fld("name")))) entry.name = deq(f[1]);
      else if ((f = l.match(fld("base_url")))) entry.base_url = deq(f[1]);
      else if ((f = l.match(fld("api_key")))) entry.api_key = deq(f[1]);
      else if ((f = l.match(fld("key_env")))) entry.key_env = deq(f[1]);
      else if ((f = l.match(fld("model")))) entry.model = deq(f[1]);
      else if ((f = l.match(fld("models_discovered")))) entry.modelsDiscovered = /^(true|yes|1)$/i.test(f[1]);
      else if (new RegExp("^ {" + fi + "}models:\\s*$").test(l)) {
        entry.modelsIdx = k;
        let b = k + 1;
        while (b < e2 && (lines[b].trim() === "" || indentOf(lines[b]) > fi)) b++;
        entry.blockEnd = b;
        entry.models = parseModelsBlock(lines, k + 1, b, fi + 2, fi + 4);
      }
    }
    // display code expects a name; fall back to the base URL, then to the line number
    if (!entry.name) entry.name = entry.base_url || `unnamed (line ${i + 1})`;
    entries.push(entry);
    i = e2;
  }
  const li = listInd ?? 2;
  return { lines, entries, listInd: li, fldInd: entries[0]?.fldInd ?? li + 2, listEnd: i, unparsed: dashes, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

export function parseModelsBlock(lines, a, b, mdl, ctx) {
  const models = [];
  const keyRe = new RegExp("^ {" + mdl + "}(.+?):(?:\\s+(\\{.*\\}))?\\s*$");
  const ctxRe = new RegExp("^ {" + ctx + "}context_length:\\s*(\\d+)\\s*$");
  let i = a;
  while (i < b) {
    const l = lines[i];
    if (l.trim() === "") { i++; continue; }
    const m = l.match(keyRe);
    if (!m) { i++; continue; }
    const id = deq(m[1]);
    let ctxv = null, extra = false; // extra: fields provider-sync does not preserve (only context_length is kept)
    if (m[2]) {
      const ic = m[2].match(/context_length:\s*(\d+)/);
      if (ic) ctxv = parseInt(ic[1]);
      const rest = m[2].replace(/^\{\s*|\s*\}$/g, "").replace(/"?context_length"?\s*:\s*\d+/g, "");
      if (rest.replace(/[,\s]/g, "") !== "") extra = true;
    } else {
      for (let k = i + 1; k < b; k++) {
        if (lines[k].trim() === "") continue;
        const c2 = lines[k].match(ctxRe);
        if (c2) { ctxv = parseInt(c2[1]); continue; }
        if (indentOf(lines[k]) <= mdl) break;
        extra = true;
      }
    }
    let e = i + 1;
    while (e < b && lines[e].trim() !== "" && indentOf(lines[e]) > mdl) e++;
    models.push({ id, ctx: ctxv, extra });
    i = e;
  }
  return models;
}

export function renderModels(models, mdl = 6, ctx = 8) {
  const lines = [];
  for (const m of models)
    if (m.ctx != null) lines.push(`${ind(mdl)}${yq(m.id)}:`, `${ind(ctx)}context_length: ${m.ctx}`);
    else lines.push(`${ind(mdl)}${yq(m.id)}: {}`);
  return lines;
}
// first line index after an entry that is not part of it (next entry / top-level key)
function entryEnd(lines, idx, listInd) {
  for (let k = idx + 1; k < lines.length; k++) {
    if (lines[k].trim() === "") continue;
    if (indentOf(lines[k]) <= listInd) return k;
  }
  return lines.length;
}

// replace (or create) an entry's models region; index arithmetic stays valid because
// the marker line is consumed from the replaced region and re-emitted fresh
export function hermesSetModels(lines, e, models) {
  if (e.flow) return lines; // flow-style entry: readable, never rewritten
  const body = renderModels(models, e.mdlInd, e.ctxInd);
  const marker = `${ind(e.fldInd)}models_discovered: true`;
  const markerRe = new RegExp("^ {" + e.fldInd + "}models_discovered:");
  if (e.modelsIdx >= 0) {
    let end = e.blockEnd;
    for (let k = end; k < e.end; k++) {
      if (lines[k].trim() === "") continue;
      if (markerRe.test(lines[k])) { end = k + 1; break; }
      break;
    }
    lines.splice(e.modelsIdx + 1, end - e.modelsIdx - 1, ...body, marker);
  } else {
    let at = e.end, have = false;
    for (let k = e.idx + 1; k < e.end; k++)
      if (markerRe.test(lines[k])) { at = k; have = true; break; }
    lines.splice(at, 0, `${ind(e.fldInd)}models:`, ...body, ...(have ? [] : [marker]));
  }
  return lines;
}

// set (or insert) a scalar field of an entry; located by content so it stays
// correct after a models-region splice shifted the line numbers
export function hermesSetField(lines, e, key, value) {
  if (e.flow) return; // see hermesSetModels
  const end = entryEnd(lines, e.idx, e.listInd);
  const re = new RegExp("^ {" + e.fldInd + "}" + key + ":");
  for (let k = e.idx + 1; k < end; k++)
    if (re.test(lines[k])) { lines[k] = `${ind(e.fldInd)}${key}: ${yq(value)}`; return; }
  let at = e.idx + 1;
  const baseRe = new RegExp("^ {" + e.fldInd + "}base_url:");
  for (let k = e.idx + 1; k < end; k++)
    if (baseRe.test(lines[k])) { at = k + 1; break; }
  lines.splice(at, 0, `${ind(e.fldInd)}${key}: ${yq(value)}`);
}
