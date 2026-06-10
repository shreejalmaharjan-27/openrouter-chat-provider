# OpenRouter Chat Provider

Access **300+ AI models** from OpenRouter directly in VS Code Copilot Chat.

## Why This Extension?

### Reasoning Content Passthrough

This extension **correctly passes `reasoning` content back to the model** in multi-turn conversations. This is critical
for models like **DeepSeek V4** that require the full context (including previous reasoning tokens) to be included in
subsequent requests.

When a model returns reasoning tokens (the "thinking" process):
1. They're displayed in Copilot Chat via `LanguageModelThinkingPart`
2. They're **preserved and sent back** with assistant messages in the next turn

The built-in VS Code provider does not handle this correctly, making it incompatible with DeepSeek V4 and similar models
for multi-turn conversations.

### Reasoning Effort

For models that support reasoning (Claude, GPT, etc.), you can manually configure effort levels in `orcp.models`.
Available levels:
- **xhigh** — maximum reasoning depth
- **high** — deep reasoning
- **medium** — balanced
- **low** — faster, less thorough
- **minimal** — minimal reasoning

Each effort level creates a separate model entry in Copilot Chat (e.g., `Claude Sonnet 4 · High`).

## Fork-specific features

On top of upstream, this fork adds:

- **DeepSeek thinking-mode round-trip** — automatically injects `reasoning_content` at the HTTP layer for DeepSeek V3/V4 thinking models, fixing the 400 error in multi-turn / tool-call conversations.
- **Tool schema normalization** — Copilot Chat sometimes emits tool schemas with `type: null` (e.g. `terminal_last_command`); these are auto-coerced to `type: "object"` so strict providers like DeepSeek don't reject the request.
- **Per-model prompt caching opt-in** — set `cacheControl: true` per-model for Anthropic Claude and Google Gemini 2.5+ to get ~10% input-cost cached reads.
- **Provider routing** — `orcp.providerRouting: { "sort": "price" }` (or `"throughput"`, `"latency"`); pin to specific providers; allow/disallow fallbacks.
- **Default reasoning effort levels** — `orcp.defaultEffortLevels: ["high", "xhigh"]` applies to all reasoning-capable models without per-model config.
- **Image input** — vision-capable models receive `LanguageModelDataPart` inputs as `image_url` content parts (gated on `capabilities.imageInput`).
- **Session cost status bar** — running `$x.xxxx · N turns` in the bottom right; click for breakdown / reset.
- **`ORCP` output channel** — full lifecycle, request shape, and error logging for debugging (see Debugging section).
- **`ORCP: Configure Reasoning Effort for a Model` command** — Quick Pick flow to toggle effort variants per model without hand-editing JSON.
- **Fetches all OpenRouter models** — uses the unfiltered `/models` endpoint rather than `/models/user`, which respects your account's privacy/provider preferences and was hiding most of the catalog.

## Build & install from source

This fork is installed locally via VSIX so VSCode's marketplace can't auto-update it.

### Prerequisites

- Node.js 22+ and npm
- VSCode 1.117+
- The `code` CLI on your PATH (install from VSCode: `Cmd/Ctrl+Shift+P` → "Shell Command: Install 'code' command in PATH")

### Build

```bash
npm install
npm run local-build      # bundles + packages → openrouter-chat-provider-0.1.0-local.13.vsix
```

### Install

```bash
code --install-extension openrouter-chat-provider-0.1.0-local.13.vsix
```

### Disable auto-update (important)

Even after a VSIX install, VSCode will auto-update from the marketplace if the
`{publisher}.{name}` identifier matches. This fork uses `shreejalmaharjan-27` as
the publisher to break that match, but belt-and-braces:

- **Per-extension**: in the Extensions view, right-click "OpenRouter Chat Provider"
  → uncheck **Auto Update**.
- **Or globally**: set `"extensions.autoUpdate": false` in settings.

### Verify

```bash
code --list-extensions --show-versions
# Should show: shreejalmaharjan-27.openrouter-chat-provider@0.1.0-local.13
```

### Upgrade later

1. `git pull` from upstream into your fork
2. Re-audit the diff
3. Bump the `-local.N` suffix in `package.json`
4. Repeat the Build + Install steps above

## Session cost status bar

A status-bar item on the right shows running session cost and turn count with a gear (e.g. `$0.0234 · 4 turns ⚙`). Click it to open the settings page, which includes a live breakdown of tokens by category (prompt / completion / reasoning) and a reset button. Cost is taken from OpenRouter's per-turn usage reporting; the counter resets when the extension reloads.

