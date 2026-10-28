# AGENTS.md — instructions for AI agents

You are an AI agent (Hermes, OpenCode, Claude, …) on a machine where `provider-sync` is installed. This file tells you how to inspect and update local LLM provider state. Everything you need is below.

## What the tool does

Keeps local AI-agent configs in sync with local model servers (llama.cpp, LM Studio, Unsloth UI, any OpenAI-compatible endpoint): models added/removed, context windows, input modalities. Targets:

- **opencode** — `provider` definitions in the OpenCode config file;
- **hermes** — `custom_providers` entries in `~/.hermes/config.yaml`, or the `providers:` mapping Hermes writes since config v12 (its v11→v12 migration moves the list there and deletes the list, so the mapping is what a migrated config has): `add` creates/updates them (matched by base URL), `sync` refreshes their offline fallback catalogs (`models:` maps) so Hermes' model picker works when a server is down;
- **dsh** (DeepSeek Harness) — the `llm-pi-ai` providers in the live profile patch (`~/.dsh/profiles/<name>/cordis.patch.yml`) or in `~/.dsh/settings.yaml` while dsh has not imported it yet. Keys live in `~/.dsh/.credentials.yaml` (written by `add --key`, mode 600, references like `<ID>_API_KEY`). `$DSH_HOME` moves the whole home; `--profile NAME` picks the profile (default `web`).

OpenCode models also get a release date (`releaseDate` in the native 2.x shape, `release_date` in the legacy one) that `sync` refreshes after 90 days: the desktop/web picker hides config-declared models whose date is missing or older than about six months. OpenCode 2.x drops legacy `release_date` during migration, so that part of the fix reaches the desktop picker only for native `providers.<id>` entries.

## Golden rules

1. Run `provider-sync sync` (no `--apply`) **first** — it is read-only and shows exactly what would change.
2. Write only when the user asked for it (or the task explicitly includes applying). Writing commands: `sync --apply`, `add`, `set-ctx`. `add` writes to every *installed* harness (OpenCode + Hermes + dsh) and never creates a config for one that is missing; `--target opencode|hermes|dsh` narrows it, `--no-hermes` is a shortcut for `--target opencode` (so dsh is not selected either — combine `--target` if you mean dsh only).
3. Never hand-edit the files this tool manages. The hermes top-level `model:` block is never touched; hermes model entries keep only `context_length` (other fields are dropped with a warning). dsh provider entries keep `api`/`displayName`/timeouts; only `baseURL`, `apiKeyEnv` and `models` are managed.
4. `OFFLINE (…) — skipped` or `AUTH 401` in output means the server is unreachable — report it to the user, do not retry in a loop. The rest of the run is unaffected.
5. `not found — skipped` in output means that harness is not installed on this machine (only the other target ran) — not an error, nothing to fix unless the user expects that harness.
6. Every write is atomic and preceded by a `.bak-provider-sync-*` backup (last 3 kept per file). A failed write does not corrupt config.
7. Every writing command ends with a `written:` block naming each target, what changed, and why anything was skipped (`skipped — not installed`, `skipped — refused to append…`). Read it and report it; a silent skip is a real result, not a bug.

## Commands (exact syntax)

| Command | Effect |
| --- | --- |
| `provider-sync list [--target all\|opencode\|hermes\|dsh] [--profile NAME]` | per-harness overview: id/name, model count, baseURL, key status (Hermes: literal key, `~/.hermes/.env`, or borrowed from a matching OpenCode provider; dsh: launch env, `~/.dsh/.credentials.yaml`, or `~/.dsh/.env`). Missing harness = `not found — skipped` |
| `provider-sync sync` | drift report, all targets, **nothing written** |
| `provider-sync sync --apply` | apply all drift (in a TTY it may ask interactively for ctx of new models whose server reports none; non-TTY omits such values with a note) |
| `provider-sync sync --target hermes` / `--target opencode` / `--target dsh` | single target; each target works standalone (hermes only borrows opencode API keys) |
| `provider-sync sync --provider ID` | opencode target, one provider |
| `provider-sync add <id> <baseURL> [--key K \| --username U --password P] [--model M] [--target all\|opencode\|hermes\|dsh] [--profile NAME] [--no-hermes] [--ctx N] [--output N] [--dry-run]` | register/update a provider (upsert — re-running is safe, existing model config is kept) in every **installed** harness: OpenCode config, Hermes `custom_providers` and the dsh `llm-pi-ai` config; a missing harness is skipped, `--target opencode` creates that config anyway, `--target dsh` creates a profile-agnostic `settings.yaml` when there is no dsh home yet |
| `provider-sync set-ctx <id>` | interactively re-ask context; TTY required |

