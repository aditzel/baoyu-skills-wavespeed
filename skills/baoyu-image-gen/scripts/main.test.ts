import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(import.meta.dir, "main.ts");

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type InvocationLog = {
  binary: string;
  cwd: string;
  args: string[];
  command: string;
  prompt: string | null;
  size: string | null;
  outputDir: string | null;
  images: string[];
  maxImages: number;
  config: {
    models: {
      selected: {
        modelName: string;
      };
    };
    defaults: {
      commands: Record<string, string>;
    };
  };
};

const FAKE_WAVESPEED_SOURCE = String.raw`#!/usr/bin/env bun
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(args) {
  const out = {
    prompt: null,
    size: null,
    outputDir: null,
    images: [],
    maxImages: 1,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--prompt") {
      out.prompt = args[++i] ?? null;
      continue;
    }
    if (arg === "--size") {
      out.size = args[++i] ?? null;
      continue;
    }
    if (arg === "--output-dir") {
      out.outputDir = args[++i] ?? null;
      continue;
    }
    if (arg === "--images") {
      const value = args[++i] ?? "";
      out.images = value ? value.split(",").filter(Boolean) : [];
      continue;
    }
    if (arg === "--max-images") {
      const value = Number.parseInt(args[++i] ?? "1", 10);
      out.maxImages = Number.isFinite(value) && value > 0 ? value : 1;
    }
  }

  return out;
}

const binary = path.basename(process.argv[1] ?? "");
const rawArgs = process.argv.slice(2);
const isVersionCheck = binary === "npx"
  ? rawArgs[0] === "-y" && rawArgs[1] === "wavespeed-cli" && rawArgs[2] === "--version"
  : rawArgs[0] === "--version";

if (binary === "wavespeed" && process.env.FAKE_WAVESPEED_FAIL_VERSION === "1" && rawArgs[0] === "--version") {
  process.exit(1);
}

if (isVersionCheck) {
  console.log("fake-wavespeed 0.0.0");
  process.exit(0);
}

const args = binary === "npx" ? rawArgs.slice(2) : rawArgs;
const command = args[0] ?? "";
const parsed = parseArgs(args);
const configPath = path.join(process.cwd(), ".wavespeedrc.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

appendFileSync(
  process.env.FAKE_WAVESPEED_LOG,
  JSON.stringify({
    binary,
    cwd: process.cwd(),
    args,
    command,
    prompt: parsed.prompt,
    size: parsed.size,
    outputDir: parsed.outputDir,
    images: parsed.images,
    maxImages: parsed.maxImages,
    config,
  }) + "\n",
);

if (!parsed.outputDir) {
  throw new Error("Missing --output-dir");
}

mkdirSync(parsed.outputDir, { recursive: true });
for (let i = 0; i < parsed.maxImages; i += 1) {
  const fileName = String(i + 1).padStart(2, "0") + ".png";
  writeFileSync(path.join(parsed.outputDir, fileName), "fake-image-" + String(i + 1));
}
`;

async function makeTempDir(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `${name}-`));
}

async function writeExecutable(filePath: string, source: string): Promise<void> {
  await writeFile(filePath, source, "utf8");
  await chmod(filePath, 0o755);
}

async function createFakeRunner(tempRoot: string, options?: { includeWavespeed?: boolean; failWavespeedVersion?: boolean; includeNpx?: boolean }) {
  const binDir = path.join(tempRoot, "bin");
  const logPath = path.join(tempRoot, "wavespeed.log");
  await mkdir(binDir, { recursive: true });

  if (options?.includeWavespeed ?? true) {
    await writeExecutable(path.join(binDir, "wavespeed"), FAKE_WAVESPEED_SOURCE);
  }

  if (options?.includeNpx ?? false) {
    await writeExecutable(path.join(binDir, "npx"), FAKE_WAVESPEED_SOURCE);
  }

  return {
    binDir,
    logPath,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_WAVESPEED_LOG: logPath,
      ...(options?.failWavespeedVersion ? { FAKE_WAVESPEED_FAIL_VERSION: "1" } : {}),
    },
  };
}