## Tips for DeepSeek users (cheap / free)

DeepSeek is the budget alternative to Claude / GPT and works well in Copilot Chat.

```json
{
  "orcp.models": {
    "deepseek/deepseek-v4-pro":        { "enabled": true, "effortLevels": ["high", "xhigh"] },
    "deepseek/deepseek-v4-flash":      { "enabled": true },
    "deepseek/deepseek-v4-flash:free": { "enabled": true }
  },
  "orcp.providerRouting": { "sort": "price" }
}
```

- **Don't** set `cacheControl: true` on DeepSeek entries — DeepSeek caches prompt prefixes **automatically** at the provider level; you just get the discount.
- `orcp.providerRouting: { "sort": "price" }` is the biggest cost lever — multiple providers serve each DeepSeek model and per-token prices differ.
- `:free` variants are rate-limited (~100 req/day, ~50K tokens/req) — fine for casual chat, not for heavy iterative coding.

## Tips for Anthropic / Gemini users (caching)

Both Anthropic Claude and Google Gemini 2.5+ require **explicit** prompt-cache markers. Opt in per model:

```json
{
  "orcp.models": {
    "anthropic/claude-sonnet-4-5": { "enabled": true, "cacheControl": true, "effortLevels": ["high"] },
    "google/gemini-2.5-pro":       { "enabled": true, "cacheControl": true }
  }
}
```

With `cacheControl: true`, the extension tags the first user message and the last completed assistant message with `cache_control: { type: "ephemeral" }`. On subsequent turns the prior conversation reads from cache at ~10% of input cost. Verify in your OpenRouter dashboard's usage breakdown — cached input tokens appear as a separate line item.

## Quick Start

