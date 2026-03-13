import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { BatchFile, BatchTaskInput, CliArgs, ExtendConfig, Provider } from "./types";

const execFileAsync = promisify(execFile);

type CommandName = "generate" | "edit" | "generate-sequential" | "edit-sequential";

type PreparedTask = {
  id: string;
  prompt: string;
  args: CliArgs;
  provider: Provider;
  model: string;
  outputPath: string;
  command: CommandName;
  size: string;
};

type TaskResult = {
  id: string;
  provider: Provider;
  model: string;
  command: CommandName;
  outputPath: string;
  outputPaths: string[];
  success: boolean;
  attempts: number;
  error: string | null;
};

type LoadedBatchTasks = {
  tasks: BatchTaskInput[];
  jobs: number | null;
  batchDir: string;
};

type Runner = {
  command: string;
  baseArgs: string[];
  env: Record<string, string>;
};

type RateLimit = {
  concurrency: number;
  startIntervalMs: number;
};

type SizePreset = "1K" | "2K" | "4K";

const MAX_ATTEMPTS = 3;
const DEFAULT_MAX_WORKERS = 6;
const POLL_WAIT_MS = 250;
const DEFAULT_RATE_LIMIT: RateLimit = {
  concurrency: 3,
  startIntervalMs: 700,
};

const DEFAULT_MODELS: Record<
  Provider,
  Record<CommandName, string | null>
> = {
  wavespeed: {
    generate: "bytedance/seedream-v5.0-lite",
    edit: "bytedance/seedream-v5.0-lite/edit",
    "generate-sequential": "bytedance/seedream-v5.0-lite/sequential",
    "edit-sequential": "bytedance/seedream-v5.0-lite/edit-sequential",
  },
  google: {
    generate: "google/nano-banana-pro/text-to-image",
    edit: "google/nano-banana-pro/edit",
    "generate-sequential": null,
    "edit-sequential": null,
  },
  openai: {
    generate: "openai/gpt-image-1.5/text-to-image",
    edit: "openai/gpt-image-1.5/edit",
    "generate-sequential": null,
    "edit-sequential": null,
  },
  openrouter: {
    generate: "bytedance/seedream-v5.0-lite",
    edit: "bytedance/seedream-v5.0-lite/edit",
    "generate-sequential": "bytedance/seedream-v5.0-lite/sequential",
    "edit-sequential": "bytedance/seedream-v5.0-lite/edit-sequential",
  },
  dashscope: {
    generate: "wavespeed-ai/z-image/turbo",
    edit: "wavespeed-ai/z-image-turbo/image-to-image",
    "generate-sequential": null,
    "edit-sequential": null,
  },
  replicate: {
    generate: "google/nano-banana-2/text-to-image",
    edit: "google/nano-banana-2/edit",
    "generate-sequential": null,
    "edit-sequential": null,
  },
};

const SIZE_PRESETS: Record<SizePreset, Record<string, string>> = {
  "1K": {
    "1:1": "1024*1024",
    "16:9": "1344*768",
    "9:16": "768*1344",
    "4:3": "1152*896",
    "3:4": "896*1152",
    "2.35:1": "1536*640",
  },
  "2K": {
    "1:1": "1408*1408",
    "16:9": "1920*1088",
    "9:16": "1088*1920",
    "4:3": "1664*1216",
    "3:4": "1216*1664",
    "2.35:1": "2176*960",
  },
  "4K": {
    "1:1": "4096*4096",
    "16:9": "4096*2304",
    "9:16": "2304*4096",
    "4:3": "4096*3072",
    "3:4": "3072*4096",
    "2.35:1": "4096*1792",
  },
};

let runnerPromise: Promise<Runner> | null = null;

