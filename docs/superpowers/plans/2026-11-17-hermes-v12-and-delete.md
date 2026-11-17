# Hermes v12, удаление и dsh — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Исправить поддержку канонического Hermes v12 и обеих поверхностей, добавить удаление/восстановление провайдеров и моделей во всех harness'ах, выровнять dsh с upstream и закрыть миграцию OpenCode 2.x.

**Architecture:** Сначала расширяется line-based парсер Hermes (обе поверхности, канонические поля, списки моделей), затем bin-слой начинает обходить оба документа. Удаление строится на tombstones в отдельном state-файле, потому что `sync` server-authoritative и иначе возвращает удалённые модели. dsh получает правильный default ctx и Gemini-probe; OpenCode — команду `migrate` для native-формы.

**Tech Stack:** Node.js >= 18, ESM, `node:test`, без внешних зависимостей.

**Spec:** `docs/superpowers/specs/2026-11-17-hermes-v12-and-delete-design.md`

## Global Constraints

- Node.js >= 18, zero dependencies.
- Все записи атомарные, с `.bak-provider-sync-*` backup и read-back проверкой.
- Не переписывать верхнеуровневый `model:` Hermes.
- Не трогать OpenCode `auth.json`/`opencode.db`.
- `remove` без `--apply` ничего не пишет.
- Существующие тесты должны остаться зелёными; новые тесты пишутся первыми (TDD).
- Русский язык — только документация; код и комментарии на английском, как в проекте.

## Review Focus

- Hermes `models` списком и словарём: обе формы читаются и не теряются при записи.
- Одна сломанная запись Hermes не отключает остальные.
- `sync` после `remove <provider> --model` не возвращает модель.
- Удаление провайдера не оставляет вторую форму OpenCode или вторую поверхность Hermes.
- dsh Gemini endpoint не принимается за OpenAI и не ломает остальные route.

---

### Task 1: Hermes parser — канонические поля и списки моделей

**Files:**
- Modify: `lib/hermes-yaml.js`
- Test: `test/hermes-parse.test.js`

**Interfaces:**
- Produces: `parseHermesConfig(text) -> { lines, eol, docs, entries }`, где `docs` содержит `{ form, section, entries, error }`.
- Produces entry fields: `base_url`, `model`, `modelsShape`, `models`, `enabled`, `section`.
- Existing `parseHermes` and `parseHermesProviders` keep their names and return shapes, extended with the new fields.

- [ ] **Step 1: Write failing tests**

Add tests:

```js
test("parses canonical v12: api, default_model, models list", () => {
  const text = `providers:
  ollama-launch:
    api: http://127.0.0.1:11434/v1
    default_model: qwen3.6:35b-a3b-coding-nvfp4
    models:
      - qwen3.6:35b-a3b-coding-nvfp4
      - qwen3.6:27b-coding-nvfp4
    name: Ollama
`;
  const d = parseHermesProviders(text);
  assert.equal(d.entries[0].base_url, "http://127.0.0.1:11434/v1");
  assert.equal(d.entries[0].model, "qwen3.6:35b-a3b-coding-nvfp4");
  assert.deepEqual(d.entries[0].models.map((m) => m.id), ["qwen3.6:35b-a3b-coding-nvfp4", "qwen3.6:27b-coding-nvfp4"]);
  assert.equal(d.entries[0].modelsShape, "list");
});
```

Also: `enabled: false`, unknown field in one entry, both surfaces via `parseHermesConfig`, canonical list in legacy surface.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/hermes-parse.test.js`
Expected: FAIL — `base_url` undefined / `modelsShape` undefined.

- [ ] **Step 3: Implement field aliases and list parsing**

In `parseHermesProviders`:
- recognize `api|url|base_url`, `default_model|model`, `api_key|key_env|api_key_env|key_cmd`, `enabled`;
- parse `models:` as map (existing) or list (new `parseModelsList`);
- unknown field -> ignore, not section error;
- set `modelsShape`.
In `parseHermes` (legacy list): same aliases; parse `models:` list/map.
Add `parseHermesConfig(text)` that returns both docs.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/hermes-parse.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hermes-yaml.js test/hermes-parse.test.js
git commit -m "fix(hermes): parse canonical v12 fields and model lists"
```

---

### Task 2: Hermes writer — сохранять диалект и форму models

