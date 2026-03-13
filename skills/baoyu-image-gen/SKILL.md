---
name: baoyu-image-gen
description: AI image generation through Wavespeed. Supports text-to-image, reference-image editing, aspect ratios, prompt files, and batch generation from saved prompt files. Sequential by default; use batch parallel generation when the user already has multiple prompts or wants stable multi-image throughput. Use when user asks to generate, create, or draw images.
version: 1.56.2
metadata:
  openclaw:
    homepage: https://github.com/JimLiu/baoyu-skills#baoyu-image-gen
    requires:
      anyBins:
        - bun
        - npx
---

# Image Generation (Wavespeed)

Wavespeed-backed image generation wrapper. The published skill uses `wavespeed-cli` for portability. If a host agent already has Wavespeed MCP tools connected, that is an equivalent backend, but the script path remains the canonical contract for this skill.

## Script Directory

**Agent Execution**:
1. `{baseDir}` = this SKILL.md file's directory
2. Script path = `{baseDir}/scripts/main.ts`
3. Resolve `${BUN_X}` runtime: if `bun` installed → `bun`; if `npx` available → `npx -y bun`; else suggest installing bun

## Preferences

`EXTEND.md` is optional. If present, it is loaded from:

| Path | Location |
|------|----------|
| `.baoyu-skills/baoyu-image-gen/EXTEND.md` | Project directory |
| `$HOME/.baoyu-skills/baoyu-image-gen/EXTEND.md` | User home |

Supported preferences: default profile, default quality, default aspect ratio, default image size, default model IDs, batch worker cap, and Wavespeed throttling.

Schema: `references/config/preferences-schema.md`

## Usage

```bash
# Basic
${BUN_X} {baseDir}/scripts/main.ts --prompt "A cat" --image cat.png

# With aspect ratio
${BUN_X} {baseDir}/scripts/main.ts --prompt "A landscape" --image out.png --ar 16:9

# With prompt files
${BUN_X} {baseDir}/scripts/main.ts --promptfiles system.md content.md --image out.png

# With reference images
${BUN_X} {baseDir}/scripts/main.ts --prompt "Make it blue" --image out.png --ref source.png

# Explicit Wavespeed model
${BUN_X} {baseDir}/scripts/main.ts --prompt "A cat" --image out.png --model bytedance/seedream-v5.0-lite

# Legacy profile aliases preserved for compatibility
${BUN_X} {baseDir}/scripts/main.ts --prompt "A cat" --image out.png --provider google
${BUN_X} {baseDir}/scripts/main.ts --prompt "A cat" --image out.png --provider openai

# Batch mode
${BUN_X} {baseDir}/scripts/main.ts --batchfile batch.json
${BUN_X} {baseDir}/scripts/main.ts --batchfile batch.json --jobs 4 --json
```

## Options

| Option | Description |
|--------|-------------|
| `--prompt <text>`, `-p` | Prompt text |
| `--promptfiles <files...>` | Read prompt from files (concatenated) |
| `--image <path>` | Output image path (required in single-image mode) |
| `--batchfile <path>` | JSON batch file for multi-image generation |
| `--jobs <count>` | Worker count for batch mode |
| `--provider wavespeed\|google\|openai\|openrouter\|dashscope\|replicate` | Legacy profile selector. All profiles route through Wavespeed |
| `--model <id>`, `-m` | Wavespeed model ID override |
| `--ar <ratio>` | Aspect ratio (e.g. `16:9`, `1:1`, `3:4`) |
| `--size <WxH>` | Exact size (e.g. `2048x2048`) |
| `--quality normal\|2k` | Quality preset |
| `--imageSize 1K\|2K\|4K` | Size tier preset |
| `--ref <files...>` | Reference images. Routed to Wavespeed edit or edit-sequential |
| `--n <count>` | Number of requested images. `n > 1` routes to sequential generation |
| `--json` | JSON output |

## Backend Routing

The wrapper keeps the old CLI contract but routes commands by capability:

| Input | Wavespeed command |
|------|-------------------|
| No `--ref`, `--n 1` | `generate` |
| `--ref`, `--n 1` | `edit` |
| No `--ref`, `--n > 1` | `generate-sequential` |
| `--ref`, `--n > 1` | `edit-sequential` |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WAVESPEED_API_KEY` | Wavespeed API key |
| `WAVESPEED_IMAGE_MODEL` | Default model override |
| `BAOYU_IMAGE_GEN_MAX_WORKERS` | Batch worker cap |
| `BAOYU_IMAGE_GEN_WAVESPEED_CONCURRENCY` | Wavespeed concurrency override |
| `BAOYU_IMAGE_GEN_WAVESPEED_START_INTERVAL_MS` | Delay between Wavespeed task starts |

**Load Priority**: CLI args > EXTEND.md > env vars > `<cwd>/.baoyu-skills/.env` > `~/.baoyu-skills/.env`

## Model Resolution

Model priority:

1. CLI flag: `--model <id>`
2. EXTEND.md: `default_model.[provider]`
3. EXTEND.md: `default_model.wavespeed`
4. Env var: `WAVESPEED_IMAGE_MODEL`
5. Built-in Wavespeed defaults

**Agent MUST display model info** before each generation:
- Show: `Using wavespeed / [model]`
- Show switch hint: `Switch model: --model <id> | EXTEND.md default_model.* | env WAVESPEED_IMAGE_MODEL`

## Quality and Size

- `--size` wins when provided
- Otherwise `--imageSize` maps to `1K`, `2K`, or `4K`
- Otherwise `--quality` maps `normal -> 1K`, `2k -> 2K`
- Aspect ratios are resolved to explicit Wavespeed sizes locally before dispatch

## Batch File Format

```json
{
  "jobs": 4,
  "tasks": [
    {
      "id": "hero",
      "promptFiles": ["prompts/hero.md"],
      "image": "out/hero.png",
      "provider": "wavespeed",
      "model": "bytedance/seedream-v5.0-lite",
      "ar": "16:9",
      "quality": "2k"
    },
    {
      "id": "diagram",
      "promptFiles": ["prompts/diagram.md"],
      "image": "out/diagram.png",
      "ref": ["references/original.png"]
    }
  ]
}
```

Paths in `promptFiles`, `image`, and `ref` are resolved relative to the batch file's directory.

## Notes

- The script prefers a globally installed `wavespeed` binary when available.
- Otherwise it falls back to `npx -y wavespeed-cli`.
- Legacy `--provider` aliases are preserved to avoid breaking downstream skills, but all execution goes through Wavespeed.
