import { ActionsClient, createTypeScriptAction } from "../src/index.js";

export const dispatchFollowup = createTypeScriptAction({
  manifest: {
    id: "examples.dispatch.followup",
    name: "Dispatch agent follow-up",
    version: "1.0.0",
    description: "Preview a safe follow-up dispatch to an agent session.",
    inputSchema: {
      type: "object",
      required: ["target", "prompt"],
      properties: {
        target: { type: "string" },
        prompt: { type: "string" }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        dispatched: { type: "boolean" },
        dryRun: { type: "boolean" }
      }
    },
    actor: { types: ["human", "agent"], required: true },
    resource: { type: "agent-session", identifiers: ["target"] },
    scope: { level: "machine", permissions: ["dispatch:send"] },
    riskLevel: "medium",
    requiredApprovals: [{ kind: "manual", count: 1, reason: "Agent prompt delivery" }],
    idempotency: { supported: true, required: true, keyHint: "target + prompt hash" },
    dryRun: { supported: true, default: true },
    confirmation: { title: "Dispatch follow-up", summaryTemplate: "Send follow-up to {{target}}", fields: ["target", "prompt"] },
    guardrail: { hook: "dispatch-target-policy", failClosed: true },
    audit: { eventTypes: ["action.planned", "action.previewed", "action.executed"], includeInput: true },
    evidence: { required: false, fields: ["captureBefore", "dispatchId"] },
    rollback: { strategy: "compensating-action", notes: "Dispatch cannot be undone; send a corrective follow-up if needed." },
    executorBindings: [{ kind: "typescript", ref: "examples/dispatch-workflow.ts#dispatchFollowup" }]
  },
  preview: async ({ input }) => ({
    summary: `Would dispatch prompt to ${(input as { target: string }).target}`,
    changes: [{ kind: "agent-message", target: (input as { target: string }).target, after: { prompt: (input as { prompt: string }).prompt } }]
  }),
  execute: async ({ dryRun }) => ({
    dispatched: !dryRun,
    dryRun
  })
});

export async function demoDispatchWorkflow(): Promise<void> {
  const client = new ActionsClient();
  await client.register(dispatchFollowup);
}

