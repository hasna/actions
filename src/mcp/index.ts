#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import type { ActionManifest, ActionSchema } from "../types.js";
import { parseActionManifest } from "../manifest.js";
export { ACTIONS_MCP_CAPABILITIES } from "./capabilities.js";
import { ACTIONS_MCP_CAPABILITIES } from "./capabilities.js";

export interface ActionsMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: ActionSchema;
  annotations: {
    actionId: string;
    actionVersion: string;
    dryRunSupported: boolean;
    requiresApproval: boolean;
    idempotencyRequired: boolean;
    risk?: string;
  };
}

export interface ActionsMcpCatalog {
  server: "open-actions";
  schemaVersion: "1.0";
  tools: ActionsMcpTool[];
}

export function actionManifestToMcpTool(input: unknown): ActionsMcpTool {
  const manifest = parseActionManifest(input);
  return {
    name: mcpToolName(manifest),
    title: manifest.title,
    description: manifest.description,
    inputSchema: manifest.inputSchema ?? { type: "object", additionalProperties: true },
    annotations: {
      actionId: manifest.id,
      actionVersion: manifest.version,
      dryRunSupported: manifest.dryRun?.supported ?? false,
      requiresApproval: manifest.approval?.requiresApproval ?? false,
      idempotencyRequired: manifest.idempotency?.required ?? false,
      risk: manifest.policy?.risk,
    },
  };
}

export function createActionsMcpCatalog(manifests: unknown[]): ActionsMcpCatalog {
  return {
    server: "open-actions",
    schemaVersion: "1.0",
    tools: manifests.map(actionManifestToMcpTool),
  };
}

export async function runActionsMcpCli(argv = Bun.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "capabilities") {
    console.log(JSON.stringify(ACTIONS_MCP_CAPABILITIES, null, 2));
    return 0;
  }
  if (command === "tool") {
    const file = argv[1];
    if (!file) {
      console.error("actions-mcp: tool requires a manifest JSON file");
      return 1;
    }
    const manifest = JSON.parse(file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8"));
    console.log(JSON.stringify(actionManifestToMcpTool(manifest), null, 2));
    return 0;
  }
  console.error(`actions-mcp: unknown command: ${command}`);
  return 1;
}

function mcpToolName(manifest: ActionManifest): string {
  const bindingTool = manifest.bindings.find((binding) => binding.kind === "mcp" && binding.toolName)?.toolName;
  return bindingTool ?? manifest.id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function printHelp(): void {
  console.log(`actions-mcp

Usage:
  actions-mcp capabilities
  actions-mcp tool <manifest.json>`);
}

if (import.meta.main) {
  process.exit(await runActionsMcpCli());
}
