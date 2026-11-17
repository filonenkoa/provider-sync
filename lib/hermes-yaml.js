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

// Hermes v12 accepts both spellings of its endpoint/default-model fields.
// Keep the normalized names internal, but remember which spelling the file
// used so a write never turns `api` into `base_url` (or the reverse).
const FIELD_TARGETS = {
  name: "name",
  base_url: "base_url", api: "base_url", url: "base_url",
  api_key: "api_key", key_env: "key_env", api_key_env: "key_env", key_cmd: "key_cmd",
  model: "model", default_model: "model",
  models_discovered: "modelsDiscovered",
  discover_models: "discoverModels",
  free_only: "freeOnly",
  enabled: "enabled",
  transport: "transport", api_mode: "transport",
};
const FIELD_NAMES = Object.keys(FIELD_TARGETS).join("|");
const boolValue = (v) => /^(true|yes|1|on)$/i.test(v);
function assignField(entry, field, raw) {
  const target = FIELD_TARGETS[field];
  if (!target) return false;
  const v = deq(raw.trim());
  if (target === "base_url") { entry.base_url = v; entry.baseField = field; }
  else if (target === "model") { entry.model = v; entry.modelField = field; }
  else if (target === "key_env") { entry.key_env = v; entry.keyEnvField = field; }
  else if (target === "enabled") entry.enabled = !/^(false|no|0|off)$/i.test(v);
  else if (target === "modelsDiscovered" || target === "discoverModels" || target === "freeOnly") entry[target] = boolValue(v);
  else entry[target] = v;
  return true;
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
    // a flow entry ("- {name: x, base_url: y}") is read but never rewritten:
    // our surgical edits are indent based and cannot patch inside braces
    if (m[2].trim().startsWith("{")) {
      const pairs = parseFlowMap(m[2].trim()) || [];
      const entry = {
        idx: i, end: e2, name: null, flow: true, listInd: li, fldInd: li + 2, mdlInd: li + 4, ctxInd: li + 6,
        base_url: null, baseField: null, api_key: null, key_env: null, keyEnvField: null, model: null, modelField: null,
        modelsIdx: -1, blockEnd: -1, models: [], modelsOk: false, modelsDiscovered: false,
        modelsShape: "map", enabled: true, section: "custom_providers",
      };
      for (const { key, value } of pairs) {
        if (key === "models") { const r = flowModels(value); entry.models = r.models; entry.modelsOk = r.ok; }
        else assignField(entry, key, value);
      }
      if (!entry.name) entry.name = entry.base_url || `unnamed (line ${i + 1})`;
      entries.push(entry);
      i = e2;
      continue;
    }
    // the dash line itself may carry the first field, e.g. "- base_url: ...";
    // only known provider fields count — an unknown key is still "not understood"
    const first = m[2].match(new RegExp("^(" + FIELD_NAMES + "):\\s*(\\S.*?)\\s*$"));
    const name0 = (() => { const nm = m[2].match(/^name:\s*(.*)$/); return nm ? deq(nm[1].trim()) : null; })();
    if (!first && !name0) { dashes++; i++; continue; }
    const entry = {
      idx: i, end: e2, name: name0, listInd: li, fldInd: fi, mdlInd: fi + 2, ctxInd: fi + 4,
      base_url: null, baseField: null, api_key: null, key_env: null, keyEnvField: null, model: null, modelField: null,
      modelsIdx: -1, blockEnd: -1, models: [], modelsDiscovered: false, modelsShape: "map", modelsOk: true,
      enabled: true, section: "custom_providers",
    };
    if (first) assignField(entry, first[1], first[2]);
    for (let k = i + 1; k < e2; k++) {
      const l = lines[k];
      if (l.trim() === "" || indentOf(l) !== fi) continue;
      const mm = l.slice(fi).match(/^models:(\s*(\{\}|\[\]))?\s*$/);
      if (mm) {
        // `models: {}` / `models: []` are how Hermes' own dumper spells an
        // empty catalog; the inline form is expanded before anything is added
        const inline = mm[2];
        entry.modelsInlineEmpty = inline === "{}" || inline === "[]";
        entry.modelsIdx = k;
        entry.modelsShape = inline === "[]" ? "list" : "map";
        let b = k + 1;
        while (b < e2 && (lines[b].trim() === "" || indentOf(lines[b]) > fi)) b++;
        entry.blockEnd = entry.modelsInlineEmpty ? k + 1 : b;
        if (!entry.modelsInlineEmpty) {
          const lay = modelsLayout(lines, k + 1, b, fi);
          entry.modelsShape = lay.shape;
          entry.mdlInd = lay.mdlInd;
          entry.ctxInd = lay.ctxInd;
          entry.models = lay.shape === "list"
            ? parseModelsList(lines, k + 1, b, lay.mdlInd)
            : parseModelsBlock(lines, k + 1, b, lay.mdlInd, lay.ctxInd);
        }
        continue;
      }
      const fm = l.slice(fi).match(new RegExp("^(" + FIELD_NAMES + "):\\s*(\\S.*?)\\s*$"));
      if (fm) assignField(entry, fm[1], fm[2]);
      // unknown fields are tolerated: the surgical writer never touches them
    }
    // display code expects a name; fall back to the base URL, then to the line number
    if (!entry.name) entry.name = entry.base_url || `unnamed (line ${i + 1})`;
    entries.push(entry);
    i = e2;
  }
  const li = listInd ?? 2;
  return { lines, entries, listInd: li, fldInd: entries[0]?.fldInd ?? li + 2, listEnd: i, unparsed: dashes, eol: text.includes("\r\n") ? "\r\n" : "\n", section: "custom_providers" };
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