## Decision table

| Situation | Do |
| --- | --- |
| "what is the state / what changed?" | `provider-sync sync` — report the output, write nothing |
| user wants everything updated | `provider-sync sync`, then `provider-sync sync --apply` |
| user gives a new server URL | `provider-sync add <id> <url> --key K` (prefer `--dry-run` first if unsure); one command registers it in OpenCode and Hermes |
| Hermes picker is missing models | `provider-sync sync --apply --target hermes` |
| opencode config is stale only | `provider-sync sync --apply --target opencode` |
| OpenCode desktop/web picker is missing local models | `provider-sync sync --apply --target opencode` — backfills `releaseDate`/`release_date`; on OpenCode 2.x only native `providers.<id>` entries keep it (2.x drops legacy `release_date` at migration) |
| dsh models/ctx stale, or a provider missing in dsh | `provider-sync sync --apply --target dsh` (add `--profile NAME` if the user does not run the default `web` profile) |
| server was down, now back | same as "everything updated" |

## Environment facts

- OpenCode config discovery mirrors the engine: `PS_CONFIG` (legacy `OCP_CONFIG`) overrides everything; otherwise `$OPENCODE_CONFIG` (an explicit config file — OpenCode loads it after the global one, so it wins) or the first existing of `opencode.jsonc`, `opencode.json`, `config.json` in `$OPENCODE_CONFIG_DIR` or `~/.config/opencode`. `config.json` is a 1.x name that 2.x ignores; provider-sync prints a note when that file is the one it edits and a 2.x database is present.
- Harnesses are independent: `sync` (and `list`) skip a target whose config file is absent instead of failing, so hermes-only, opencode-only and dsh-only machines are supported. `add` creates the OpenCode config when it is missing; `set-ctx` and an explicit `--target opencode` do need it.
- dsh: the home is `$DSH_HOME` (tilde expanded, blank = unset) else `~/.dsh`. Two surfaces, picked automatically: `~/.dsh/settings.yaml` while it exists (dsh imports it into the profile at the next boot and renames it `settings.yaml.imported` — a re-created file is imported again), else `~/.dsh/profiles/<name>/cordis.patch.yml`. Profile: `--profile NAME` wins, else `web`, else the only profile there is. Only the `llm-pi-ai` providers subtree is regenerated — everything else in the file survives byte for byte.
- dsh probing follows the entry's `api:` (its wire protocol), not one fixed server type: `openai-completions`/`openai-responses` list at `{baseURL}/models` with a bearer token (llama.cpp and LM Studio keep their richer listings), `anthropic-messages` at `{root}/v1/models` with `x-api-key` + `anthropic-version`. `add` detects an Anthropic-compatible endpoint and writes `api: anthropic-messages`; a protocol this build cannot serve is reported, never probed.
- dsh modalities: its model schema accepts exactly `text` and `image` (`MODALITIES` in llm-pi-ai) and falls back to text only when a model entry declares nothing — so server-reported image input is written as `input: [text, image]`, and modalities outside that enum (audio, video) are never written (they would fail the model schema and drop the model from every picker).
- dsh refusals (reported as `skipped — <reason>`, nothing written): a providers block with comments, anchors, aliases, tags (`!!js`), block scalars, flow mappings or tab indentation; `llm-pi-ai` nested in an `insert:` list, appearing twice, or in a home-level `~/.dsh/cordis.patch.yml` (which wins over the profile's); unrecognized layouts; and a route that tunes its installed catalog with `modelOverrides` and lists no models — dsh refuses a `models` list beside `modelOverrides`, and that rejection takes the route out of every picker. Do not try to work around a refusal by hand-editing — tell the user the reason.
- dsh keys resolve like dsh does: launch environment (`apiKeyEnv` variable) > `~/.dsh/.credentials.yaml` > `~/.dsh/.env`. A route that names no `apiKeyEnv` authenticates from its own store record (`llm-pi-ai/<route>`, what a dsh sign-in writes): its key is used to probe, a grant is reported as signed-in but unreadable, and no reference is invented over it (that would override the credential). `add --key` writes the store (mode 600 — dsh refuses a store others can read) under the entry's existing reference, or `<ID>_API_KEY` for a new provider; `--key-env VAR` sets `apiKeyEnv: VAR` and stores nothing; a keyless server gets the placeholder `dummy` (an OpenAI-compatible route needs one, or requests fail with `MISSING_CREDENTIAL`). A store value that is multi-line (block scalar) is reported as unreadable, never guessed.
- Hermes entries are matched by base URL, so `add` never duplicates a provider that is already there under another id. If the file uses a hand-made layout provider-sync does not recognise, it refuses to append and says so instead of guessing. The same base-URL matching applies to dsh (then by id: a moved server re-points its entry with a note).
- Hermes: an entry written in flow style (`- {name: x, base_url: y}`) is listed but never rewritten; `sync` and `add` skip it with a reason. Fields it does not manage (`discover_models`, `free_only`, …) are left exactly as written.
- API keys, OpenCode: **written by `add --key` into the provider entry of the user's config**, in the entry's own shape — `provider.<id>.options.apiKey` for a legacy entry, `providers.<id>.settings.apiKey` for a 2.x `providers` entry; a brand-new provider follows the file's dialect (2.x shape only in a config that has `providers` and no `provider`, legacy everywhere else). provider-sync never writes both shapes for one id: OpenCode 2.x lets a native `providers.<id>` entry replace the legacy one wholesale, so a partial native entry would shadow and break the provider. Verified against the real binary to arrive as the bearer token, on every version and with no interactive login. `--key-env VAR` stores `{env:VAR}` so the secret stays out of a file the user may commit. `add` re-reads the file afterwards and exits non-zero if the key is not there. OpenCode's own stores (`auth.json` on 1.x, `opencode.db` on 2.x) are read-only for provider-sync — presence is reported, values are never printed, and `--key K` on `sync`/`set-ctx` is single-run and never persisted. Hermes — `add` writes the key literally as `api_key:` (`dummy` for servers without auth; `--key-env VAR` writes `key_env: VAR` instead); `sync` reads literal `api_key`, `${ENV}`/`key_env` from `~/.hermes/.env`, or borrows the OpenCode key of a provider pointing at the same server URL — from the provider's config entry or `auth.json`, with a stored `{env:VAR}` resolved from the environment when probing (an unset variable is reported as such, not as a bad key).
- Exit codes: `0` success; non-zero error (stderr explains what to do). This includes flags that do not apply to the command (`sync --no-hermes` says to use `--target opencode`; `list --key`, `add --apply`, `set-ctx --target`/`set-ctx --profile` are the same kind), unknown or disabled `--provider` ids, `--provider` together with `--target hermes`/`--target dsh`, `--no-hermes` together with `--target hermes`/`--target dsh`, `--profile` with any target other than `all`/`dsh`, a `--profile` name that does not exist, and wrong positional counts. `--help`/`-h`/`--version`/`-v` work on any command (`add --help` prints help).

## Wrapping this tool in your own skill

Example — a Hermes skill whose body simply calls the CLI:

```yaml
---
name: provider-sync
description: Update local LLM provider state (models, ctx, modalities) for OpenCode, Hermes and DeepSeek Harness.
---
1. Run: provider-sync sync
2. Summarize pending changes.
3. If the user asked for an update, run: provider-sync sync --apply
4. Report the result. OFFLINE / AUTH 401 lines mean a server is unreachable — say so, stop.
```

The CLI is TTY-safe: outside a terminal it never prompts — it reports guesses as notes and omits what it cannot determine, so a skill can always run it non-interactively.
