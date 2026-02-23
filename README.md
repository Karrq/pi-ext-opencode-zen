# pi-ext-opencode-zen

Pi ships with a hardcoded OpenCode provider, but its model list only updates when pi itself is updated. This extension replaces it with a dynamic version that fetches available models directly from Zen's `/v1/models` API at startup, so new models are available immediately without waiting for a pi release.

The extension enriches the live model list with metadata from models.dev (capabilities, routing, pricing).

## Features

- **Zen-authoritative model registry**: Uses Zen's `/v1/models` endpoint to determine which models are available
- **Models.dev metadata enrichment**: Augments Zen models with detailed metadata (capabilities, pricing, backend routing)
- **Multi-level caching**: Separate caches for Zen models and enriched metadata with robust fallback chain
- **Free model support**: Works without API key for zero-cost models (determined by `cost.input === 0 && cost.output === 0`)
- **Multi-backend routing**: Routes requests to correct streaming backend (Anthropic, OpenAI, Google, OpenAI-compatible)
- **Model change tracking**: Tracks free model availability changes with configurable notifications

## Installation

### From source

```bash
cd ~/.pi/extensions
git clone <repo-url> pi-ext-opencode-zen
```

### Usage

```bash
# With API key (full model access)
export OPENCODE_API_KEY=sk-...
pi -e pi-ext-opencode-zen

# Without API key (free models only)
pi -e pi-ext-opencode-zen
```

## Configuration

### Environment Variables

- `OPENCODE_API_KEY`: Your OpenCode API key. Optional if only using free models.
- `XDG_CACHE_HOME`: Cache directory base. Defaults to `~/.cache`.

### Extension Settings

Configure via pi's extension settings UI (`/extension-settings` command):

- **Free Model Change Notifications**: Enable/disable notifications when free model availability changes (default: on)

### Cache Location

Model data is cached at:
- `$XDG_CACHE_HOME/pi-ext-opencode-zen/zen-models.json` - Authoritative model ID list from Zen
- `$XDG_CACHE_HOME/pi-ext-opencode-zen/models.json` - Enriched model metadata from models.dev
- `$XDG_CACHE_HOME/pi-ext-opencode-zen/free-model-ids.json` - Tracked free model IDs for change detection

If `XDG_CACHE_HOME` is not set, defaults to `~/.cache/pi-ext-opencode-zen/`.

## How It Works

### Model Fetching Flow

The extension uses a **Zen-authoritative, models.dev-enrichment** architecture:

1. **Fetch authoritative model list** from Zen's `/v1/models` endpoint
   - Returns the canonical list of model IDs currently available on OpenCode
   - Cached to `zen-models.json`

2. **Fetch metadata enrichment** from `https://models.dev/api.json`
   - Provides detailed metadata: display names, pricing, capabilities, backend routing
   - Cached to `models.json`

3. **Build enriched model configs**
   - Only models present in Zen's list are registered
   - Enrichment metadata applied when available from models.dev
   - Models without enrichment use sensible defaults (openai-completions backend, zero cost, standard limits)

4. **Filter to free models** (if no API key)
   - Free models identified by `cost.input === 0 && cost.output === 0`
   - Tracks changes for notification

### Fallback Chain

The extension has a robust multi-level fallback strategy:

1. **Primary**: Fresh Zen API + fresh models.dev enrichment
2. **Level 1**: Cached Zen models + fresh models.dev enrichment
3. **Level 2**: Cached Zen models + cached models.dev enrichment
4. **Level 3**: Cached enriched models filtered to Zen cache (if Zen fetch fails but models.dev succeeds)
5. **Failure**: Error if no cached Zen models available

This ensures:
- The extension always respects Zen's authoritative model list
- Metadata enrichment degrades gracefully
- The extension works offline if caches exist
- Models not in Zen's list are never registered (even if in models.dev cache)

### Backend Routing

Each model's backend is determined from the models.dev `provider.npm` field:

| npm package | Backend | API |
|-------------|---------|-----|
| `@ai-sdk/anthropic` | Anthropic Messages | `anthropic-messages` |
| `@ai-sdk/openai` | OpenAI Responses | `openai-responses` |
| `@ai-sdk/google` | Google Generative AI | `google-generative-ai` |
| `@ai-sdk/openai-compatible` (or default) | OpenAI Completions | `openai-completions` |

