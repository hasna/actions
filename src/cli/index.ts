#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_RUN_STATUSES, TERMINAL_ACTION_RUN_STATUSES } from "../types.js";
import { exampleActionManifest, validateActionManifest } from "../manifest.js";
import { ACTIONS_MCP_CAPABILITIES } from "../mcp/capabilities.js";

interface ParsedArgs {
  json: boolean;
  rest: string[];
}

export interface RunActionsCliOptions {
  programName?: string;
}

export async function runActionsCli(argv = Bun.argv.slice(2), options: RunActionsCliOptions = {}): Promise<number> {
  const parsed = parseGlobalArgs(argv);
  const command = parsed.rest[0];

  try {
    if (!command || command === "--help" || command === "-h" || command === "help") {
      printHelp(options);
      return 0;
    }

    if (command === "--version" || command === "-v" || command === "version") {
      output(parsed, { version: packageVersion() }, () => console.log(packageVersion()));
      return 0;
    }

    if (command === "status") {
      output(parsed, buildStatus(), () => {
        console.log(`actions ${packageVersion()}`);
        console.log(`statuses: ${ACTION_RUN_STATUSES.join(", ")}`);
      });
      return 0;
    }

    if (command === "manifest") {
      return runManifestCommand(parsed, options);
    }

    if (command === "validate") {
      return runValidateCommand(parsed);
    }

    if (command === "mcp") {
      return runMcpCommand(parsed, options);
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`actions: ${message}`);
    }
    return 1;
  }
}

function runManifestCommand(parsed: ParsedArgs, options: RunActionsCliOptions): number {
  const subcommand = parsed.rest[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printManifestHelp(options);
    return 0;
  }
  if (subcommand === "example") {
    output(parsed, exampleActionManifest(), () => console.log(JSON.stringify(exampleActionManifest(), null, 2)));
    return 0;
  }
  throw new Error(`Unknown manifest command: ${subcommand}`);
}

function runValidateCommand(parsed: ParsedArgs): number {
  const file = parsed.rest[1];
  if (!file || file === "--help" || file === "-h") {
    console.log(`${programName()} validate <manifest.json>

Validate an action manifest JSON file. Use "-" to read from stdin.`);
    return file ? 0 : 1;
  }
  const text = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
  const result = validateActionManifest(JSON.parse(text));
  output(parsed, result, () => {
    if (result.valid) {
      console.log("valid");
    } else {
      for (const error of result.errors) {
        console.log(`${error.path}: ${error.message}`);
      }
    }
  });
  return result.valid ? 0 : 1;
}

function runMcpCommand(parsed: ParsedArgs, options: RunActionsCliOptions): number {
  const subcommand = parsed.rest[1];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printMcpHelp(options);
    return 0;
  }
  if (subcommand === "capabilities") {
    output(parsed, ACTIONS_MCP_CAPABILITIES, () => console.log(JSON.stringify(ACTIONS_MCP_CAPABILITIES, null, 2)));
    return 0;
  }
  throw new Error(`Unknown mcp command: ${subcommand}`);
}

function parseGlobalArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--json" || arg === "-j") {
      json = true;
      continue;
    }
    rest.push(...argv.slice(index));
    break;
  }
  return { json, rest };
}

function output(parsed: ParsedArgs, value: unknown, human: () => void): void {
  if (parsed.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  human();
}

function buildStatus(): Record<string, unknown> {
  return {
    service: "actions",
    package: "@hasna/actions",
    version: packageVersion(),
    schemaVersion: "1.0",
    statuses: ACTION_RUN_STATUSES,
    terminalStatuses: TERMINAL_ACTION_RUN_STATUSES,
    capabilities: {
      manifestValidation: true,
      providerIdentity: true,
      sideEffectClassification: true,
      requiredGrants: true,
      dryRunContracts: true,
      idempotencyContracts: true,
      approvalContracts: true,
      auditEventShapes: true,
      executionBindingMetadata: true,
      mcpCatalog: true,
    },
  };
}

function printHelp(options: RunActionsCliOptions = {}): void {
  const name = programName(options);
  console.log(`${name} ${packageVersion()}

Usage:
  ${name} [--json] status
  ${name} [--json] manifest example
  ${name} [--json] validate <manifest.json>
  ${name} [--json] mcp capabilities`);
}

function printManifestHelp(options: RunActionsCliOptions = {}): void {
  const name = programName(options);
  console.log(`${name} manifest

Usage:
  ${name} [--json] manifest example`);
}

function printMcpHelp(options: RunActionsCliOptions = {}): void {
  const name = programName(options);
  console.log(`${name} mcp

Usage:
  ${name} [--json] mcp capabilities`);
}

function programName(options: RunActionsCliOptions = {}): string {
  return options.programName ?? "actions";
}

function packageVersion(): string {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(packagePath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (import.meta.main) {
  process.exit(await runActionsCli());
}
