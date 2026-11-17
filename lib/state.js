// provider-sync's own state: the models the user deliberately removed. Every
// harness is server-authoritative, so without this record the next `sync`
// would add a removed model back. Pure functions only: the CLI owns the file.
import { normUrl } from "./hermes-yaml.js";

export const STATE_VERSION = 1;

export function emptyState() {
  return { version: STATE_VERSION, excluded: [] };
}

const clone = (state) => ({
  version: STATE_VERSION,
  excluded: state.excluded.map((e) => ({ ...e, models: [...e.models] })),
});
const cleanUrl = (u) => (typeof u === "string" && u.trim() ? u.trim() : null);
const cleanId = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const keyOf = (e) => `${e.target}\0${e.provider || ""}\0${normUrl(e.baseURL || "")}`;

// A tombstone belongs to a target and either a provider id or a server URL:
// either one is enough to recognize the provider after a rename or a move.
function matches(entry, { target, provider, baseURL }) {
  if (entry.target !== target) return false;
  if (provider && entry.provider && entry.provider === provider) return true;
  if (baseURL && entry.baseURL && normUrl(entry.baseURL) === normUrl(baseURL)) return true;
  return false;
}

export function normalizeState(raw) {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return emptyState(); }
  }
  if (!value || typeof value !== "object" || !Array.isArray(value.excluded)) return emptyState();
  const byKey = new Map();
  for (const rec of value.excluded) {
    if (!rec || typeof rec !== "object") continue;
    const target = cleanId(rec.target);
    const provider = cleanId(rec.provider);
    const baseURL = cleanUrl(rec.baseURL);
    if (!target || (!provider && !baseURL)) continue;
    if (!Array.isArray(rec.models)) continue;
    const models = rec.models.filter((m) => typeof m === "string" && m);
    if (!models.length) continue;
    const entry = { target, ...(provider ? { provider } : {}), ...(baseURL ? { baseURL } : {}), models: [] };
    const k = keyOf(entry);
    const prev = byKey.get(k);
    const targetEntry = prev || entry;
    for (const m of models) if (!targetEntry.models.includes(m)) targetEntry.models.push(m);
    byKey.set(k, targetEntry);
  }
  return { version: STATE_VERSION, excluded: [...byKey.values()] };
}

export function isExcluded(state, { target, provider, baseURL, model }) {
  const s = normalizeState(state);
  return s.excluded.some((e) => matches(e, { target, provider, baseURL }) && e.models.includes(model));
}

export function excludeModels(state, { target, provider, baseURL, models }) {
  const s = clone(normalizeState(state));
  const ids = (models || []).filter((m) => typeof m === "string" && m);
  if (!ids.length) return s;
  const id = cleanId(provider), url = cleanUrl(baseURL);
  if (!id && !url) return s;
  const entry = { target, ...(id ? { provider: id } : {}), ...(url ? { baseURL: url } : {}), models: [] };
  const found = s.excluded.find((e) => keyOf(e) === keyOf(entry));
  const box = found || entry;
  for (const m of ids) if (!box.models.includes(m)) box.models.push(m);
  if (!found) s.excluded.push(box);
  return s;
}

export function restoreModels(state, { target, provider, baseURL, models }) {
  const s = normalizeState(state);
  const only = (models || []).filter((m) => typeof m === "string" && m);
  const out = [];
  for (const e of s.excluded) {
    if (!matches(e, { target, provider, baseURL })) { out.push(e); continue; }
    if (!only.length) continue; // no model named: the whole provider is restored
    const kept = e.models.filter((m) => !only.includes(m));
    if (kept.length) out.push({ ...e, models: kept });
  }
  return { version: STATE_VERSION, excluded: out };
}

export function dropProvider(state, { target, provider, baseURL }) {
  return restoreModels(state, { target, provider, baseURL });
}

export function filterServerModels(server, state, query) {
  const s = normalizeState(state);
  const hidden = [];
  const kept = server.filter((m) => {
    if (!isExcluded(s, { ...query, model: m.id })) return true;
    hidden.push(m.id);
    return false;
  });
  return { server: kept, hidden };
}

// distinct model ids the state hides for this provider (for `list`)
export function hiddenCount(state, query) {
  const s = normalizeState(state);
  const ids = new Set();
  for (const e of s.excluded)
    if (matches(e, query)) for (const m of e.models) ids.add(m);
  return ids.size;
}
