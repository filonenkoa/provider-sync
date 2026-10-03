# provider-sync

CLI to manage local LLM providers for [OpenCode](https://opencode.ai) and Hermes Agent (more agent targets planned, e.g. DeepSeek Harness). Auto-detects the server type and keeps your config in sync with reality: which models exist, their context window, input modalities — plus keeps Hermes' offline model catalogs current so its picker works when a server is down.

> **AI agents:** see [AGENTS.md](AGENTS.md) — how to check provider state, add providers, and apply sync from an agent or a skill that wraps this tool.

Zero dependencies · Node ≥ 18 (built-in `fetch`) · Linux/macOS (all paths via `$HOME`).

## Install

```sh
git clone https://github.com/filonenkoa/provider-sync.git && cd provider-sync
npm link    # or: ln -s "$PWD/bin/provider-sync.js" ~/.local/bin/provider-sync
```

No `npm install` — there are no dependencies.

## Quick start

```sh
provider-sync sync            # status check, writes nothing (safe default)
provider-sync add 3090 http://10.0.0.5:64980/v1 --key <api-key>    # register a provider
provider-sync sync --apply    # apply drift: new/removed models, ctx, modalities
```

## Commands

| Command | What it does |
| --- | --- |
| `provider-sync list` | Providers, model counts, key status |
| `provider-sync add <id> <baseURL>` | Register/update a provider (upsert) in **every installed harness**: OpenCode config + `custom_providers` in Hermes (matched by base URL, so re-running updates instead of duplicating). Creates the OpenCode config if absent. Options: `--key`, `--username/--password` (Unsloth auto-login + API-key creation), `--model`, `--no-hermes`, `--ctx N`, `--output N`, `--dry-run` |
| `provider-sync sync [--apply] [--target all\|opencode\|hermes] [--provider ID]` | Check/apply drift between servers and config |
| `provider-sync set-ctx <provider>` | Interactively re-ask context for models whose server reports none (needs a TTY) |
| `provider-sync help` / `--version` | Full in-tool documentation / version |

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
| OpenCode config — first existing of `opencode.jsonc` / `opencode.json` / `config.json` in `$OPENCODE_CONFIG_DIR` or `~/.config/opencode` (override: `PS_CONFIG`) | provider definitions (models, limits, modalities); skipped if OpenCode is not installed |
| `~/.local/share/opencode/auth.json` | API keys per provider id |
| `~/.hermes/config.yaml` | `custom_providers` entries: created/updated by `add`, and their `models:` maps refreshed by `sync` — surgical line edits, comments and other fields preserved; skipped if Hermes is not installed |

Every write is atomic (tmp + fsync + rename) and preceded by a `.bak-provider-sync-*` backup (last 3 kept); the Hermes config is re-read after writing and rolled back if it no longer parses. Writing commands (`add`, `sync --apply`, `set-ctx`) take an exclusive lock at `~/.config/opencode/.provider-sync.lock`, so two runs can never interleave — read-only commands never take it. Writes report per target — file, what changed, and why anything was skipped:

```
written:
  opencode  ~/.config/opencode/opencode.jsonc  provider "3090" (26 models)
  keys      ~/.local/share/opencode/auth.json  no change (no new key)
  hermes    ~/.hermes/config.yaml  custom_providers "100.64.0.10:64980" updated (26 models, model: IY/Qwen…)
``` Offline or auth-failing servers are reported and skipped without blocking the rest. Targets are independent: a missing config only skips its own target, so `sync` works on a hermes-only or opencode-only machine (the opencode config is additionally optional for hermes — it is only used to borrow API keys for providers pointing at the same server). Only an explicit `--target opencode` / `--provider ID` without an OpenCode config is an error.