If a model lacks enrichment metadata, it defaults to `openai-completions`.

All backends use the same base URL: `https://opencode.ai/zen/v1`

### Free Model Handling

Free model support works **with or without an API key**:

- Free models are identified by `cost.input === 0 && cost.output === 0` (from models.dev enrichment or defaults)
- When `OPENCODE_API_KEY` is not set, only free models are registered
- Free model IDs are tracked between sessions in `free-model-ids.json`
- When the free model list changes, a notification widget is shown (configurable via `/extension-settings`)
- Notification appears on first user interaction and auto-dismisses after 10 seconds
- The notification works regardless of API key presence (tracks changes even with API key set)

## Model Schema

The models.dev enrichment API provides metadata in this format:

```json
{
  "opencode": {
    "models": {
      "model-id": {
        "id": "model-id",
        "name": "Display Name",
        "cost": {
          "input": 0.01,
          "output": 0.03,
          "cache_read": 0.001,
          "cache_write": 0.0125
        },
        "limit": {
          "context": 200000,
          "output": 16384
        },
        "reasoning": true,
        "attachment": true,
        "tool_call": true,
        "modalities": ["text", "image"],
        "provider": {
          "npm": "@ai-sdk/anthropic",
          "api": "anthropic-messages"
        }
      }
    },
    "provider": {
      "npm": "@ai-sdk/openai-compatible",
      "api": "openai-completions"
    }
  }
}
```

**Note**: This is the models.dev enrichment schema, not Zen's `/v1/models` response. Zen returns a simpler list of model IDs, which is the authoritative source for which models exist.

## Development

### File Structure

```
pi-ext-opencode-zen/
├── index.ts          # Main extension
├── package.json      # Package config
├── tsconfig.json     # TypeScript config
└── README.md         # This file
```

### Testing

```bash
# Test with API key
export OPENCODE_API_KEY=sk-test-key
pi -e . "List available OpenCode models"

# Test without API key (free models only)
unset OPENCODE_API_KEY
pi -e . "List available free models"

# Test cache fallback (simulate Zen API failure)
rm ~/.cache/pi-ext-opencode-zen/zen-models.json
# Should fall back to cached models or fail gracefully

# Test enrichment fallback (simulate models.dev failure)
# Keep zen-models.json, remove models.json
rm ~/.cache/pi-ext-opencode-zen/models.json
# Should use defaults for enrichment

# Force complete refresh
rm -rf ~/.cache/pi-ext-opencode-zen/
pi -e .
```

### Debug Output

The extension logs:
- Zen model fetch failures (falls back to cache)
- Models.dev enrichment fetch failures (falls back to cache or defaults)
- Cache read/write failures
- Free model availability changes (when notifications enabled)
- Selected model not found warnings

## Troubleshooting

### "No cached Zen models available and API fetch failed"

Zen's `/v1/models` API is unreachable and no Zen cache exists. Solutions:
1. Check internet connection
2. Wait and retry (API might be temporarily down)
3. Check if `https://opencode.ai/zen/v1/models` is accessible in your browser
4. Use a different network (corporate firewall may be blocking)

### "Unknown model: model-id"

The selected model is no longer in Zen's authoritative list (removed from OpenCode). Solutions:
1. Switch to a different model from the current list
2. Check OpenCode status/announcements for model deprecations
3. Delete `zen-models.json` to force refresh (model might have been re-added)

### Models not appearing

Check:
1. **No API key + paid models**: Set `OPENCODE_API_KEY` to access non-free models
2. **Stale Zen cache**: Delete `~/.cache/pi-ext-opencode-zen/zen-models.json` to force refresh from Zen
3. **Network issues**: Verify both Zen API (`opencode.ai/zen/v1/models`) and models.dev are accessible
4. **Cache corruption**: Delete entire cache directory and retry

### Models showing with wrong metadata

Models.dev enrichment failed or returned stale data. The extension falls back to defaults (zero cost, openai-completions backend). Solutions:
1. Delete `models.json` to force re-fetch of enrichment data
2. Check if `https://models.dev/api.json` is accessible
3. Use the model anyway (it will work with default settings)

### Free model notifications not appearing

Check:
1. Notifications are enabled in `/extension-settings`
2. The free model list actually changed (check `free-model-ids.json`)
3. You're in an interactive session (notifications only show with UI)

## License

MIT
