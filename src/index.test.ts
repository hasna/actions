import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ActionsClient, createTypeScriptAction } from "./index.js";
import { JsonActionsStore } from "./storage.js";
import type { ActionManifest } from "./types.js";

function manifest(overrides: Partial<ActionManifest> = {}): ActionManifest {
  return {
    id: "projects.metadata.update",
    name: "Update project metadata",
    version: "1.0.0",
    description: "Patch project metadata safely.",
    inputSchema: { type: "object", required: ["project", "metadata"] },
    outputSchema: { type: "object", required: ["updated"] },
    actor: { types: ["human", "agent"], required: true },
    resource: { type: "project", identifiers: ["project"] },
    scope: { level: "workspace", permissions: ["project:metadata:update"] },
    riskLevel: "medium",
    requiredApprovals: [{ kind: "manual", count: 1, reason: "metadata mutation" }],
    idempotency: { supported: true, required: true },
    dryRun: { supported: true, default: true },
    confirmation: { title: "Update project metadata", summaryTemplate: "Update {{project}}", fields: ["project"] },
    guardrail: { hook: "project-policy", failClosed: true },
    audit: { eventTypes: ["action.planned", "action.previewed", "action.executed"], includeInput: true },
    evidence: { required: false, fields: ["diff"] },
    rollback: { strategy: "compensating-action", actionId: "projects.metadata.restore" },
    executorBindings: [{ kind: "typescript", ref: "test#update" }],
    ...overrides,
  };
}

describe("ActionsClient", () => {
  test("plans, previews, approvals, execution, audit, and idempotency", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-client-"));
    try {
      const input = z.object({ project: z.string(), metadata: z.record(z.unknown()) });
      const output = z.object({ updated: z.boolean(), project: z.string() });
      const audit: string[] = [];
      const client = new ActionsClient({
        store: new JsonActionsStore(dir),
        guardrailHooks: [async () => ({ decision: "allow" })],
        auditSinks: [(event) => {
          audit.push(event.type);
        }],
      });
      await client.register(createTypeScriptAction({
        manifest: manifest(),
        input,
        output,
        preview: async ({ input }) => ({
          summary: `Would update ${input.project}`,
          changes: [{ kind: "metadata", target: input.project, after: input.metadata }],
        }),
        execute: async ({ input }) => ({ updated: true, project: input.project }),
      }));

      const dryRun = await client.run({
        actionId: "projects.metadata.update",
        input: { project: "open-actions", metadata: { stage: "active" } },
        actor: { id: "hasna", type: "human" },
        idempotencyKey: "preview-1",
        dryRun: true,
      });
      expect(dryRun.status).toBe("previewed");
      expect(dryRun.preview?.changes?.[0]?.target).toBe("open-actions");

      const planned = await client.run({
        actionId: "projects.metadata.update",
        input: { project: "open-actions", metadata: { stage: "active" } },
        actor: { id: "hasna", type: "human" },
        idempotencyKey: "execute-1",
        dryRun: false,
      });
      expect(planned.status).toBe("awaiting_approval");

      const approved = await client.approve(planned.id, {
        actor: { id: "hasna", type: "human" },
        decision: "approved",
        reason: "Preview is correct",
      });
      expect(approved.status).toBe("approved");

      const executed = await client.execute(planned.id);
      expect(executed.status).toBe("succeeded");
      expect(executed.output).toEqual({ updated: true, project: "open-actions" });
      expect(audit).toContain("action.executed");

      const deduped = await client.plan({
        actionId: "projects.metadata.update",
        input: { project: "open-actions", metadata: { stage: "active" } },
        idempotencyKey: "execute-1",
      });
      expect(deduped.id).toBe(executed.id);
      expect(deduped.dedupedFromRunId).toBe(executed.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("guardrail denial stops execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-guardrail-"));
    try {
      const client = new ActionsClient({
        store: new JsonActionsStore(dir),
        guardrailHooks: [async () => ({ decision: "deny", reason: "blocked by policy" })],
      });
      await client.register(createTypeScriptAction({
        manifest: manifest({ id: "dangerous.action", requiredApprovals: [], idempotency: { supported: true } }),
        execute: async () => ({ ok: true }),
      }));

      const run = await client.run({
        actionId: "dangerous.action",
        input: {},
        dryRun: false,
      });
      expect(run.status).toBe("denied");
      expect(run.error).toContain("blocked by policy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("approval requirements honor actor roles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-roles-"));
    try {
      const client = new ActionsClient({ store: new JsonActionsStore(dir) });
      await client.register(createTypeScriptAction({
        manifest: manifest({
          id: "role.approved.action",
          requiredApprovals: [{ kind: "manual", count: 1, roles: ["maintainer"] }],
          idempotency: { supported: true },
          guardrail: undefined,
        }),
        execute: async () => ({ updated: true, project: "open-actions" }),
      }));
      const run = await client.run({
        actionId: "role.approved.action",
        input: { project: "open-actions", metadata: {} },
        dryRun: false,
      });
      expect(run.status).toBe("awaiting_approval");

      await client.approve(run.id, {
        actor: { id: "reviewer", type: "human", roles: ["reader"] },
        decision: "approved",
      });
      const stillWaiting = await client.execute(run.id);
      expect(stillWaiting.status).toBe("awaiting_approval");

      await client.approve(run.id, {
        actor: { id: "maintainer", type: "human", roles: ["maintainer"] },
        decision: "approved",
      });
      const executed = await client.execute(run.id);
      expect(executed.status).toBe("succeeded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
