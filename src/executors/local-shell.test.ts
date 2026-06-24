import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ActionsClient, createLocalShellAction } from "../index.js";
import { JsonActionsStore } from "../storage.js";
import type { ActionManifest } from "../types.js";

function shellManifest(): ActionManifest {
  return {
    id: "shell.uppercase",
    name: "Uppercase with shell",
    version: "1.0.0",
    description: "Read JSON input and return uppercase output.",
    inputSchema: { type: "object", required: ["name"] },
    outputSchema: { type: "object", required: ["message"] },
    actor: { types: ["human", "agent"] },
    resource: { type: "local-process" },
    scope: { level: "local", permissions: ["shell:execute"] },
    riskLevel: "low",
    requiredApprovals: [],
    idempotency: { supported: true },
    dryRun: { supported: true, default: false },
    confirmation: { title: "Uppercase input", summaryTemplate: "Uppercase {{name}}" },
    audit: { eventTypes: ["action.planned", "action.executed"], includeOutput: true },
    evidence: { required: false, fields: ["stdout", "stderr"] },
    rollback: { strategy: "none" },
    executorBindings: [{
      kind: "local-shell",
      command: "bun",
      args: [
        "-e",
        "const input = JSON.parse(await new Response(Bun.stdin.stream()).text()); console.log(JSON.stringify({ message: input.name.toUpperCase() }));",
      ],
      inputMode: "stdin-json",
      outputMode: "json",
    }],
  };
}

describe("local shell executor", () => {
  test("previews without executing and executes JSON stdin/stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-shell-"));
    try {
      const client = new ActionsClient({ store: new JsonActionsStore(dir) });
      const manifest = shellManifest();
      await client.register(createLocalShellAction(manifest));

      const preview = await client.run({
        actionId: manifest.id,
        input: { name: "open-actions" },
        dryRun: true,
      });
      expect(preview.status).toBe("previewed");
      expect(preview.output).toBeUndefined();

      const executed = await client.run({
        actionId: manifest.id,
        input: { name: "open-actions" },
        dryRun: false,
      });
      expect(executed.status).toBe("succeeded");
      expect(executed.output).toEqual({ message: "OPEN-ACTIONS" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

