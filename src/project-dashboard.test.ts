import { describe, expect, test } from "bun:test";
import {
  projectActionBoundaryBlockers,
  projectActionCapability,
  projectActionCapabilities,
  PROJECT_ACTION_CAPABILITY_SCHEMA,
} from "./project-dashboard.js";
import type { ActionManifest } from "./types.js";

function manifest(overrides: Partial<ActionManifest> = {}): ActionManifest {
  return {
    id: "projects.dashboard.refresh",
    name: "Refresh project dashboard",
    version: "1.0.0",
    description: "Refresh provider snapshots for one project.",
    inputSchema: { type: "object", required: ["projectId"] },
    outputSchema: { type: "object", required: ["snapshotId"] },
    actor: { types: ["human", "agent"], required: true },
    resource: { type: "project", identifiers: ["projectId"], description: "Project dashboard snapshot" },
    scope: { level: "project", permissions: ["projects:snapshot:refresh"], boundaries: ["projectId"] },
    riskLevel: "medium",
    requiredApprovals: [{ kind: "manual", count: 1, reason: "refresh can invoke provider CLIs" }],
    idempotency: { supported: true, required: true, keyHint: "projectId + provider set" },
    dryRun: { supported: true, default: true },
    confirmation: { title: "Refresh project dashboard", fields: ["projectId"] },
    guardrail: { hook: "projects-dashboard-policy", failClosed: true },
    audit: {
      eventTypes: ["action.planned", "action.previewed", "action.executed"],
      redactedFields: ["input.privateNotes"],
    },
    evidence: { required: true, fields: ["snapshotId", "providers"] },
    rollback: { strategy: "none" },
    executorBindings: [{ kind: "local-shell", command: "projects", args: ["snapshot"] }],
    metadata: { owner: "open-projects" },
    ...overrides,
  };
}

describe("project dashboard action capabilities", () => {
  test("projects a manifest into a view-safe capability without executor bindings", () => {
    const capability = projectActionCapability(manifest(), { projectId: "swiss-bank-account" });

    expect(capability.schema).toBe(PROJECT_ACTION_CAPABILITY_SCHEMA);
    expect(capability.id).toBe("projects.dashboard.refresh");
    expect(capability.presentation.defaultMode).toBe("dry-run");
    expect(capability.presentation.executionPolicy).toBe("server-issued-run");
    expect(capability.presentation.approvalRequired).toBe(true);
    expect(capability.audit.evidenceFields).toEqual(["snapshotId", "providers"]);
    expect(capability.metadata.projectId).toBe("swiss-bank-account");
    expect(JSON.stringify(capability)).not.toContain("local-shell");
    expect(JSON.stringify(capability)).not.toContain("\"command\"");
  });

  test("marks unsafe manifests unavailable until dry-run and approval boundaries exist", () => {
    const blockers = projectActionBoundaryBlockers(manifest({
      riskLevel: "high",
      requiredApprovals: [],
      dryRun: { supported: false, default: false },
      audit: { eventTypes: ["action.planned"] },
    }));

    expect(blockers).toContain("dry-run preview is required before dashboard execution");
    expect(blockers).toContain("dashboard actions must default to dry-run/read-only");
    expect(blockers).toContain("preview audit event is required");
    expect(blockers).toContain("medium/high/critical actions require explicit approval policy");

    const [capability] = projectActionCapabilities([manifest({
      riskLevel: "high",
      requiredApprovals: [],
      dryRun: { supported: false, default: false },
      audit: { eventTypes: ["action.planned"] },
    })]);
    expect(capability.presentation.executionPolicy).toBe("unavailable");
    expect(capability.safety.blockers.length).toBeGreaterThan(0);
  });
});
