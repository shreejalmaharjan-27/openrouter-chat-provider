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

## Build & install from source

This fork is installed locally via VSIX so VSCode's marketplace can't auto-update it.

### Prerequisites

- Node.js 22+ and npm
- VSCode 1.117+
- The `code` CLI on your PATH (install from VSCode: `Cmd/Ctrl+Shift+P` → "Shell Command: Install 'code' command in PATH")

### Build

```bash
npm install
npm run local-build      # bundles + packages → openrouter-chat-provider-0.1.0-local.11.vsix
```

### Install

```bash
code --install-extension openrouter-chat-provider-0.1.0-local.11.vsix
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
# Should show: shreejalmaharjan-27.openrouter-chat-provider@0.1.0-local.11
```

### Upgrade later

1. `git pull` from upstream into your fork
2. Re-audit the diff
3. Bump the `-local.N` suffix in `package.json`
4. Repeat the Build + Install steps above

## Session cost status bar

A status-bar item on the right shows running session cost and turn count (e.g. `$0.0234 · 4 turns`). Click it to see a breakdown of tokens by category (prompt / completion / reasoning) and reset the counter. Cost is taken from OpenRouter's per-turn usage reporting; the counter resets when the extension reloads.

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
4. Open Copilot Chat and select model to use

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

Per-model configuration. Keys are OpenRouter model IDs. Set `enabled` to false to hide a model. Use `effortLevels` to expose reasoning effort variants (low, medium, high) for supported models.

```json
{
  "orcp.models": {
    "anthropic/claude-sonnet-4-5": {
      "enabled": true,
      "effortLevels": ["low", "medium", "high"]
    },
    "openai/gpt-4o": {
      "enabled": true,
      "effortLevels": []
    },
    "meta-llama/llama-3.3-70b-instruct": {
      "enabled": false
    }
  }
}
```

**Notes:**
- Models not listed are **enabled by default** with no effort variants
- Effort levels only work on models that support reasoning (e.g., Claude, GPT-5)
- Model IDs can be found in the [OpenRouter model list](https://openrouter.ai/models)

## Commands

| Command | Description |
|---------|-------------|
| `ORCP: Set API Key` | Store your OpenRouter API key |
| `ORCP: Clear API Key` | Remove the stored API key |

## Requirements

- VS Code 1.117.0 or later
- Copilot Chat extension installed
- OpenRouter API key ([get one here](https://openrouter.ai/keys))

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
