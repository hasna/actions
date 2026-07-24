import { z } from "zod";
import { ActionsClient, createTypeScriptAction } from "../src/index.js";

const projectMetadataInput = z.object({
  project: z.string(),
  metadata: z.record(z.unknown()),
});

export const updateProjectMetadata = createTypeScriptAction({
  manifest: {
    id: "examples.projects.metadata.update",
    name: "Update project metadata",
    version: "1.0.0",
    description: "Preview and update generic project metadata with approval and idempotency.",
    inputSchema: {
      type: "object",
      required: ["project", "metadata"],
      properties: {
        project: { type: "string" },
        metadata: { type: "object" }
      }
    },
    outputSchema: {
      type: "object",
      required: ["updated", "project"],
      properties: {
        updated: { type: "boolean" },
        project: { type: "string" }
      }
    },
    actor: { types: ["human", "agent"], required: true },
    resource: { type: "project", identifiers: ["project"] },
    scope: { level: "workspace", permissions: ["project:metadata:update"] },
    riskLevel: "medium",
    requiredApprovals: [{ kind: "manual", count: 1, reason: "Project metadata mutation" }],
    idempotency: { supported: true, required: true, keyHint: "project + metadata patch hash" },
    dryRun: { supported: true, default: true },
    confirmation: {
      title: "Update project metadata",
      summaryTemplate: "Update metadata for {{project}}",
      fields: ["project", "metadata"]
    },
    guardrail: { hook: "project-metadata-policy", failClosed: true },
    audit: { eventTypes: ["action.planned", "action.previewed", "action.executed"], includeInput: true },
    evidence: { required: false, fields: ["diff"] },
    rollback: { strategy: "compensating-action", actionId: "examples.projects.metadata.restore" },
    executorBindings: [{ kind: "typescript", ref: "examples/project-workflow.ts#updateProjectMetadata" }]
  },
  input: projectMetadataInput,
  preview: async ({ input }) => ({
    summary: `Would update ${input.project}`,
    changes: [{ kind: "metadata", target: input.project, after: input.metadata }]
  }),
  execute: async ({ input }) => ({
    updated: true,
    project: input.project
  })
});

export async function demoProjectMetadataWorkflow(): Promise<void> {
  const client = new ActionsClient({
    guardrailHooks: [async () => ({ decision: "allow" })]
  });
  await client.register(updateProjectMetadata);
  const actor = { id: "operator", type: "human" as const };
  const planned = await client.run({
    actionId: "examples.projects.metadata.update",
    input: { project: "open-actions", metadata: { stage: "active" } },
    actor,
    idempotencyKey: "open-actions-stage-active",
    dryRun: false
  });
  await client.approve(planned.id, { actor, decision: "approved", reason: "Preview matches request" });
  await client.execute(planned.id);
}