// the canonical v12 spelling: a block list of model ids, each item optionally
// written as a mapping with `id` and `context_length`
//   models:
//     - qwen3.6:27b
//     - id: alpha
//       context_length: 4096
// `listInd` is the indentation of the dash itself.
export function parseModelsList(lines, a, b, listInd) {
  const models = [];
  const itemRe = new RegExp("^ {" + listInd + "}- +(.*)$");
  const ctxRe = /^ +context_length:\s*(\d+)\s*$/;
  let i = a;
  while (i < b) {
    const l = lines[i];
    if (l.trim() === "") { i++; continue; }
    const m = l.match(itemRe);
    if (!m) { i++; continue; }
    const raw = m[1].trim();
    const im = raw.match(/^id:\s*(.+?)\s*$/);
    if (im) {
      let ctx = null, extra = false, e = i + 1;
      while (e < b && (lines[e].trim() === "" || indentOf(lines[e]) > listInd)) {
        if (lines[e].trim()) {
          const c = lines[e].match(ctxRe);
          if (c) ctx = parseInt(c[1]);
          else extra = true;
        }
        e++;
      }
      models.push({ id: deq(im[1]), ctx, extra });
      i = e;
      continue;
    }
    // a scalar item is the model id; anything that looks like another mapping
    // key is not a shape provider-sync can rewrite safely
    const otherKey = /^[A-Za-z_][\w.-]*:\s/.test(raw);
    models.push({ id: deq(raw), ctx: null, extra: otherKey });
    i++;
  }
  return models;
}