**Files:**
- Modify: `lib/hermes-yaml.js`
- Test: `test/hermes-parse.test.js`, `test/hermes-write.test.js`

**Interfaces:**
- `renderModels(models, mdl, ctx, shape = "map")` supports `"list"`.
- `hermesSetModels(lines, entry, models)` writes map or list according to `entry.modelsShape`.
- `renderProviderEntry(key, spec, keyInd)` writes `api`/`default_model` for `providers:`.

- [ ] **Step 1: Write failing tests**

- canonical v12 entry keeps `api` and `default_model`, updates models list in place;
- a list entry with ctx becomes list of `- id: ...` + `context_length`;
- a map entry stays map;
- `add --model` updates `default_model`.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/hermes-write.test.js`
Expected: FAIL — output still uses `base_url`/mapping.

- [ ] **Step 3: Implement writer**

Add list renderer. Detect existing field names in `hermesSetField`/`hermesUpsert`; do not add a second `model`/`default_model`. Keep `api` if present; write `api` for new dict entries.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/hermes-write.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hermes-yaml.js test/hermes-parse.test.js test/hermes-write.test.js
git commit -m "fix(hermes): preserve v12 field names and models shape"
```

---

### Task 3: Hermes bin integration — обе поверхности

**Files:**
- Modify: `bin/provider-sync.js`
- Test: `test/hermes-sync.test.js`, `test/list.test.js`, `test/add-targets.test.js`

**Interfaces:**
- Consumes `parseHermesConfig`, updated `parseHermesProviders`/`parseHermes`.
- Produces `hermesDocs(text) -> { lines, eol, docs, entries }`.
- `hermesUpsert` updates all matching entries across surfaces; creates in `providers:` when both exist.

- [ ] **Step 1: Write failing tests**

- live-like fixture with `providers:` canonical and `custom_providers:` list: both synced;
- `add` matches legacy list by base URL even when `providers:` exists;
- `enabled: false` not synced;
- one unknown field in one entry does not skip the rest;
- `list` shows both sections.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/hermes-sync.test.js test/list.test.js test/add-targets.test.js`
Expected: FAIL — only one section processed.

- [ ] **Step 3: Integrate**

Replace `hermesDoc` with `hermesDocs`; update `syncHermes`, `cmdList`, `hermesUpsert`, `verifyHermesWrite`. Sort edits bottom-up; report section names.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/hermes-sync.test.js test/list.test.js test/add-targets.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/provider-sync.js test/hermes-sync.test.js test/list.test.js test/add-targets.test.js
git commit -m "fix(hermes): manage providers and custom_providers together"
```

---

### Task 4: Tombstones и фильтрация

**Files:**
- Create: `lib/state.js`
- Modify: `bin/provider-sync.js`
- Test: `test/state.test.js`

**Interfaces:**
- `emptyState()`, `normalizeState(raw)`
- `isExcluded(state, { target, provider, baseURL, model }) -> boolean`
- `excludeModels(state, {...}) -> state`
- `restoreModels(state, {...}) -> state`
- `dropProvider(state, { target, provider, baseURL }) -> state`
- `filterServerModels(server, state, { target, provider, baseURL }) -> { server, hidden }`

- [ ] **Step 1: Write failing tests**

Unit tests for match by provider id and base URL, dedupe, restore, drop provider.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/state.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement state module**

Pure functions, no fs. State shape from spec.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/state.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/state.js test/state.test.js
git commit -m "feat(state): add model exclusion tombstones"
```

---

### Task 5: `remove`/`restore` — OpenCode и Hermes

**Files:**
- Modify: `bin/provider-sync.js`
- Test: `test/remove.test.js`

**Interfaces:**
- CLI `remove <id> [--model M]... [--apply] [--dry-run] [--target ...] [--force] [--purge-credentials] [--keep-exclusions]`
- CLI `restore <id> [--model M]... [--target ...]`
- `cmdRemove(id)`, `cmdRestore(id)`.

- [ ] **Step 1: Write failing integration tests**

- remove provider from OpenCode and Hermes; both shapes/surfaces gone;
- remove model; `sync --apply` does not return it;
- restore model; `sync --apply` returns it;
- dry-run leaves files untouched;
- default model reference refuses without `--force`;
- backups exist.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/remove.test.js`
Expected: FAIL — unknown command.

