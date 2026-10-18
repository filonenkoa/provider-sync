# provider-sync

CLI to manage local LLM providers for [OpenCode](https://opencode.ai), Hermes Agent and DeepSeek Harness (`dsh`). Auto-detects the server type and keeps your config in sync with reality: which models exist, their context window, input modalities — plus keeps Hermes' offline model catalogs current so its picker works when a server is down.

> **AI agents:** see [AGENTS.md](AGENTS.md) — how to check provider state, add providers, and apply sync from an agent or a skill that wraps this tool.

Zero dependencies · Node ≥ 18 (built-in `fetch`) · Linux/macOS (all paths via `$HOME`).

## Install

```sh
git clone https://github.com/filonenkoa/provider-sync.git && cd provider-sync
npm link
```

`npm link` puts the symlink in `$(npm prefix -g)/bin` — whether that directory is on your `PATH` depends on how node was installed, so check it:

```sh
command -v provider-sync || echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
provider-sync --version   # 1.2.1
```

Prefer no npm? Symlink it into a directory you already keep bins in:

```sh
mkdir -p ~/.local/bin && ln -s "$PWD/bin/provider-sync.js" ~/.local/bin/provider-sync
```

`command not found` after installing always means "not in PATH", not a broken install. On Fedora/RHEL use `~/.bash_profile` instead of `~/.bashrc`.

No `npm install` — there are no dependencies. Needs Node >= 18 (built-in `fetch`).

## Quick start

```sh
provider-sync --version       # 1.2.1
provider-sync list            # what is configured, per harness
provider-sync sync            # status check, writes nothing (safe default)
provider-sync add 3090 http://10.0.0.5:64980/v1 --key <api-key>    # register a provider
provider-sync sync --apply    # apply drift: new/removed models, ctx, modalities
```

## Commands

| Command | What it does |
| --- | --- |
| `provider-sync list [--target all\|opencode\|hermes\|dsh] [--profile NAME]` | Providers per harness — id/name, model count, base URL, key status (for Hermes also where the key comes from, for dsh from the environment / the credential store / `~/.dsh/.env`); entries in OpenCode's 2.x `providers` shape are marked `(2.x)`. A harness that is not installed is reported as `not found — skipped`, so Hermes-only and OpenCode-only machines both work |
| `provider-sync add <id> <baseURL>` | Register/update a provider (upsert) in **every installed harness**: OpenCode config + Hermes (`providers:` mapping, or the legacy `custom_providers:` list when that is what the file has — matched by base URL, so re-running updates instead of duplicating) + the dsh `llm-pi-ai` config (matched by base URL, then by id). A harness that is not installed is skipped, not created — `--target opencode` creates the OpenCode config anyway, `--target dsh` creates a profile-agnostic `~/.dsh/settings.yaml` when no dsh home exists yet. Options: `--key`, `--key-env VAR` (store `{env:VAR}` / `apiKeyEnv` instead of the literal secret), `--username U --password P` (Unsloth UI auto-login + API-key creation; both required together), `--model`, `--target`, `--profile`, `--no-hermes`, `--ctx N`, `--output N`, `--dry-run` |
| `provider-sync sync [--apply] [--target all\|opencode\|hermes\|dsh] [--provider ID] [--profile NAME]` | Check/apply drift between servers and config; `--provider` is opencode-only and refuses unknown or disabled ids instead of reporting nothing to do; `--profile` picks the dsh profile whose patch layer is edited (default `web`) |
| `provider-sync set-ctx <provider>` | Interactively re-ask context for models whose server reports none (needs a TTY) |
| `provider-sync help` / `--version` | Full in-tool documentation / version |

Release notes: [CHANGELOG.md](CHANGELOG.md).

## How it works

**Server detection:** llama.cpp (`status.args`/`architecture` in `/v1/models`) → LM Studio (`/api/v0/models`, embeddings skipped) → Unsloth UI (root `/openapi.json`) → any OpenAI-compatible server.

**Context window, first match wins:**
1. server value — llama.cpp preset `--ctx-size`, LM Studio loaded/max context, Unsloth loaded context;
2. `--ctx N` flag (`0` = no limit);
3. interactive prompt in a TTY (a guess is shown, Enter accepts it);
4. omitted with a warning when non-interactive and no `--ctx`.

Sync never clobbers already-configured values — re-ask them with `provider-sync set-ctx <provider>`. Guesses are only ever used as hints for OpenCode; **Hermes receives server-reported context lengths only**.

**Modalities:** llama.cpp `architecture.input_modalities` is ground truth (corrects mis-declarations); otherwise heuristics on the model id (`qwen3.8*` → text+image+video, qwen/gemma → text+image).

## Files touched

| File | What provider-sync does |
| --- | --- |
| OpenCode config — `$OPENCODE_CONFIG` (an explicit config file) else the first existing of `opencode.jsonc` / `opencode.json` / `config.json` in `$OPENCODE_CONFIG_DIR` or `~/.config/opencode` (override: `PS_CONFIG`) | provider definitions (models, limits, modalities); skipped if OpenCode is not installed. `jsonc` wins over `json` on both engines; `config.json` exists only on 1.x (2.x ignores it, and provider-sync says so when a 2.x database is present) |
| `provider.<id>.options.apiKey` (1.x entry) / `providers.<id>.settings.apiKey` (2.x entry) | API key per provider — **what `add --key` writes**; OpenCode sends it as the bearer token. Each provider is written in exactly one shape: the one its entry already uses (`providers.<id>` entries are updated in place, with `package`/`settings`/`models`); a brand-new provider follows the file's dialect — 2.x shape in a config that has `providers` and no `provider`, legacy shape everywhere else. A second, partial entry for the same id would shadow and break the real one on 2.x, so provider-sync never writes it |
| `~/.local/share/opencode/auth.json` | API keys per provider id — OpenCode 1.x's own store. Read-only for provider-sync: presence is reported, the file is never written |
| `~/.hermes/config.yaml` | `custom_providers` entries — or, in a config that already carries it, the `providers:` mapping Hermes writes since v12 and migrates the list into: created/updated by `add`, and their `models:` maps refreshed by `sync` — surgical line edits, comments and other fields preserved; skipped if Hermes is not installed |
| `~/.dsh/settings.yaml` — the dsh home is `$DSH_HOME` (tilde expanded) or `~/.dsh` | the `llm-pi-ai` providers block of the pre-0.2 document. dsh imports this file into the active profile at its next boot and renames it `settings.yaml.imported`, so provider-sync writes here only while it exists (a re-created file is imported again) |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | the live provider state: the `config.providers` block of the `- id: llm-pi-ai` patch item (default profile `web`; `--profile NAME` picks another, `add` falls back to `settings.yaml` when there is no profile). Only the providers subtree is regenerated — the rest of the file survives byte for byte |
| `~/.dsh/.credentials.yaml` | dsh's credential store. `add --key` writes the value under the entry's reference (a new provider gets `<ID>_API_KEY`, dsh's own convention) with mode `600` — dsh refuses to load a store others can read; `--key-env VAR` sets `apiKeyEnv: VAR` and stores nothing; values are never printed |

Hermes entries written in **flow style** (one line inside `{...}`) are read and listed, but never rewritten — the surgical edits work on indented lines and cannot patch inside braces, so `sync` and `add` skip such an entry and say so. Fields other than `name`/`base_url`/`api_key`/`key_env`/`model`/`models`/`models_discovered` (for example `discover_models` or `free_only`) are preserved untouched and not managed.

**dsh** keeps its own reference resolution: a provider's `apiKeyEnv` is looked up in the launch environment first, then `~/.dsh/.credentials.yaml`, then `~/.dsh/.env`. A route that names **no** `apiKeyEnv` is authenticated by its own *record* in the store (`llm-pi-ai/<route>`) — that is what a dsh sign-in writes — so `list` reports the stored key (or reports a stored grant as signed-in but unreadable), `sync` probes with it, and `add` leaves such a route alone instead of inventing a reference that would override the credential dsh resolves itself. When a key is needed and none is known, `add` stores the placeholder `dummy` — an OpenAI-compatible route without any credential fails every request with `MISSING_CREDENTIAL`. A route is interrogated the way its `api:` says dsh interrogates it — the OpenAI protocols list at `{baseURL}/models` with a bearer token, `anthropic-messages` at `{root}/v1/models` with `x-api-key` — and `add` detects an Anthropic-compatible endpoint and writes `api: anthropic-messages` for it. A server reporting image input gets `input: [text, image]` on that model entry, because dsh's model schema has exactly two request modalities and text-only is its default; modalities dsh cannot express are left out rather than written (an out-of-schema input list would take the model out of every picker). The `llm-pi-ai` providers block is rewritten as a whole (dsh's own 2-space style, conservative quoting), so a block containing comments, anchors, aliases, tags (`!!js`), block scalars, flow mappings or tab indentation is **refused with the reason** instead of being silently mangled — including when an `insert:` list or a second `llm-pi-ai` item makes the live one ambiguous, and when a *home-level* `~/.dsh/cordis.patch.yml` (which wins over the profile's) targets `llm-pi-ai` too. Every dsh write is re-read afterwards and compared provider-by-provider; a mismatch rolls the file back from its backup. A route that tunes its installed catalog with `modelOverrides` and lists no models is refused (`skipped — …`) instead of being given a `models` list: dsh rejects the two together, and the rejection takes the route out of every picker. Provider fields provider-sync does not manage (`api`, `displayName`, timeouts, …) survive; only `baseURL`, `apiKeyEnv` and `models` are ever set on an existing entry (`api: openai-completions` is added only to a brand-new one).

Every write is atomic (tmp + fsync + rename) and preceded by a `.bak-provider-sync-*` backup (last 3 kept); the Hermes config and the dsh configs are re-read after writing and rolled back if they no longer parse (dsh: compared provider-by-provider). Writing commands (`add`, `sync --apply`, `set-ctx`) take an exclusive lock in the system temp directory (keyed by the config directory), so two runs can never interleave — read-only commands never take it. `--dry-run` never writes, in `add`, `sync` and `set-ctx` alike (it wins over `--apply` on the same line); an unknown flag or a value on a boolean flag (`--apply=false`) is refused instead of guessed, and so is a known flag that means nothing for the command it sits on (`sync --no-hermes` → `--target opencode`, `list --key`, `add --apply`) or a wrong number of positional arguments. `--help`/`-h` and `--version`/`-v` work on any command. Each provider is kept in exactly one entry shape, because a partial second entry would shadow and break the real one on OpenCode 2.x. Writes report per target — file, what changed, and why anything was skipped:

```
written:
  opencode  ~/.config/opencode/opencode.jsonc  provider "3090" (26 models)
  keys      ~/.local/share/opencode/auth.json  no change (no new key)
  hermes    ~/.hermes/config.yaml  custom_providers "100.64.0.10:64980" updated (26 models, model: IY/Qwen…)
  dsh       ~/.dsh/profiles/web/cordis.patch.yml  provider "3090" updated (26 models, key ref _3090_API_KEY)
  dsh-keys  ~/.dsh/.credentials.yaml  key "_3090_API_KEY" stored
``` Offline or auth-failing servers are reported and skipped without blocking the rest. Targets are independent: a missing config only skips its own target, so `sync` works on a hermes-only, opencode-only or dsh-only machine (the opencode config is additionally optional for hermes — it is only used to borrow API keys for providers pointing at the same server). Only an explicit `--target opencode` / `--provider ID` without an OpenCode config is an error.
