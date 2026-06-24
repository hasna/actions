import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { JsonActionsStore, getActionsStatus } from "./storage.js";
import type { ActionManifest, ActionRun } from "./types.js";

const manifest: ActionManifest = {
  id: "test.action",
  name: "Test Action",
  version: "1.0.0",
  description: "A test action.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  actor: { types: ["human"] },
  resource: { type: "test" },
  scope: { level: "local" },
  riskLevel: "low",
  requiredApprovals: [],
  idempotency: { supported: true },
  dryRun: { supported: true, default: true },
  confirmation: { title: "Test action" },
  audit: { eventTypes: ["action.planned"] },
  evidence: { required: false },
  rollback: { strategy: "none" },
  executorBindings: [{ kind: "typescript", ref: "test" }],
};

describe("JsonActionsStore", () => {
  test("persists manifests, runs, idempotency lookup, and status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-store-"));
    try {
      const store = new JsonActionsStore(dir);
      await store.saveManifest(manifest);
      expect(await store.getManifest("test.action")).toMatchObject({ id: "test.action" });

      const run: ActionRun = {
        id: "run_1",
        actionId: "test.action",
        actionVersion: "1.0.0",
        status: "planned",
        input: {},
        plan: [],
        riskLevel: "low",
        requiredApprovals: [],
        approvals: [],
        guardrailResults: [],
        evidence: [],
        idempotencyKey: "idem-1",
        dryRun: true,
        confirmationSummary: "Test action",
        rollback: { strategy: "none" },
        events: [],
        metadata: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await store.createRun(run);
      expect(await store.findRunByIdempotencyKey("test.action", "idem-1")).toMatchObject({ id: "run_1" });

      const status = await getActionsStatus(dir);
      expect(status.counts.manifests).toBe(1);
      expect(status.counts.runs).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