function printUsage(): void {
  console.log(`Usage:
  npx -y bun scripts/main.ts --prompt "A cat" --image cat.png
  npx -y bun scripts/main.ts --promptfiles system.md content.md --image out.png
  npx -y bun scripts/main.ts --batchfile batch.json

Options:
  -p, --prompt <text>         Prompt text
  --promptfiles <files...>    Read prompt from files (concatenated)
  --image <path>              Output image path (required in single-image mode)
  --batchfile <path>          JSON batch file for multi-image generation
  --jobs <count>              Worker count for batch mode (default: auto, max from config)
  --provider wavespeed|google|openai|openrouter|dashscope|replicate
                              Legacy profile selector. All profiles run through Wavespeed.
  -m, --model <id>            Wavespeed model ID override
  --ar <ratio>                Aspect ratio (e.g., 16:9, 1:1, 4:3)
  --size <WxH>                Exact size (e.g., 2048x2048 or 2048*2048)
  --quality normal|2k         Quality preset (default: 2k)
  --imageSize 1K|2K|4K        Size preset tier (default: derived from quality)
  --ref <files...>            Reference images. Routed to Wavespeed edit/edit-sequential
  --n <count>                 Number of images for the current task (default: 1)
  --json                      JSON output
  -h, --help                  Show help

Batch file format:
  {
    "jobs": 4,
    "tasks": [
      {
        "id": "hero",
        "promptFiles": ["prompts/hero.md"],
        "image": "out/hero.png",
        "provider": "wavespeed",
        "model": "bytedance/seedream-v5.0-lite",
        "ar": "16:9"
      }
    ]
  }

Behavior:
  - Single image without refs: Wavespeed text-to-image
  - Single image with refs: Wavespeed image-to-image
  - Multi-image without refs: Wavespeed generate-sequential
  - Multi-image with refs: Wavespeed edit-sequential
  - Batch mode retries each task automatically up to 3 attempts

Environment variables:
  WAVESPEED_API_KEY           Wavespeed API key
  WAVESPEED_IMAGE_MODEL       Default Wavespeed model override
  BAOYU_IMAGE_GEN_MAX_WORKERS Override batch worker cap
  BAOYU_IMAGE_GEN_WAVESPEED_CONCURRENCY
                              Override Wavespeed concurrency
  BAOYU_IMAGE_GEN_WAVESPEED_START_INTERVAL_MS
                              Override gap between Wavespeed task starts

Env file load order: CLI args > EXTEND.md > process.env > <cwd>/.baoyu-skills/.env > ~/.baoyu-skills/.env`);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: null,
    model: null,
    aspectRatio: null,
    size: null,
    quality: null,
    imageSize: null,
    referenceImages: [],
    n: 1,
    batchFile: null,
    jobs: null,
    json: false,
    help: false,
  };

  const positional: string[] = [];

  const takeMany = (i: number): { items: string[]; next: number } => {
    const items: string[] = [];
    let j = i + 1;
    while (j < argv.length) {
      const v = argv[j]!;
      if (v.startsWith("-")) break;
      items.push(v);
      j += 1;
    }
    return { items, next: j - 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;

    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }

    if (a === "--json") {
      out.json = true;
      continue;
    }

    if (a === "--prompt" || a === "-p") {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      out.prompt = v;
      continue;
    }

    if (a === "--promptfiles") {
      const { items, next } = takeMany(i);
      if (items.length === 0) throw new Error("Missing files for --promptfiles");
      out.promptFiles.push(...items);
      i = next;
      continue;
    }

    if (a === "--image") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --image");
      out.imagePath = v;
      continue;
    }

    if (a === "--batchfile") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --batchfile");
      out.batchFile = v;
      continue;
    }

    if (a === "--jobs") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --jobs");
      out.jobs = parseInt(v, 10);
      if (!Number.isInteger(out.jobs) || out.jobs < 1) throw new Error(`Invalid worker count: ${v}`);
      continue;
    }

    if (a === "--provider") {
      const v = argv[++i] as Provider | undefined;
      if (
        v !== "wavespeed" &&
        v !== "google" &&
        v !== "openai" &&
        v !== "openrouter" &&
        v !== "dashscope" &&
        v !== "replicate"
      ) {
        throw new Error(`Invalid provider: ${v}`);
      }
      out.provider = v;
      continue;
    }

    if (a === "--model" || a === "-m") {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      out.model = v;
      continue;
    }

    if (a === "--ar") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --ar");
      out.aspectRatio = v;
      continue;
    }

    if (a === "--size") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --size");
      out.size = v;
      continue;
    }

    if (a === "--quality") {
      const v = argv[++i];
      if (v !== "normal" && v !== "2k") throw new Error(`Invalid quality: ${v}`);
      out.quality = v;
      continue;
    }

    if (a === "--imageSize") {
      const v = argv[++i]?.toUpperCase();
      if (v !== "1K" && v !== "2K" && v !== "4K") throw new Error(`Invalid imageSize: ${v}`);
      out.imageSize = v;
      continue;
    }

    if (a === "--ref" || a === "--reference") {
      const { items, next } = takeMany(i);
      if (items.length === 0) throw new Error(`Missing files for ${a}`);
      out.referenceImages.push(...items);
      i = next;
      continue;
    }

    if (a === "--n") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --n");
      out.n = parseInt(v, 10);
      if (!Number.isInteger(out.n) || out.n < 1) throw new Error(`Invalid count: ${v}`);
      continue;
    }

    if (a.startsWith("-")) {
      throw new Error(`Unknown option: ${a}`);
    }

    positional.push(a);
  }

  if (!out.prompt && out.promptFiles.length === 0 && positional.length > 0) {
    out.prompt = positional.join(" ");
  }

  return out;
}

