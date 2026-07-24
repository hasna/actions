import { spawn } from "node:child_process";
import type {
  ActionDefinition,
  ActionExecutionContext,
  ActionManifest,
  ActionPreview,
  LocalShellExecutorBinding,
} from "../types.js";
import { defineAction } from "../index.js";

export interface ShellExecutionResult {
  status: "success" | "failed";
  command: string;
  args: string[];
  cwd?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class ShellActionError extends Error {
  result: ShellExecutionResult;

  constructor(result: ShellExecutionResult) {
    super(`local shell action failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`}`);
    this.name = "ShellActionError";
    this.result = result;
  }
}

export function localShellBinding(manifest: ActionManifest): LocalShellExecutorBinding {
  const binding = manifest.executorBindings.find((item) => item.kind === "local-shell");
  if (!binding || binding.kind !== "local-shell") {
    throw new Error(`Action ${manifest.id} does not have a local-shell executor binding`);
  }
  return binding;
}

export function createLocalShellAction<TInput = unknown, TOutput = unknown>(
  manifest: ActionManifest,
  binding: LocalShellExecutorBinding = localShellBinding(manifest),
): ActionDefinition<TInput, TOutput> {
  return defineAction<TInput, TOutput>({
    manifest,
    preview: async (context) => shellPreview(context, binding),
    execute: async (context) => {
      const result = await runShell(context, binding);
      if (result.status !== "success") throw new ShellActionError(result);
      return parseShellOutput<TOutput>(result, binding);
    },
  });
}

function shellPreview<TInput>(context: ActionExecutionContext<TInput>, binding: LocalShellExecutorBinding): ActionPreview {
  const inputMode = binding.inputMode ?? "stdin-json";
  return {
    summary: `Would run ${binding.command} ${(binding.args ?? []).join(" ")}`.trim(),
    steps: [
      {
        id: "shell-command",
        kind: "execute",
        title: "Run local shell command",
        status: "planned",
        detail: binding.command,
        metadata: {
          args: (binding.args ?? []) as string[],
          cwd: binding.cwd ?? "",
          inputMode,
          outputMode: binding.outputMode ?? "json",
          runId: context.run.id,
        },
      },
    ],
    warnings: context.manifest.riskLevel === "high" || context.manifest.riskLevel === "critical"
      ? ["High-risk shell actions should be approved by policy before execution."]
      : [],
  };
}

async function runShell<TInput>(
  context: ActionExecutionContext<TInput>,
  binding: LocalShellExecutorBinding,
): Promise<ShellExecutionResult> {
  const inputMode = binding.inputMode ?? "stdin-json";
  const args = binding.args ?? [];
  const inputJson = JSON.stringify(context.input);
  const env: NodeJS.ProcessEnv = {
    ...(binding.inheritEnv ? process.env : pickProcessEnv(["PATH", "HOME", "TMPDIR", "TEMP", "TMP"])),
    ...binding.env,
    OPEN_ACTIONS_RUN_ID: context.run.id,
    OPEN_ACTIONS_ACTION_ID: context.manifest.id,
    OPEN_ACTIONS_ACTION_VERSION: context.manifest.version,
    OPEN_ACTIONS_DRY_RUN: String(context.dryRun),
  };
  if (inputMode === "env-json" || inputMode === "stdin-and-env-json") {
    env.OPEN_ACTIONS_INPUT = inputJson;
  }

  return new Promise((resolve) => {
    const child = spawn(binding.command, args, {
      cwd: binding.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = binding.timeoutMs
      ? setTimeout(() => {
          if (!settled) child.kill("SIGTERM");
        }, binding.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code, signal) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        status: code === 0 && signal === null ? "success" : "failed",
        command: binding.command,
        args,
        cwd: binding.cwd,
        code,
        signal,
        stdout,
        stderr,
      });
    });
    child.on("error", (error) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        status: "failed",
        command: binding.command,
        args,
        cwd: binding.cwd,
        code: null,
        signal: null,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    });

    if (inputMode === "stdin-json" || inputMode === "stdin-and-env-json") {
      child.stdin.end(`${inputJson}\n`);
    } else {
      child.stdin.end();
    }
  });
}

function pickProcessEnv(keys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function parseShellOutput<TOutput>(result: ShellExecutionResult, binding: LocalShellExecutorBinding): TOutput {
  const outputMode = binding.outputMode ?? "json";
  if (outputMode === "shell-result") return result as TOutput;
  if (outputMode === "text") return result.stdout as TOutput;
  const text = result.stdout.trim();
  if (!text) return {} as TOutput;
  return JSON.parse(text) as TOutput;
}