1. Install the extension
2. Get your API key from [OpenRouter](https://openrouter.ai/keys)
3. Run `ORCP: Set API Key` from the Command Palette
4. Run `Chat: Manage Language Models` and enable models you want to be visible in Copilot Chat picker
5. Open Copilot Chat and select model to use

## Configuration

### `orcp.baseUrl`

Custom OpenRouter API base URL (default: `https://openrouter.ai/api/v1`).

```json
{
  "orcp.baseUrl": "https://openrouter.ai/api/v1"
}
```

Useful for proxies, self-hosted instances, or testing.

### `orcp.models`

Per-model configuration. Keys are OpenRouter model IDs. Fields:

- `enabled` (boolean) — set to `false` to hide a model from the picker.
- `effortLevels` (string[]) — reasoning effort variants to expose as separate picker entries: `minimal`, `low`, `medium`, `high`, `xhigh`.
- `cacheControl` (boolean) — set to `true` for providers that require **explicit** prompt-cache markers (Anthropic Claude, Google Gemini 2.5+). Leave `false` for providers with automatic caching (DeepSeek, OpenAI).

```json
{
  "orcp.models": {
    "anthropic/claude-sonnet-4-5": {
      "enabled": true,
      "cacheControl": true,
      "effortLevels": ["low", "medium", "high"]
    },
    "google/gemini-2.5-pro": {
      "enabled": true,
      "cacheControl": true
    },
    "deepseek/deepseek-v4-pro": {
      "enabled": true,
      "effortLevels": ["high", "xhigh"]
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "enabled": false
    }
  }
}
```

**Notes:**

- Models not listed are **enabled by default** with no effort variants and no cache markers.
- Effort levels only work on models that support reasoning (e.g., Claude, GPT-5, DeepSeek thinking models).
- Model IDs can be found in the [OpenRouter model list](https://openrouter.ai/models).
- You don't have to edit this by hand — run `ORCP: Configure Reasoning Effort for a Model` to toggle effort variants via Quick Pick.

### `orcp.defaultEffortLevels`

Effort-level variants exposed for **every** reasoning-capable model that doesn't have an explicit `effortLevels` set in `orcp.models`. Saves typing if you want the same set of variants across the board.

```json
{
  "orcp.defaultEffortLevels": ["high", "xhigh"]
}
```

Set to `[]` (default) to disable global defaults — variants then only come from per-model config.

### `orcp.providerRouting`

OpenRouter [provider routing](https://openrouter.ai/docs/features/provider-routing). The biggest cost lever for models served by multiple providers (DeepSeek especially).

```json
{
  "orcp.providerRouting": {
    "sort": "price"
  }
}
```

Supported fields:

- `sort` — `"price"` / `"throughput"` / `"latency"`.
- `order` — array of provider names; requests are tried in order.
- `only` — array of provider names; requests are pinned to these.
- `allow_fallbacks` — boolean; whether routing can fall back to other providers on failure.

### Command safety (`orcp.commandSafety.*`)

Shows an inline 🟢 **Safe** / 🟠 **Caution** / 🔴 **Unsafe** verdict with a one-line reason **above every terminal command the agent proposes**, rendered as assistant markdown right above the command's confirmation card.

This is our own, fully independent feature — it does **not** depend on GitHub Copilot's built-in risk badge, its quota, or `chat.utilitySmallModel`. (We tried routing the core feature to a chosen model; the request never reaches a BYOK provider — see `risk-assessment-diagnostic-report.md`.) It is **advisory only**: it cannot cancel execution; you still approve via the normal confirmation card.

```json
{
  "orcp.commandSafety.enabled": true,
  "orcp.commandSafety.minLevelToShow": "green",
  "orcp.commandSafety.aiEvaluation": true,
  "orcp.commandSafety.model": "openai/gpt-4o-mini",
  "orcp.commandSafety.prompt": "",
  "orcp.commandSafety.allowList": ["npm run", "git status", "ls"],
  "orcp.commandSafety.denyList": ["rm -rf", "git push --force"],
  "orcp.commandSafety.modalOnRed": false
}
```

- `enabled` (default `true`) — master toggle.
- `minLevelToShow` (`green` | `orange` | `red`, default `green`) — only annotate at/above this severity. `green` annotates everything (including read-only); set `orange` to suppress notes on safe commands.
- `aiEvaluation` (default `true`) — evaluate **every** command with the model below for the best verdict. Turn off (or leave `model` empty) to use only the fast built-in local rules.
- `model` (default `""`) — model id (from this provider) used for evaluation. Pick a **fast, cheap** model — it runs on every terminal command. Reasoning is forced off and the call is time-limited (~6s); on timeout/error it falls back to the local rules.
- `prompt` (default `""`) — override the instruction sent to the model (the command is appended automatically). Empty = built-in default. Must instruct the model to reply with strict JSON `{"risk":"green|orange|red","reason":"..."}`. The settings page has a "Load built-in default to edit" button.
- `allowList` / `denyList` (default `[]`) — command **prefixes** (matched on a word boundary, e.g. `git status`, `rm -rf`) that are always forced 🟢 / 🔴 respectively, **skipping the model**. The block list wins over the allow list.
- `modalOnRed` (default `false`) — additionally pop a blocking warning dialog for 🔴 unsafe commands (still advisory).

Order of evaluation: **block list → allow list → model (if on) → local rules**. The built-in local rules (`git push --force`, `rm -rf` on source paths, `curl … | sh` and base64/obfuscated `… | sh` → red; `npm install`, `mkdir`, redirects → orange; `ls`/`cat`/`git status` → green) are always the fallback.

**Script inspection.** When a command runs or sources a local file (e.g. `python parse.py`, `bash deploy.sh`, `./run.sh`, `source x.sh`), the actual file contents are read — both files the agent just wrote and files already on disk — and folded into the verdict. This catches harmful or obfuscated payloads hidden inside a script that the innocent-looking command line wouldn't reveal (base64-decode-and-exec, `eval`/`exec` of encoded data, destructive commands in the file body).

**Evasion handling.** Rules run against de-obfuscated and decoded forms of the command, not just the raw text: token-splitting tricks (`--priv""ileged`, `d\ocker`, `/''etc`), `sh -c "…"` / `eval` / `$(…)` wrapping, and base64 payloads are unwrapped/decoded before matching (and decoded payloads are shown to the model too). Container escapes are caught deterministically: `--privileged`, `--cap-add`, `--security-opt …=unconfined`, host namespaces, the Docker socket, and **any sensitive host bind-mount** (`-v /etc`, `/home`, `/root`, `/`, …) — since a container runs as root, any host mount exposes host files — plus `nsenter`/`unshare` and reads of `/etc/shadow`, SSH keys, or `/proc/<pid>/root`.

### Secret protection (`orcp.commandSafety.redactSecretFiles`)

Separately from the advisory verdict, the extension **withholds the contents of sensitive files from the model** so they never leave your device. When the agent reads a secret file — via a file-read tool or a terminal command — the file's contents are replaced with a placeholder in the request before it is sent to OpenRouter.

```json
{
  "orcp.commandSafety.redactSecretFiles": true,
  "orcp.commandSafety.secretFilePatterns": ["*.token", "config/secrets.yml"]
}
```

- Built-in defaults cover `.env`/`.env.*`, `*.pem`/`*.key`/`*.pfx`/`*.p12`, `id_rsa`/`id_ed25519`/…, `.npmrc`/`.netrc`/`.git-credentials`, `**/.ssh/*`, `**/.aws/credentials`, `**/.gnupg/*`, and more. `.example`/`.sample`/`.template` files are never treated as secrets.
- `secretFilePatterns` adds your own globs on top of the defaults.
- Detection reuses the same de-obfuscation/decoding as above, so `cat .e""nv`, a base64-encoded path, or a runtime-built path (`chr(46)+chr(101)+…`, octal `\056\145…`, hex `\x2e`, `String.fromCharCode(...)`) is reconstructed and matched — against **all** patterns, including your custom ones. Symlinks to secret files are resolved too.
- `orcp.commandSafety.redactObfuscatedReads` (default off, aggressive): when on, the output of any command/script that is obfuscated enough that its target can't be statically resolved is withheld and flagged 🔴 — even when no secret file can be named. Closes the residual "runtime-built path we can't reconstruct" gap, at the cost of redacting some legitimate obfuscated commands.
- Scope/limit: this redacts what **this extension** sends to OpenRouter. It cannot redact data sent by VS Code itself or other extensions, and it correlates a tool result to its originating read; secrets pasted directly into chat or attached as context aren't covered.

All of these are editable from the **settings page** (`ORCP: Open Settings`) without touching JSON.

## Settings page

Instead of editing JSON, run **`ORCP: Open Settings`** (or click the ⚙ gear on the cost status-bar item) to open a single page where you can set your API key, base URL, provider routing, default effort levels, command-safety options, per-model enable/effort/cache toggles, and view live session usage. Every change is written straight to your `settings.json` (`orcp.*`) keys, so the page and manual JSON editing stay in sync.

## Commands

| Command | Description |
|---------|-------------|
| `ORCP: Open Settings` | Open the settings page (API key, models, command safety, provider routing, session usage); also opened by clicking the status bar |
| `ORCP: Set API Key` | Store your OpenRouter API key (encrypted in the OS keychain via VSCode's secret API) |
| `ORCP: Clear API Key` | Remove the stored API key |
| `ORCP: Show Session Details` | Token breakdown + cost for the current session (also shown in the settings page) |
| `ORCP: Configure Reasoning Effort for a Model` | Quick Pick to toggle effort variants per model without editing settings JSON |
| `ORCP: Reload Extension` | Re-run the registration flow — refetches the model list and reapplies config |

## Requirements

- VS Code 1.117.0 or later
- Copilot Chat extension installed
- OpenRouter API key ([get one here](https://openrouter.ai/keys))

## Debugging

The extension writes detailed logs to a dedicated **ORCP** output channel:

1. Open `View → Output`
2. Pick **ORCP** from the dropdown at the top right of the Output panel

What gets logged:

- Activation and registration lifecycle (`doRegister #N starting/complete`)
- Models fetched from OpenRouter + the filtered set actually registered
- Every chat request: model, effort, message count, tool count, cache-control flag
- Reasoning stream details (per-chunk arrivals, merged-by-index final shape)
- `beforeRequest` hook patches (e.g., `reasoning_content` injection for DeepSeek)
- Tool schema fixups (which Copilot tools had `type: null` and were normalized)
- Full HTTP error bodies on failure — including the actual API rejection text from the provider

When something fails, the ORCP channel is the first place to look — the actual upstream error appears there, not just the generic "Provider returned error" surface message.

## Troubleshooting

**"ORCP: Invalid API key"**
- Your API key is incorrect or expired
- Run `ORCP: Set API Key` to update it

**"ORCP: Insufficient credits"**
- Add credits at [openrouter.ai/credits](https://openrouter.ai/credits)

**"ORCP: Rate limit reached"**
- You've hit OpenRouter's rate limit
- Wait a moment ando/or check your [rate limit documentation](https://openrouter.ai/docs/api/reference/limits)

**Models not appearing**
- Ensure your API key is set
- Run `Developer: Reload Window` after changing settings

## License

MIT
