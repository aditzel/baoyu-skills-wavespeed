---
name: preferences-schema
description: EXTEND.md YAML schema for baoyu-image-gen user preferences
---

# Preferences Schema

```yaml
---
version: 1

default_provider: wavespeed   # wavespeed|google|openai|openrouter|dashscope|replicate|null
default_quality: 2k           # normal|2k|null
default_aspect_ratio: null    # "16:9"|"1:1"|"4:3"|"3:4"|"2.35:1"|null
default_image_size: null      # 1K|2K|4K|null

default_model:
  wavespeed: null             # e.g. "bytedance/seedream-v5.0-lite"
  google: null               # legacy alias profile, e.g. "google/nano-banana-pro/text-to-image"
  openai: null               # legacy alias profile, e.g. "openai/gpt-image-1.5/text-to-image"
  openrouter: null           # legacy alias profile
  dashscope: null            # legacy alias profile
  replicate: null            # legacy alias profile

batch:
  max_workers: 6
  provider_limits:
    wavespeed:
      concurrency: 3
      start_interval_ms: 700
---
```

## Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | int | 1 | Schema version |
| `default_provider` | string\|null | `wavespeed` | Default legacy profile alias |
| `default_quality` | string\|null | `2k` | Default quality preset |
| `default_aspect_ratio` | string\|null | null | Default aspect ratio |
| `default_image_size` | string\|null | null | Explicit size tier |
| `default_model.wavespeed` | string\|null | null | Preferred Wavespeed model ID |
| `default_model.<legacy-alias>` | string\|null | null | Optional profile-specific model override |
| `batch.max_workers` | int\|null | 6 | Batch worker cap |
| `batch.provider_limits.wavespeed.concurrency` | int\|null | 3 | Max simultaneous Wavespeed tasks |
| `batch.provider_limits.wavespeed.start_interval_ms` | int\|null | 700 | Minimum gap between task starts |

## Example

```yaml
---
version: 1
default_provider: wavespeed
default_quality: 2k
default_aspect_ratio: "16:9"
default_model:
  wavespeed: "bytedance/seedream-v5.0-lite"
batch:
  max_workers: 6
  provider_limits:
    wavespeed:
      concurrency: 3
      start_interval_ms: 700
---
```
