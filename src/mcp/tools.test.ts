import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ActionsClient } from "../index.js";
import { JsonActionsStore } from "../storage.js";
import type { ActionManifest, ActionRun } from "../types.js";
import { TOOLS, type ToolDef } from "./tools.js";

const longText = "y".repeat(220);

function manifest(): ActionManifest {
  return {
    id: "examples.local-shell.uppercase",
    name: "Uppercase local input",
    version: "1.0.0",
    description: `Demonstrates a local-shell action with a long description ${longText}`,
    inputSchema: { type: "object", required: ["name"] },
    outputSchema: { type: "object", required: ["message"] },
    actor: { types: ["human", "agent"], required: true },
    resource: { type: "local-process", identifiers: ["name"] },
    scope: { level: "local", permissions: ["shell:execute"] },
    riskLevel: "low",
    requiredApprovals: [],
    idempotency: { supported: true, required: false },
    dryRun: { supported: true, default: true },
    confirmation: { title: "Uppercase local input", summaryTemplate: "Uppercase {{name}}" },
    audit: { eventTypes: ["action.planned", "action.previewed"], includeInput: true },
    evidence: { required: false },
    rollback: { strategy: "none" },
    executorBindings: [{ kind: "local-shell", command: "bun" }],
  };
}

function runRecord(index: number): ActionRun {
  const id = `run-${String(index).padStart(2, "0")}`;
  const createdAt = `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
  return {
    id,
    actionId: "examples.local-shell.uppercase",
    actionVersion: "1.0.0",
    status: "previewed",
    actor: { id: "mcp", type: "agent" },
    input: { name: `open-actions-${index}`, payload: longText },
    output: { message: longText },
    plan: [{ id: "execute", kind: "execute", title: `Execute with ${longText}`, status: "planned" }],
    riskLevel: "low",
    requiredApprovals: [],
    approvals: [],
    guardrailResults: [{ decision: "allow" }],
    evidence: [],
    dryRun: true,
    confirmationSummary: `Uppercase open-actions-${index} ${longText}`,
    rollback: { strategy: "none" },
    events: [],
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    preview: { summary: `Would run ${longText}`, warnings: [] },
  };
}

function tool(name: string): ToolDef {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

async function seedClient(dir: string, count: number): Promise<ActionsClient> {
  const store = new JsonActionsStore(dir);
  await store.saveManifest(manifest());
  for (let index = 0; index < count; index += 1) {
    await store.createRun(runRecord(index));
  }
  return new ActionsClient({ store });
}

describe("MCP tool compact output", () => {
  test("lists compact paginated runs by default and preserves explicit full records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-mcp-"));
    try {
      const client = await seedClient(dir, 12);
      const deps = { client };

      const compact = await tool("actions_list_runs").handler(deps, {});
      expect(compact).toMatchObject({
        page: { count: 10, total: 12, limit: 10, cursor: 0, nextCursor: "10" },
      });
      expect(JSON.stringify(compact)).not.toContain(longText);
      expect((compact as { items: Array<Record<string, unknown>> }).items[0].hasInput).toBe(true);
      expect((compact as { items: Array<Record<string, unknown>> }).items[0].input).toBeUndefined();

      const full = await tool("actions_list_runs").handler(deps, { detail: "full" });
      expect(full).toMatchObject({
        page: { count: 10, total: 12, limit: 10, cursor: 0, nextCursor: "10" },
      });
      expect((full as { items: ActionRun[] }).items).toHaveLength(10);
      expect(JSON.stringify(full)).toContain(longText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shows compact run by default and bounded previews with verbose detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-mcp-"));
    try {
      const client = await seedClient(dir, 1);
      const deps = { client };

      const compact = await tool("actions_show_run").handler(deps, { runId: "run-00" });
      expect(JSON.stringify(compact)).not.toContain(longText);
      expect((compact as Record<string, unknown>).hasInput).toBe(true);
      expect((compact as Record<string, unknown>).input).toBeUndefined();

      const verbose = await tool("actions_show_run").handler(deps, { runId: "run-00", detail: "verbose" });
      expect((verbose as Record<string, unknown>).input).toContain("...");
      expect(JSON.stringify(verbose)).not.toContain(longText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shows one manifest without requiring full manifest lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-mcp-"));
    try {
      const client = await seedClient(dir, 0);
      const deps = { client };

      const compact = await tool("actions_show_manifest").handler(deps, { actionId: "examples.local-shell.uppercase" });
      expect((compact as Record<string, unknown>).id).toBe("examples.local-shell.uppercase");
      expect(JSON.stringify(compact)).not.toContain(longText);

      const full = await tool("actions_show_manifest").handler(deps, { actionId: "examples.local-shell.uppercase", detail: "full" });
      expect(JSON.stringify(full)).toContain(longText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
