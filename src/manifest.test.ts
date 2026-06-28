import { describe, expect, test } from "bun:test";
import {
  assertActionRunStatus,
  createActionAuditEvent,
  createActionInvocation,
  createDeadLetter,
  createDryRunPreview,
  deriveIdempotencyKey,
  exampleActionManifest,
  isTerminalActionStatus,
  validateActionManifest,
} from "./index.js";

describe("action manifest contracts", () => {
  test("validates the canonical example manifest", () => {
    const result = validateActionManifest(exampleActionManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.id).toBe("tickets.create");
  });

  test("rejects manifests without bindings and raw secret values", () => {
    const result = validateActionManifest({
      schemaVersion: "1.0",
      id: "bad.action",
      name: "bad.action",
      version: "1.0.0",
      bindings: [],
      secrets: [{ name: "token", ref: "secret://token", value: "raw" }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("bindings.required");
    expect(result.errors.map((error) => error.code)).toContain("secret.raw_value");
  });

  test("rejects unsupported schema versions and incomplete executable bindings", () => {
    const result = validateActionManifest({
      schemaVersion: "2.0",
      id: "bad.bindings",
      name: "bad.bindings",
      version: "1.0.0",
      bindings: [
        { kind: "sdk", package: "@hasna/example" },
        { kind: "workflow" },
        { kind: "agent" },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("schema_version.unsupported");
    expect(result.errors.map((error) => error.code)).toContain("binding.sdk.export");
    expect(result.errors.map((error) => error.code)).toContain("binding.workflow.ref");
    expect(result.errors.map((error) => error.code)).toContain("binding.agent.target");
  });

  test("derives idempotency keys from templates or stable input", () => {
    const manifest = exampleActionManifest();
    expect(deriveIdempotencyKey(manifest, { title: "Refund", priority: "high" })).toBe("tickets.create:Refund");

    const fallback = {
      ...manifest,
      idempotency: { required: true, scope: "tenant" as const },
    };
    expect(deriveIdempotencyKey(fallback, { b: 2, a: 1 })).toBe("tickets.create:1.0.0:{\"a\":1,\"b\":2}");
  });

  test("creates invocations, previews, dead letters, and audit events", () => {
    const manifest = exampleActionManifest();
    const invocation = createActionInvocation(manifest, { title: "Need help" }, {
      id: "inv_1",
      requestedAt: "2026-06-28T00:00:00.000Z",
      dryRun: true,
    });

    expect(invocation).toMatchObject({
      id: "inv_1",
      actionId: "tickets.create",
      manifestVersion: "1.0.0",
      dryRun: true,
      idempotencyKey: "tickets.create:Need help",
    });

    const waitingRun = {
      id: "run_1",
      invocation,
      status: "waiting_approval" as const,
      attempt: 0,
      maxAttempts: 3,
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
      approvalGate: {
        requirement: {
          mode: "manual" as const,
          requiresApproval: true,
        },
        blockedUntilApproved: true,
        decision: {
          id: "approval_1",
          status: "pending" as const,
          requestedAt: "2026-06-28T00:00:00.000Z",
        },
      },
    };
    expect(waitingRun.approvalGate.decision.status).toBe("pending");

    const preview = createDryRunPreview(invocation, { safeToRun: true, summary: "Would create one ticket" });
    expect(preview).toMatchObject({ invocationId: "inv_1", actionId: "tickets.create", safeToRun: true });

    const dead = createDeadLetter({
      reason: "max attempts exceeded",
      attempts: 3,
      failedAt: "2026-06-28T00:00:00.000Z",
      lastError: { code: "HTTP_500", message: "upstream failed", retryable: true },
    });
    expect(dead).toMatchObject({ reason: "max attempts exceeded", replayable: true, attempts: 3 });

    const audit = createActionAuditEvent({
      id: "audit_1",
      source: "hasna.actions",
      type: "action.dead",
      actionId: manifest.id,
      invocationId: invocation.id,
      time: "2026-06-28T00:00:00.000Z",
      data: { reason: dead.reason },
    });
    expect(audit).toMatchObject({ id: "audit_1", type: "action.dead", data: { reason: "max attempts exceeded" } });
  });

  test("classifies terminal statuses and rejects unknown statuses", () => {
    expect(isTerminalActionStatus("dead")).toBe(true);
    expect(isTerminalActionStatus("waiting_approval")).toBe(false);
    expect(isTerminalActionStatus("running")).toBe(false);
    expect(assertActionRunStatus("queued")).toBe("queued");
    expect(() => assertActionRunStatus("unknown")).toThrow("Unknown action run status");
  });
});
