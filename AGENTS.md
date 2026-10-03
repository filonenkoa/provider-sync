# AGENTS.md — instructions for AI agents

You are an AI agent (Hermes, OpenCode, Claude, …) on a machine where `provider-sync` is installed. This file tells you how to inspect and update local LLM provider state. Everything you need is below.

## What the tool does

Keeps local AI-agent configs in sync with local model servers (llama.cpp, LM Studio, Unsloth UI, any OpenAI-compatible endpoint): models added/removed, context windows, input modalities. Targets:

- **opencode** — `provider` definitions in the OpenCode config file;
- **hermes** — `custom_providers` entries in `~/.hermes/config.yaml`: `add` creates/updates them (matched by base URL), `sync` refreshes their offline fallback catalogs (`models:` maps) so Hermes' model picker works when a server is down.

## Golden rules

1. Run `provider-sync sync` (no `--apply`) **first** — it is read-only and shows exactly what would change.
2. Write only when the user asked for it (or the task explicitly includes applying). Writing commands: `sync --apply`, `add`, `set-ctx`. `add` writes to *every* installed harness (OpenCode + Hermes) — use `--no-hermes` when the user wants only OpenCode.
3. Never hand-edit the files this tool manages. The hermes top-level `model:` block is never touched; hermes model entries keep only `context_length` (other fields are dropped with a warning).
4. `OFFLINE (…) — skipped` or `AUTH 401` in output means the server is unreachable — report it to the user, do not retry in a loop. The rest of the run is unaffected.
5. `not found — skipped` in output means that harness is not installed on this machine (only the other target ran) — not an error, nothing to fix unless the user expects that harness.
6. Every write is atomic and preceded by a `.bak-provider-sync-*` backup (last 3 kept per file). A failed write does not corrupt config.
7. Every writing command ends with a `written:` block naming each target, what changed, and why anything was skipped (`skipped — not installed`, `skipped — refused to append…`). Read it and report it; a silent skip is a real result, not a bug.

## Commands (exact syntax)

| Command | Effect |
| --- | --- |
| `provider-sync list [--target all\|opencode\|hermes]` | per-harness overview: id/name, model count, baseURL, key status (Hermes: literal key, `~/.hermes/.env`, or borrowed from a matching OpenCode provider). Missing harness = `not found — skipped` |
| `provider-sync sync` | drift report, all targets, **nothing written** |
| `provider-sync sync --apply` | apply all drift (in a TTY it may ask interactively for ctx of new models whose server reports none; non-TTY omits such values with a note) |
| `provider-sync sync --target hermes` / `--target opencode` | single target; each target works standalone (hermes only borrows opencode API keys) |
| `provider-sync sync --provider ID` | opencode target, one provider |
| `provider-sync add <id> <baseURL> [--key K \| --username U --password P] [--model M] [--no-hermes] [--ctx N] [--output N] [--dry-run]` | register/update a provider (upsert — re-running is safe, existing model config is kept) in OpenCode **and** Hermes `custom_providers`; creates the OpenCode config if absent |
| `provider-sync set-ctx <id>` | interactively re-ask context; TTY required |

## Decision table

| Situation | Do |
| --- | --- |
| "what is the state / what changed?" | `provider-sync sync` — report the output, write nothing |
| user wants everything updated | `provider-sync sync`, then `provider-sync sync --apply` |
| user gives a new server URL | `provider-sync add <id> <url> --key K` (prefer `--dry-run` first if unsure); one command registers it in OpenCode and Hermes |
| Hermes picker is missing models | `provider-sync sync --apply --target hermes` |
| opencode config is stale only | `provider-sync sync --apply --target opencode` |
| server was down, now back | same as "everything updated" |

## Environment facts

- OpenCode config discovery: first existing of `opencode.jsonc`, `opencode.json`, `config.json` in `$OPENCODE_CONFIG_DIR` or `~/.config/opencode`. Override the path with `PS_CONFIG=/path/to/file`.
- Harnesses are independent: `sync` (and `list`) skip a target whose config file is absent instead of failing, so hermes-only and opencode-only machines are supported. `add` creates the OpenCode config when it is missing; `set-ctx` and an explicit `--target opencode` do need it.
- Hermes entries are matched by base URL, so `add` never duplicates a provider that is already there under another id. If the file uses a hand-made layout provider-sync does not recognise, it refuses to append and says so instead of guessing.
- API keys: OpenCode — `~/.local/share/opencode/auth.json` (managed by the tool; `--key` on `add` persists it). Hermes — `add` writes the key literally as `api_key:` (`dummy` for servers without auth); `sync` reads literal `api_key`, `${ENV}`/`key_env` from `~/.hermes/.env`, or borrows the OpenCode key of a provider pointing at the same server URL.
- Exit codes: `0` success; non-zero error (stderr explains what to do).

## Wrapping this tool in your own skill

Example — a Hermes skill whose body simply calls the CLI:

```yaml
---
name: provider-sync
description: Update local LLM provider state (models, ctx, modalities) for OpenCode and Hermes.
---
1. Run: provider-sync sync
2. Summarize pending changes.
3. If the user asked for an update, run: provider-sync sync --apply
4. Report the result. OFFLINE / AUTH 401 lines mean a server is unreachable — say so, stop.
```

The CLI is TTY-safe: outside a terminal it never prompts — it reports guesses as notes and omits what it cannot determine, so a skill can always run it non-interactively.
