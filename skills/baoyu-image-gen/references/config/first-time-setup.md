---
name: first-time-setup
description: Optional first-time setup flow for baoyu-image-gen
---

# First-Time Setup

`baoyu-image-gen` no longer requires blocking setup before first use. If `WAVESPEED_API_KEY` is available, the skill can run immediately with built-in defaults.

Use this flow only when the user wants saved defaults.

## Suggested Questions

Ask in one call:

```yaml
- header: "Profile"
  question: "Default image generation profile?"
  options:
    - label: "Wavespeed (Recommended)"
      description: "Use the native Wavespeed defaults"
    - label: "Google"
      description: "Legacy alias mapped to Nano Banana defaults"
    - label: "OpenAI"
      description: "Legacy alias mapped to GPT Image defaults"

- header: "Quality"
  question: "Default image quality?"
  options:
    - label: "2k (Recommended)"
      description: "Better for covers, slides, and illustrations"
    - label: "normal"
      description: "Faster lower-resolution drafts"

- header: "Save"
  question: "Where to save preferences?"
  options:
    - label: "Project (Recommended)"
      description: ".baoyu-skills/ for this project"
    - label: "User"
      description: "~/.baoyu-skills/ for all projects"
```

## Template

```yaml
---
version: 1
default_provider: wavespeed
default_quality: 2k
default_aspect_ratio: null
default_image_size: null
default_model:
  wavespeed: bytedance/seedream-v5.0-lite
  google: null
  openai: null
  openrouter: null
  dashscope: null
  replicate: null
batch:
  max_workers: 6
  provider_limits:
    wavespeed:
      concurrency: 3
      start_interval_ms: 700
---
```