async function runMain(args: string[], options: { cwd: string; env?: Record<string, string>; timeout?: number }): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      timeout: options.timeout ?? 120_000,
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : failure.stdout?.toString("utf8") ?? "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString("utf8") ?? "",
    };
  }
}

async function readInvocations(logPath: string): Promise<InvocationLog[]> {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InvocationLog);
}

describe("baoyu-image-gen Wavespeed CLI integration", () => {
  test("uses the wavespeed binary for single-image generation", async () => {
    const tempRoot = await makeTempDir("baoyu-image-gen-test");
    try {
      const runner = await createFakeRunner(tempRoot);
      const workspace = path.join(tempRoot, "workspace");
      await mkdir(workspace, { recursive: true });

      const result = await runMain(
        ["--prompt", "A cat in a hat", "--image", "out/cat.png", "--json"],
        {
          cwd: workspace,
          env: {
            ...runner.env,
            WAVESPEED_API_KEY: "test-key",
          },
        },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.command).toBe("generate");
      expect(await Bun.file(path.join(workspace, "out", "cat.png")).exists()).toBe(true);

      const invocations = await readInvocations(runner.logPath);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.binary).toBe("wavespeed");
      expect(invocations[0]?.command).toBe("generate");
      expect(invocations[0]?.prompt).toBe("A cat in a hat");
      expect(invocations[0]?.size).toBe("1408*1408");
      expect(invocations[0]?.config.models.selected.modelName).toBe("bytedance/seedream-v5.0-lite");
      expect(invocations[0]?.config.defaults.commands.generate).toBe("selected");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("uses edit-sequential for reference images with n > 1", async () => {
    const tempRoot = await makeTempDir("baoyu-image-gen-test");
    try {
      const runner = await createFakeRunner(tempRoot);
      const workspace = path.join(tempRoot, "workspace");
      const refsDir = path.join(workspace, "refs");
      await mkdir(refsDir, { recursive: true });
      await writeFile(path.join(refsDir, "source-1.png"), "ref-1");
      await writeFile(path.join(refsDir, "source-2.png"), "ref-2");

      const result = await runMain(
        [
          "--prompt",
          "Make it blue",
          "--image",
          "out/result.png",
          "--ref",
          "refs/source-1.png",
          "refs/source-2.png",
          "--n",
          "2",
          "--provider",
          "openai",
          "--json",
        ],
        {
          cwd: workspace,
          env: {
            ...runner.env,
            WAVESPEED_API_KEY: "test-key",
          },
        },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.command).toBe("edit-sequential");
      expect(payload.savedImages).toEqual([
        path.join(workspace, "out", "result.png"),
        path.join(workspace, "out", "result-02.png"),
      ]);
      expect(await Bun.file(path.join(workspace, "out", "result.png")).exists()).toBe(true);
      expect(await Bun.file(path.join(workspace, "out", "result-02.png")).exists()).toBe(true);

      const invocations = await readInvocations(runner.logPath);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.command).toBe("edit-sequential");
      expect(invocations[0]?.images).toEqual([
        path.join(workspace, "refs", "source-1.png"),
        path.join(workspace, "refs", "source-2.png"),
      ]);
      expect(invocations[0]?.maxImages).toBe(2);
      expect(invocations[0]?.config.models.selected.modelName).toBe("bytedance/seedream-v5.0-lite/edit-sequential");
      expect(invocations[0]?.config.defaults.commands["edit-sequential"]).toBe("selected");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("falls back to npx wavespeed-cli when the wavespeed binary is unavailable", async () => {
    const tempRoot = await makeTempDir("baoyu-image-gen-test");
    try {
      const runner = await createFakeRunner(tempRoot, {
        includeWavespeed: true,
        failWavespeedVersion: true,
        includeNpx: true,
      });
      const workspace = path.join(tempRoot, "workspace");
      await mkdir(workspace, { recursive: true });

      const result = await runMain(
        ["--prompt", "A fallback test", "--image", "out/fallback.png", "--json"],
        {
          cwd: workspace,
          env: {
            ...runner.env,
            WAVESPEED_API_KEY: "test-key",
          },
        },
      );

      expect(result.code).toBe(0);
      expect(await Bun.file(path.join(workspace, "out", "fallback.png")).exists()).toBe(true);

      const invocations = await readInvocations(runner.logPath);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.binary).toBe("npx");
      expect(invocations[0]?.args.slice(0, 2)).toEqual(["generate", "--prompt"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("runs batch tasks through the Wavespeed CLI and resolves prompt files relative to the batch file", async () => {
    const tempRoot = await makeTempDir("baoyu-image-gen-test");
    try {
      const runner = await createFakeRunner(tempRoot);
      const workspace = path.join(tempRoot, "workspace");
      const promptsDir = path.join(workspace, "prompts");
      const refsDir = path.join(workspace, "refs");
      await mkdir(promptsDir, { recursive: true });
      await mkdir(refsDir, { recursive: true });
      await writeFile(path.join(promptsDir, "hero.md"), "Hero skyline prompt");
      await writeFile(path.join(refsDir, "diagram.png"), "ref");

      const batchPath = path.join(workspace, "batch.json");
      await writeFile(
        batchPath,
        JSON.stringify(
          {
            jobs: 2,
            tasks: [
              {
                id: "hero",
                promptFiles: ["prompts/hero.md"],
                image: "out/hero.png",
                ar: "16:9",
              },
              {
                id: "diagram",
                prompt: "Revise the diagram",
                image: "out/diagram.png",
                ref: ["refs/diagram.png"],
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = await runMain(
        ["--batchfile", "batch.json", "--json"],
        {
          cwd: workspace,
          env: {
            ...runner.env,
            WAVESPEED_API_KEY: "test-key",
            BAOYU_IMAGE_GEN_WAVESPEED_CONCURRENCY: "4",
            BAOYU_IMAGE_GEN_WAVESPEED_START_INTERVAL_MS: "1",
          },
        },
      );

      expect(result.code).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.mode).toBe("batch");
      expect(payload.succeeded).toBe(2);
      expect(await Bun.file(path.join(workspace, "out", "hero.png")).exists()).toBe(true);
      expect(await Bun.file(path.join(workspace, "out", "diagram.png")).exists()).toBe(true);

      const invocations = await readInvocations(runner.logPath);
      expect(invocations).toHaveLength(2);
      const hero = invocations.find((item) => item.prompt === "Hero skyline prompt");
      const diagram = invocations.find((item) => item.prompt === "Revise the diagram");
      expect(hero?.command).toBe("generate");
      expect(hero?.size).toBe("1920*1088");
      expect(diagram?.command).toBe("edit");
      expect(diagram?.images).toEqual([path.join(workspace, "refs", "diagram.png")]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test.if(Boolean(process.env.WAVESPEED_API_KEY))(
    "runs a live smoke test against the real Wavespeed backend when WAVESPEED_API_KEY is set",
    async () => {
      const tempRoot = await makeTempDir("baoyu-image-gen-live");
      try {
        const outputPath = path.join(tempRoot, "live-smoke.png");
        const result = await runMain(
          [
            "--prompt",
            "A simple flat icon of a blue square on a white background",
            "--image",
            outputPath,
            "--quality",
            "normal",
            "--json",
          ],
          {
            cwd: tempRoot,
            env: {
              ...process.env,
            },
            timeout: 600_000,
          },
        );

        expect(result.code).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.command).toBe("generate");
        expect(await Bun.file(outputPath).exists()).toBe(true);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