async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, "utf8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

async function loadEnv(): Promise<void> {
  const home = homedir();
  const cwd = process.cwd();
  const homeEnv = await loadEnvFile(path.join(home, ".baoyu-skills", ".env"));
  const cwdEnv = await loadEnvFile(path.join(cwd, ".baoyu-skills", ".env"));

  for (const [key, value] of Object.entries(homeEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
  for (const [key, value] of Object.entries(cwdEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function extractYamlFrontMatter(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*$/m);
  return match ? match[1] : null;
}

function parseSimpleYaml(yaml: string): Partial<ExtendConfig> {
  const config: Partial<ExtendConfig> = {};
  const lines = yaml.split("\n");
  let currentKey: string | null = null;
  let currentProvider: Provider | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes(":") || trimmed.startsWith("-")) continue;

    const colonIdx = trimmed.indexOf(":");
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if (value === "null" || value === "") value = "null";

    if (key === "version") {
      config.version = value === "null" ? 1 : parseInt(value, 10);
      continue;
    }

    if (key === "default_provider") {
      config.default_provider = value === "null" ? null : (value as Provider);
      continue;
    }

    if (key === "default_quality") {
      config.default_quality = value === "null" ? null : (value as "normal" | "2k");
      continue;
    }

    if (key === "default_aspect_ratio") {
      const cleaned = value.replace(/['"]/g, "");
      config.default_aspect_ratio = cleaned === "null" ? null : cleaned;
      continue;
    }

    if (key === "default_image_size") {
      config.default_image_size = value === "null" ? null : (value as SizePreset);
      continue;
    }

    if (key === "default_model") {
      config.default_model = {
        wavespeed: null,
        google: null,
        openai: null,
        openrouter: null,
        dashscope: null,
        replicate: null,
      };
      currentKey = "default_model";
      currentProvider = null;
      continue;
    }

    if (key === "batch") {
      config.batch = {};
      currentKey = "batch";
      currentProvider = null;
      continue;
    }

    if (currentKey === "batch" && indent >= 2 && key === "max_workers") {
      config.batch ??= {};
      config.batch.max_workers = value === "null" ? null : parseInt(value, 10);
      continue;
    }

    if (currentKey === "batch" && indent >= 2 && key === "provider_limits") {
      config.batch ??= {};
      config.batch.provider_limits ??= {};
      currentKey = "provider_limits";
      currentProvider = null;
      continue;
    }

    if (
      currentKey === "default_model" &&
      (
        key === "wavespeed" ||
        key === "google" ||
        key === "openai" ||
        key === "openrouter" ||
        key === "dashscope" ||
        key === "replicate"
      )
    ) {
      const cleaned = value.replace(/['"]/g, "");
      config.default_model ??= {
        wavespeed: null,
        google: null,
        openai: null,
        openrouter: null,
        dashscope: null,
        replicate: null,
      };
      config.default_model[key] = cleaned === "null" ? null : cleaned;
      continue;
    }

    if (
      currentKey === "provider_limits" &&
      indent >= 4 &&
      (
        key === "wavespeed" ||
        key === "google" ||
        key === "openai" ||
        key === "openrouter" ||
        key === "dashscope" ||
        key === "replicate"
      )
    ) {
      config.batch ??= {};
      config.batch.provider_limits ??= {};
      config.batch.provider_limits[key] ??= {};
      currentProvider = key;
      continue;
    }

    if (
      currentKey === "provider_limits" &&
      currentProvider &&
      indent >= 6 &&
      (key === "concurrency" || key === "start_interval_ms")
    ) {
      config.batch ??= {};
      config.batch.provider_limits ??= {};
      const limit = (config.batch.provider_limits[currentProvider] ??= {});
      if (key === "concurrency") {
        limit.concurrency = value === "null" ? null : parseInt(value, 10);
      } else {
        limit.start_interval_ms = value === "null" ? null : parseInt(value, 10);
      }
    }
  }

  return config;
}

async function loadExtendConfig(): Promise<Partial<ExtendConfig>> {
  const home = homedir();
  const cwd = process.cwd();
  const paths = [
    path.join(cwd, ".baoyu-skills", "baoyu-image-gen", "EXTEND.md"),
    path.join(home, ".baoyu-skills", "baoyu-image-gen", "EXTEND.md"),
  ];

  for (const filePath of paths) {
    try {
      const content = await readFile(filePath, "utf8");
      const yaml = extractYamlFrontMatter(content);
      if (!yaml) continue;
      return parseSimpleYaml(yaml);
    } catch {
      continue;
    }
  }

  return {};
}

function mergeConfig(args: CliArgs, extend: Partial<ExtendConfig>): CliArgs {
  return {
    ...args,
    provider: args.provider ?? extend.default_provider ?? "wavespeed",
    quality: args.quality ?? extend.default_quality ?? null,
    aspectRatio: args.aspectRatio ?? extend.default_aspect_ratio ?? null,
    imageSize: args.imageSize ?? extend.default_image_size ?? null,
  };
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveBatchInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === "string") return parsePositiveInt(value);
  return null;
}

function getConfiguredMaxWorkers(extendConfig: Partial<ExtendConfig>): number {
  return Math.max(
    1,
    parsePositiveInt(process.env.BAOYU_IMAGE_GEN_MAX_WORKERS) ??
      extendConfig.batch?.max_workers ??
      DEFAULT_MAX_WORKERS,
  );
}

function getConfiguredRateLimit(extendConfig: Partial<ExtendConfig>): RateLimit {
  const configured = extendConfig.batch?.provider_limits?.wavespeed;
  return {
    concurrency:
      parsePositiveInt(process.env.BAOYU_IMAGE_GEN_WAVESPEED_CONCURRENCY) ??
      configured?.concurrency ??
      DEFAULT_RATE_LIMIT.concurrency,
    startIntervalMs:
      parsePositiveInt(process.env.BAOYU_IMAGE_GEN_WAVESPEED_START_INTERVAL_MS) ??
      configured?.start_interval_ms ??
      DEFAULT_RATE_LIMIT.startIntervalMs,
  };
}

async function readPromptFromFiles(files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const filePath of files) {
    parts.push(await readFile(filePath, "utf8"));
  }
  return parts.join("\n\n");
}

async function readPromptFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return value.length > 0 ? value : null;
}

function normalizeOutputImagePath(filePath: string): string {
  const fullPath = path.resolve(filePath);
  return path.extname(fullPath) ? fullPath : `${fullPath}.png`;
}

function normalizeSizeInput(value: string): string {
  const normalized = value.toLowerCase().replace(/x/g, "*");
  if (!/^\d+\*\d+$/.test(normalized)) {
    throw new Error(`Invalid size: ${value}. Use WIDTHxHEIGHT or WIDTH*HEIGHT.`);
  }
  return normalized;
}

function getSizeTier(args: CliArgs): SizePreset {
  if (args.imageSize) return args.imageSize as SizePreset;
  return args.quality === "normal" ? "1K" : "2K";
}

function resolveSize(args: CliArgs): string {
  if (args.size) return normalizeSizeInput(args.size);
  const ratio = args.aspectRatio ?? "1:1";
  const tier = getSizeTier(args);
  return SIZE_PRESETS[tier][ratio] ?? SIZE_PRESETS[tier]["1:1"];
}

function detectProvider(args: CliArgs): Provider {
  return args.provider ?? "wavespeed";
}

function resolveCommandName(args: CliArgs): CommandName {
  if (args.referenceImages.length > 0) {
    return args.n > 1 ? "edit-sequential" : "edit";
  }
  return args.n > 1 ? "generate-sequential" : "generate";
}

function getEnvModelForProvider(provider: Provider): string | null {
  if (process.env.WAVESPEED_IMAGE_MODEL) return process.env.WAVESPEED_IMAGE_MODEL;
  const envMap: Partial<Record<Provider, string | undefined>> = {
    google: process.env.GOOGLE_IMAGE_MODEL,
    openai: process.env.OPENAI_IMAGE_MODEL,
    openrouter: process.env.OPENROUTER_IMAGE_MODEL,
    dashscope: process.env.DASHSCOPE_IMAGE_MODEL,
    replicate: process.env.REPLICATE_IMAGE_MODEL,
  };
  return envMap[provider] ?? null;
}

function getDefaultModelForCommand(provider: Provider, command: CommandName): string {
  const selected = DEFAULT_MODELS[provider][command];
  if (selected) return selected;
  return DEFAULT_MODELS.wavespeed[command]!;
}

function getModelForTask(
  provider: Provider,
  command: CommandName,
  requestedModel: string | null,
  extendConfig: Partial<ExtendConfig>,
): string {
  if (requestedModel) return requestedModel;
  const extendModel = extendConfig.default_model?.[provider];
  if (extendModel) return extendModel;
  if (provider !== "wavespeed" && extendConfig.default_model?.wavespeed) {
    return extendConfig.default_model.wavespeed;
  }
  return getEnvModelForProvider(provider) ?? getDefaultModelForCommand(provider, command);
}

async function validateReferenceImages(referenceImages: string[]): Promise<void> {
  for (const refPath of referenceImages) {
    try {
      await access(path.resolve(refPath));
    } catch {
      throw new Error(`Reference image not found: ${path.resolve(refPath)}`);
    }
  }
}

function isRetryableGenerationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const nonRetryableMarkers = [
    "WAVESPEED_API_KEY",
    "Unknown model",
    "Invalid size",
    "Prompt is required",
    "Reference image not found",
    "--image is required",
    "Missing value",
  ];
  return !nonRetryableMarkers.some((marker) => message.includes(marker));
}

async function loadPromptForArgs(args: CliArgs): Promise<string | null> {
  let prompt = args.prompt;
  if (!prompt && args.promptFiles.length > 0) {
    prompt = await readPromptFromFiles(args.promptFiles);
  }
  return prompt;
}

async function prepareSingleTask(
  args: CliArgs,
  extendConfig: Partial<ExtendConfig>,
): Promise<PreparedTask> {
  if (!args.quality) args.quality = "2k";
  const prompt = (await loadPromptForArgs(args)) ?? (await readPromptFromStdin());
  if (!prompt) throw new Error("Prompt is required");
  if (!args.imagePath) throw new Error("--image is required");
  if (args.referenceImages.length > 0) await validateReferenceImages(args.referenceImages);

  const provider = detectProvider(args);
  const command = resolveCommandName(args);
  const model = getModelForTask(provider, command, args.model, extendConfig);

  return {
    id: "single",
    prompt,
    args,
    provider,
    model,
    outputPath: normalizeOutputImagePath(args.imagePath),
    command,
    size: resolveSize(args),
  };
}

async function loadBatchTasks(batchFilePath: string): Promise<LoadedBatchTasks> {
  const resolvedBatchFilePath = path.resolve(batchFilePath);
  const content = await readFile(resolvedBatchFilePath, "utf8");
  const parsed = JSON.parse(content.replace(/^\uFEFF/, "")) as BatchFile;
  const batchDir = path.dirname(resolvedBatchFilePath);
  if (Array.isArray(parsed)) {
    return { tasks: parsed, jobs: null, batchDir };
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.tasks)) {
    const jobs = parsePositiveBatchInt(parsed.jobs);
    if (parsed.jobs !== undefined && parsed.jobs !== null && jobs === null) {
      throw new Error("Invalid batch file. jobs must be a positive integer when provided.");
    }
    return { tasks: parsed.tasks, jobs, batchDir };
  }
  throw new Error("Invalid batch file. Expected an array of tasks or an object with a tasks array.");
}

function resolveBatchPath(batchDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(batchDir, filePath);
}

function createTaskArgs(baseArgs: CliArgs, task: BatchTaskInput, batchDir: string): CliArgs {
  return {
    ...baseArgs,
    prompt: task.prompt ?? null,
    promptFiles: task.promptFiles ? task.promptFiles.map((item) => resolveBatchPath(batchDir, item)) : [],
    imagePath: task.image ? resolveBatchPath(batchDir, task.image) : null,
    provider: task.provider ?? baseArgs.provider ?? null,
    model: task.model ?? baseArgs.model ?? null,
    aspectRatio: task.ar ?? baseArgs.aspectRatio ?? null,
    size: task.size ?? baseArgs.size ?? null,
    quality: task.quality ?? baseArgs.quality ?? null,
    imageSize: task.imageSize ?? baseArgs.imageSize ?? null,
    referenceImages: task.ref ? task.ref.map((item) => resolveBatchPath(batchDir, item)) : [],
    n: task.n ?? baseArgs.n,
    batchFile: null,
    jobs: baseArgs.jobs,
    json: baseArgs.json,
    help: false,
  };
}

async function prepareBatchTasks(
  args: CliArgs,
  extendConfig: Partial<ExtendConfig>,
): Promise<{ tasks: PreparedTask[]; jobs: number | null }> {
  if (!args.batchFile) throw new Error("--batchfile is required in batch mode");
  const { tasks: inputs, jobs: batchJobs, batchDir } = await loadBatchTasks(args.batchFile);
  if (inputs.length === 0) throw new Error("Batch file does not contain any tasks.");

  const prepared: PreparedTask[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const taskArgs = createTaskArgs(args, inputs[i]!, batchDir);
    const prompt = await loadPromptForArgs(taskArgs);
    if (!prompt) throw new Error(`Task ${i + 1} is missing prompt or promptFiles.`);
    if (!taskArgs.imagePath) throw new Error(`Task ${i + 1} is missing image output path.`);
    if (taskArgs.referenceImages.length > 0) await validateReferenceImages(taskArgs.referenceImages);

    const provider = detectProvider(taskArgs);
    const command = resolveCommandName(taskArgs);
    const model = getModelForTask(provider, command, taskArgs.model, extendConfig);

    prepared.push({
      id: inputs[i]!.id || `task-${String(i + 1).padStart(2, "0")}`,
      prompt,
      args: taskArgs,
      provider,
      model,
      outputPath: normalizeOutputImagePath(taskArgs.imagePath),
      command,
      size: resolveSize(taskArgs),
    });
  }

  return {
    tasks: prepared,
    jobs: args.jobs ?? batchJobs,
  };
}

async function resolveRunner(): Promise<Runner> {
  if (!runnerPromise) {
    runnerPromise = (async () => {
      try {
        await execFileAsync("wavespeed", ["--version"], { timeout: 10_000 });
        return {
          command: "wavespeed",
          baseArgs: [],
          env: {},
        };
      } catch {
        const npmCache = path.join(tmpdir(), "baoyu-image-gen-npm-cache");
        await mkdir(npmCache, { recursive: true });
        await execFileAsync(
          "npx",
          ["-y", "wavespeed-cli", "--version"],
          {
            timeout: 30_000,
            env: {
              ...process.env,
              npm_config_cache: npmCache,
            },
          },
        );
        return {
          command: "npx",
          baseArgs: ["-y", "wavespeed-cli"],
          env: {
            npm_config_cache: npmCache,
          },
        };
      }
    })();
  }
  return runnerPromise;
}

function buildWavespeedConfig(model: string, command: CommandName): string {
  return JSON.stringify(
    {
      models: {
        selected: {
          provider: "wavespeed",
          apiBaseUrl: "https://api.wavespeed.ai",
          apiKeyEnv: "WAVESPEED_API_KEY",
          modelName: model,
        },
      },
      defaults: {
        globalModel: "selected",
        commands: {
          [command]: "selected",
        },
      },
    },
    null,
    2,
  );
}

async function listGeneratedFiles(outputDir: string): Promise<string[]> {
  const entries = await readdir(outputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(outputDir, entry.name))
    .filter((filePath) => /\.(png|jpe?g|webp)$/i.test(filePath))
    .sort((left, right) => left.localeCompare(right));
}

function buildOutputPaths(outputPath: string, count: number): string[] {
  if (count <= 1) return [outputPath];
  const parsed = path.parse(outputPath);
  const ext = parsed.ext || ".png";
  const outputs = [outputPath];
  for (let index = 1; index < count; index += 1) {
    outputs.push(path.join(parsed.dir, `${parsed.name}-${String(index + 1).padStart(2, "0")}${ext}`));
  }
  return outputs;
}

async function moveGeneratedFiles(sourceFiles: string[], outputPath: string): Promise<string[]> {
  const destinations = buildOutputPaths(outputPath, sourceFiles.length);
  for (const destination of destinations) {
    await mkdir(path.dirname(destination), { recursive: true });
  }
  for (let index = 0; index < sourceFiles.length; index += 1) {
    await rename(sourceFiles[index]!, destinations[index]!);
  }
  return destinations;
}

async function runWavespeedTask(task: PreparedTask): Promise<TaskResult> {
  if (!process.env.WAVESPEED_API_KEY) {
    throw new Error("WAVESPEED_API_KEY is required for baoyu-image-gen.");
  }

  console.error(`Using wavespeed / ${task.model} for ${task.id}`);
  console.error("Switch model: --model <id> | EXTEND.md default_model.* | env WAVESPEED_IMAGE_MODEL");

  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const runner = await resolveRunner();
    const scratchDir = await mkdtemp(path.join(tmpdir(), "baoyu-image-gen-"));
    const outputDir = path.join(scratchDir, "output");

    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(scratchDir, ".wavespeedrc.json"), buildWavespeedConfig(task.model, task.command));

      const cliArgs = [...runner.baseArgs, task.command, "--prompt", task.prompt, "--size", task.size, "--output-dir", outputDir, "--sync"];
      if (task.args.referenceImages.length > 0) {
        cliArgs.push("--images", task.args.referenceImages.map((item) => path.resolve(item)).join(","));
      }
      if (task.command === "generate-sequential" || task.command === "edit-sequential") {
        cliArgs.push("--max-images", String(task.args.n));
      }

      await execFileAsync(runner.command, cliArgs, {
        cwd: scratchDir,
        env: {
          ...process.env,
          ...runner.env,
        },
        timeout: 600_000,
        maxBuffer: 1024 * 1024 * 10,
      });

      const generatedFiles = await listGeneratedFiles(outputDir);
      if (generatedFiles.length === 0) {
        throw new Error(`Wavespeed CLI completed without writing image files for ${task.id}.`);
      }

      const outputPaths = await moveGeneratedFiles(generatedFiles, task.outputPath);
      return {
        id: task.id,
        provider: task.provider,
        model: task.model,
        command: task.command,
        outputPath: outputPaths[0]!,
        outputPaths,
        success: true,
        attempts,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = attempts < MAX_ATTEMPTS && isRetryableGenerationError(error);
      if (!canRetry) {
        return {
          id: task.id,
          provider: task.provider,
          model: task.model,
          command: task.command,
          outputPath: task.outputPath,
          outputPaths: [],
          success: false,
          attempts,
          error: message,
        };
      }
      console.error(`[${task.id}] Attempt ${attempts}/${MAX_ATTEMPTS} failed, retrying...`);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  return {
    id: task.id,
    provider: task.provider,
    model: task.model,
    command: task.command,
    outputPath: task.outputPath,
    outputPaths: [],
    success: false,
    attempts: MAX_ATTEMPTS,
    error: "Unknown failure",
  };
}

function createExecutionGate(limit: RateLimit) {
  let active = 0;
  let lastStartedAt = 0;

  return async function acquire(): Promise<() => void> {
    while (true) {
      const now = Date.now();
      if (active < limit.concurrency && now - lastStartedAt >= limit.startIntervalMs) {
        active += 1;
        lastStartedAt = now;
        return () => {
          active = Math.max(0, active - 1);
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_WAIT_MS));
    }
  };
}

function getWorkerCount(taskCount: number, jobs: number | null, maxWorkers: number): number {
  const requested = jobs ?? Math.min(taskCount, maxWorkers);
  return Math.max(1, Math.min(requested, taskCount, maxWorkers));
}

async function runBatchTasks(
  tasks: PreparedTask[],
  jobs: number | null,
  extendConfig: Partial<ExtendConfig>,
): Promise<TaskResult[]> {
  if (tasks.length === 1) {
    return [await runWavespeedTask(tasks[0]!)];
  }

  const maxWorkers = getConfiguredMaxWorkers(extendConfig);
  const rateLimit = getConfiguredRateLimit(extendConfig);
  const acquire = createExecutionGate(rateLimit);
  const workerCount = getWorkerCount(tasks.length, jobs, maxWorkers);

  console.error(`Batch mode: ${tasks.length} tasks, ${workerCount} workers, Wavespeed backend enabled.`);
  console.error(`- wavespeed: concurrency=${rateLimit.concurrency}, startIntervalMs=${rateLimit.startIntervalMs}`);

  let nextIndex = 0;
  const results: TaskResult[] = new Array(tasks.length);

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= tasks.length) return;
      const release = await acquire();
      try {
        results[currentIndex] = await runWavespeedTask(tasks[currentIndex]!);
      } finally {
        release();
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function printBatchSummary(results: TaskResult[]): void {
  const successCount = results.filter((item) => item.success).length;
  const failureCount = results.length - successCount;

  console.error("");
  console.error("Batch generation summary:");
  console.error(`- Total: ${results.length}`);
  console.error(`- Succeeded: ${successCount}`);
  console.error(`- Failed: ${failureCount}`);

  if (failureCount > 0) {
    console.error("Failure reasons:");
    for (const result of results.filter((item) => !item.success)) {
      console.error(`- ${result.id}: ${result.error}`);
    }
  }
}

function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

async function runSingleMode(args: CliArgs, extendConfig: Partial<ExtendConfig>): Promise<void> {
  const task = await prepareSingleTask(args, extendConfig);
  const result = await runWavespeedTask(task);
  if (!result.success) {
    throw new Error(result.error || "Generation failed");
  }

  if (args.json) {
    emitJson({
      savedImage: result.outputPaths[0] ?? result.outputPath,
      savedImages: result.outputPaths,
      provider: result.provider,
      model: result.model,
      command: result.command,
      attempts: result.attempts,
      prompt: task.prompt.slice(0, 200),
    });
    return;
  }

  console.log(result.outputPaths[0] ?? result.outputPath);
  for (const extraPath of result.outputPaths.slice(1)) {
    console.log(extraPath);
  }
}

async function runBatchMode(args: CliArgs, extendConfig: Partial<ExtendConfig>): Promise<void> {
  const { tasks, jobs } = await prepareBatchTasks(args, extendConfig);
  const results = await runBatchTasks(tasks, jobs, extendConfig);
  printBatchSummary(results);

  if (args.json) {
    emitJson({
      mode: "batch",
      total: results.length,
      succeeded: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success).length,
      results,
    });
  }

  if (results.some((item) => !item.success)) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  await loadEnv();
  const extendConfig = await loadExtendConfig();
  const mergedArgs = mergeConfig(args, extendConfig);
  if (!mergedArgs.quality) mergedArgs.quality = "2k";

  if (mergedArgs.batchFile) {
    await runBatchMode(mergedArgs, extendConfig);
    return;
  }

  await runSingleMode(mergedArgs, extendConfig);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