// decide whether a models block is Hermes' mapping form or its list form, and
// which indentation the entries actually use (files are hand-edited)
export function modelsLayout(lines, a, b, baseInd) {
  for (let i = a; i < b; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const li = indentOf(l);
    if (/^- /.test(l.trimStart())) return { shape: "list", mdlInd: li, ctxInd: li + 2 };
    return { shape: "map", mdlInd: li, ctxInd: li + 2 };
  }
  return { shape: "map", mdlInd: baseInd + 2, ctxInd: baseInd + 4 };
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
  // an empty inline mapping becomes the block form the entries go under
  if (e.modelsInlineEmpty && e.modelsIdx >= 0) lines[e.modelsIdx] = `${ind(e.fldInd)}models:`;
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

// ---------- providers: (the v12+ mapping Hermes itself writes) ----------
// Hermes migrates the legacy `custom_providers:` list into a root `providers:`
// mapping on its next config version and drops the list, so a tool that only
// speaks the list stops managing Hermes the day that happens. The mapping is
// the same entry under a dict key, with the same field names, and the same
// line-surgical treatment: only an entry's own `models:` block is rewritten.
const dictValue = (raw, where) => {
  const v = deq(raw);
  if (/^[&*!|>]/.test(raw.trim()) || /(^|\s)#/.test(raw))
    throw new Error(`${where} is written in a form provider-sync will not rewrite (anchor, alias, tag, block scalar or comment)`);
  if (/^[{[]/.test(raw.trim()) && /[}\]]$/.test(raw.trim()))
    throw new Error(`${where} uses flow syntax — provider-sync will not rewrite it`);
  return v;
};

export function parseHermesProviders(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^providers:(\s*#.*)?$/.test(l));
  if (start < 0) return null;
  const inlineEmpty = /^providers:\s*\{\}\s*(#.*)?$/.test(lines[start]);
  if (lines[start].trim() !== "providers:" && !inlineEmpty)
    return { present: true, error: "providers: has a value on the same line — provider-sync will not rewrite it", lines, entries: [] };
  const entries = [];
  let keyInd = null;
  let end = lines.length;
  let unparsed = 0;
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") continue;
    const i2 = indentOf(l);
    if (i2 === 0) { end = k; break; }
    if (keyInd === null) keyInd = i2;
    if (i2 > keyInd) continue; // a nested list inside the previous entry
    if (l.includes("\t")) return { present: true, error: `providers: line ${k + 1}: a tab character — provider-sync will not rewrite it`, lines, entries: [] };
    const m = l.slice(i2).match(/^(.+?):(\s+(.*))?$/);
    if (!m) { unparsed++; continue; }
    const key = deq(m[1].trim());
    let e2 = k + 1;
    while (e2 < lines.length && (lines[e2].trim() === "" || indentOf(lines[e2]) > i2)) e2++;
    while (e2 > k + 1 && lines[e2 - 1].trim() === "") e2--;
    const fi = i2 + 2;
    const entry = {
      key, idx: k, end: e2, listInd: i2, fldInd: fi, mdlInd: fi + 2, ctxInd: fi + 4,
      name: null, base_url: null, baseField: null, api_key: null, key_env: null, keyEnvField: null,
      key_cmd: null, model: null, modelField: null, enabled: true,
      modelsIdx: -1, blockEnd: -1, models: [], modelsShape: "map", modelsOk: true,
      modelsDiscovered: false, flow: false, section: "providers",
    };
    if ((m[3] ?? "").trim() === "{}") {
      // an empty inline mapping: no fields, nothing to rewrite beyond adding them
      entries.push(entry);
      k = e2 - 1;
      continue;
    }
    if ((m[3] ?? "").trim() !== "") {
      return { present: true, error: `providers: line ${k + 1}: the entry "${key}" is written on one line — provider-sync will not rewrite it`, lines, entries: [] };
    }
    let lerr = null;
    try {
      for (let j = k + 1; j < e2; j++) {
        const f = lines[j];
        if (f.trim() === "") continue;
        if (f.trim().startsWith("#")) throw new Error(`providers: line ${j + 1}: a comment inside the "${key}" entry — provider-sync rewrites that entry's models and will not drop it`);
        if (indentOf(f) !== fi) continue; // a nested block of some field: left untouched
        const mm = f.slice(fi).match(/^models:(\s*(\{\}|\[\]))?\s*$/);
        if (mm) {
          // `models: {}` / `models: []` are Hermes' own spelling of an empty catalog
          const inline = mm[2];
          entry.modelsInlineEmpty = inline === "{}" || inline === "[]";
          entry.modelsIdx = j;
          entry.modelsShape = inline === "[]" ? "list" : "map";
          let b = j + 1;
          while (b < e2 && (lines[b].trim() === "" || indentOf(lines[b]) > fi)) b++;
          entry.blockEnd = entry.modelsInlineEmpty ? j + 1 : b;
          if (!entry.modelsInlineEmpty) {
            const lay = modelsLayout(lines, j + 1, b, fi);
            entry.modelsShape = lay.shape;
            entry.mdlInd = lay.mdlInd;
            entry.ctxInd = lay.ctxInd;
            entry.models = lay.shape === "list"
              ? parseModelsList(lines, j + 1, b, lay.mdlInd)
              : parseModelsBlock(lines, j + 1, b, lay.mdlInd, lay.ctxInd);
          }
          continue;
        }
        if (/^models:\s*\S/.test(f.slice(fi)))
          throw new Error(`providers: line ${j + 1}: "models:" has an inline value provider-sync will not rewrite`);
        const fm = f.slice(fi).match(new RegExp("^(" + FIELD_NAMES + "):(?:\\s+(.*))?$"));
        if (!fm) continue; // an unknown field: tolerated, never rewritten
        if (fm[2] === undefined || fm[2] === "")
          throw new Error(`providers: line ${j + 1}: "${fm[1]}:" holds a nested block provider-sync does not manage`);
        dictValue(fm[2], `providers: line ${j + 1}`);
        assignField(entry, fm[1], fm[2]);
      }
    } catch (e) { lerr = e.message; }
    if (lerr) return { present: true, error: lerr, lines, entries: [] };
    if (!entry.name) entry.name = entry.base_url || key;
    entries.push(entry);
    k = e2 - 1;
  }
  return {
    lines, entries, unparsed,
    keyInd: keyInd ?? 2,
    sectionEnd: end,
    inlineEmpty,
    present: true,
    section: "providers",
    error: null,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

// render one new entry of the mapping, ready to splice under `providers:`
export function renderProviderEntry(key, { name, base, keyValue, keyEnv, model, models }, keyInd = 2) {
  const fi = keyInd + 2;
  return [
    `${ind(keyInd)}${yq(key)}:`,
    `${ind(fi)}name: ${yq(name)}`,
    `${ind(fi)}base_url: ${yq(base)}`,
    `${ind(fi)}api_key: ${!keyEnv && keyValue ? yq(keyValue) : "dummy"}`,
    ...(keyEnv ? [`${ind(fi)}key_env: ${yq(keyEnv)}`] : []),
    ...(model ? [`${ind(fi)}model: ${yq(model)}`] : []),
    `${ind(fi)}models:`,
    ...renderModels(models, fi + 2, fi + 4),
    `${ind(fi)}models_discovered: true`,
  ];
}

// add a new entry to the mapping, creating the root `providers:` section when
// the file has none (it is a documented root key, default `{}`)
export function writeHermesProviders(text, key, spec) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const p = parseHermesProviders(text);
  const block = renderProviderEntry(key, spec, p?.keyInd ?? 2);
  if (!p) {
    const at = lines.length;
    const cut = at && lines[at - 1].trim() === "" ? at - 1 : at;
    // a blank line separates a freshly created section from the one before it
    const gap = cut > 0 ? [""] : [];
    return { text: [...lines.slice(0, cut), ...gap, "providers:", ...block, ""].join(eol), created: true };
  }
  if (p.error) throw new Error(p.error);
  if (p.inlineEmpty) lines[p.lines.findIndex((l) => /^providers:/.test(l))] = "providers:";
  let at = p.sectionEnd;
  while (at > 0 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, ...block);
  return { text: lines.join(eol), created: false };
}

// One Hermes config carries two provider surfaces: the v12+ `providers:` map
// and the legacy `custom_providers:` list. Hermes reads and merges both, so a
// tool that manages only one silently loses the other half. Parse both, and
// keep a flat `entries` view for callers that just walk providers.
export function parseHermesConfig(text) {
  const docs = [];
  const dict = parseHermesProviders(text);
  if (dict) docs.push({ form: "dict", section: "providers", entries: dict.entries, error: dict.error ?? null, unparsed: dict.unparsed ?? 0, keyInd: dict.keyInd ?? 2, sectionEnd: dict.sectionEnd });
  const list = parseHermes(text);
  if (list) docs.push({ form: "list", section: "custom_providers", entries: list.entries, error: null, unparsed: list.unparsed ?? 0, listInd: list.listInd, listEnd: list.listEnd });
  for (const d of docs) for (const e of d.entries) e.section = d.section;
  return {
    lines: text.split(/\r?\n/),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    docs,
    entries: docs.flatMap((d) => d.entries),
  };
}