- [ ] **Step 3: Implement**

Add flags/CMD_SPEC/help. Implement state read/write, filtering in `reconcile` call sites, OpenCode/Hermes removal, default-ref checks, dry-run, backups. Use in-memory staging + rollback.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/remove.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/provider-sync.js test/remove.test.js
git commit -m "feat: remove and restore providers and models"
```

---

### Task 6: `remove`/`restore` — dsh

**Files:**
- Modify: `bin/provider-sync.js`
- Test: `test/remove.test.js`, `test/dsh.test.js`

**Interfaces:**
- dsh removal uses `parseDshSettings`/`writeDshSettings` or `parseDshPatch`/`writeDshPatch`.
- `--purge-credentials` deletes only an unreferenced store record.

- [ ] **Step 1: Write failing tests**

- remove dsh provider/model from profile patch and settings.yaml;
- sync does not re-add tombstoned model;
- purge credentials only when safe;
- missing dsh = skipped.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/remove.test.js test/dsh.test.js`
Expected: FAIL — dsh not handled.

- [ ] **Step 3: Implement**

Add dsh branch to `cmdRemove`; reuse dsh writers; preserve other fields.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/remove.test.js test/dsh.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/provider-sync.js test/remove.test.js test/dsh.test.js
git commit -m "feat(dsh): remove providers and models safely"
```

---

### Task 7: dsh default ctx и Gemini

**Files:**
- Modify: `bin/provider-sync.js`
- Test: `test/dsh.test.js`, `test/probe.test.js`

**Interfaces:**
- `DEFAULT_CTX = 1_000_000`.
- `DSH_PROTOCOLS` includes `google-generative-ai`.
- `probeDsh(base, "google-generative-ai", key)` -> `{ kind: "gemini", root, base }`.
- `fetchModels` / `probeDsh` parse Gemini list.

- [ ] **Step 1: Write failing tests**

- default ctx comparison uses 1M;
- Gemini listing `{models:[{name:"models/gemini-x", inputTokenLimit:123}]}` maps to `gemini-x` / ctx 123;
- `add` writes `api: google-generative-ai` for a Gemini endpoint.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/dsh.test.js test/probe.test.js`
Expected: FAIL — unsupported protocol.

- [ ] **Step 3: Implement**

Add protocol, probe, list parser, add detection; update `fetchModels` branch.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/dsh.test.js test/probe.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/provider-sync.js test/dsh.test.js test/probe.test.js
git commit -m "fix(dsh): use 1M default ctx and support Gemini routes"
```

---

### Task 8: OpenCode migrate

**Files:**
- Modify: `bin/provider-sync.js`
- Test: `test/opencode-2x.test.js`

**Interfaces:**
- CLI `migrate --target opencode [--apply] [--dry-run]`.
- `legacyToNative(entry) -> nativeEntry`.

- [ ] **Step 1: Write failing tests**

- legacy provider/model converts to native with `package`, `settings`, `capabilities`, `releaseDate`;
- unknown fields are preserved;
- dry-run writes nothing;
- schema validation passes;
- legacy entry removed only after native write.

- [ ] **Step 2: Run tests, verify failure**

Run: `node --test test/opencode-2x.test.js`
Expected: FAIL — unknown command.

- [ ] **Step 3: Implement**

Add command, conversion, backup/read-back. Skip entries that cannot be converted losslessly.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test test/opencode-2x.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/provider-sync.js test/opencode-2x.test.js
git commit -m "feat(opencode): migrate legacy providers to native 2.x shape"
```

---

### Task 9: Документация и полная проверка

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `bin/provider-sync.js` (HELP)
- Test: full suite

- [ ] **Step 1: Update docs**

Hermes both surfaces + canonical fields; dsh 1M + 4 protocols; remove/restore/migrate; tombstones.

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: all pass, 0 failures.

- [ ] **Step 3: Manual smoke test**

Run in a temp HOME with fixtures:
`provider-sync list`, `provider-sync sync`, `provider-sync remove --dry-run`, `provider-sync remove --apply`, `provider-sync restore`.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md CHANGELOG.md bin/provider-sync.js
git commit -m "docs: document Hermes v12, removal and dsh fixes"
```

---

## Execution

Native execution in this session (user asked to start after the plan). Follow TDD: write each test, watch it fail, implement, watch it pass, run the full suite before claiming completion.
