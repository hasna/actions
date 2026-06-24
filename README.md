# open-actions

Typed, auditable action contracts for agentic software.

`open-actions` is an OSS primitive for making multi-step operator work safer:
every action has a portable manifest, typed inputs and outputs, dry-run preview,
approval policy, guardrail hooks, idempotency, execution bindings, and audit
evidence.

It is not a wrapper around a shell command or SDK call. A wrapper says "run this."
An open action says what will run, who is allowed to run it, what it touches, how
to preview it, how to approve it, how to dedupe retries, where audit events go,
and what rollback or compensating action is available.

## Install

```bash
bun install @hasna/actions
```

## Manifest Shape

```ts
import { createTypeScriptAction } from "@hasna/actions";

const action = createTypeScriptAction({
  manifest: {
    id: "projects.metadata.update",
    name: "Update project metadata",
    version: "1.0.0",
    description: "Patch project metadata after preview and approval.",
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
      required: ["updated"],
      properties: { updated: { type: "boolean" } }
    },
    actor: { types: ["human", "agent"], required: true },
    resource: { type: "project", identifiers: ["project"] },
    scope: { level: "workspace", permissions: ["project:metadata:update"] },
    riskLevel: "medium",
    requiredApprovals: [{ kind: "manual", count: 1, reason: "metadata mutation" }],
    idempotency: { supported: true, required: true, keyHint: "project + patch hash" },
    dryRun: { supported: true, default: true },
    confirmation: {
      title: "Update project metadata",
      summaryTemplate: "Update metadata for {{project}}",
      fields: ["project", "metadata"]
    },
    guardrail: { hook: "project-metadata-policy", failClosed: true },
    audit: { eventTypes: ["action.planned", "action.executed"], includeInput: true },
    evidence: { required: false, fields: ["diff", "command"] },
    rollback: { strategy: "compensating-action", actionId: "projects.metadata.restore" },
    executorBindings: [{ kind: "typescript", ref: "examples/project-workflow.ts#updateMetadata" }]
  },
  preview: async ({ input }) => ({
    summary: `Would update ${input.project}`,
    changes: [{ kind: "metadata", target: input.project, after: input.metadata }]
  }),
  execute: async ({ input }) => ({ updated: true, project: input.project })
});
```

## SDK

```ts
import { ActionsClient, JsonActionsStore } from "@hasna/actions";

const client = new ActionsClient({
  store: new JsonActionsStore(),
  guardrailHooks: [
    async ({ manifest }) => (
      manifest.riskLevel === "critical"
        ? { decision: "deny", reason: "critical actions require an external policy" }
        : { decision: "allow" }
    )
  ],
  auditSinks: [
    async (event) => {
      // Bridge to @hasna/events, a webhook, or a local ledger.
      console.log(event.type, event.runId);
    }
  ]
});

client.register(action);

const preview = await client.run({
  actionId: "projects.metadata.update",
  input: { project: "open-actions", metadata: { stage: "active" } },
  actor: { id: "hasna", type: "human" },
  idempotencyKey: "open-actions-stage-active",
  dryRun: true
});

const run = await client.run({
  actionId: "projects.metadata.update",
  input: { project: "open-actions", metadata: { stage: "active" } },
  actor: { id: "hasna", type: "human" },
  idempotencyKey: "open-actions-stage-active-v2"
});

await client.approve(run.id, {
  actor: { id: "hasna", type: "human" },
  decision: "approved",
  reason: "Preview matches request"
});

await client.execute(run.id);
```

## Local Shell Executor

Shell actions are still typed contracts. The command is an executor binding, not
the whole action.

```json
{
  "id": "dispatch.agent.followup",
  "name": "Dispatch follow-up to idle agents",
  "version": "1.0.0",
  "description": "Preview and dispatch a bounded prompt to agent sessions.",
  "inputSchema": { "type": "object" },
  "outputSchema": { "type": "object" },
  "actor": { "types": ["human", "agent"], "required": true },
  "resource": { "type": "agent-session" },
  "scope": { "level": "machine", "permissions": ["dispatch:send"] },
  "riskLevel": "medium",
  "requiredApprovals": [{ "kind": "manual", "count": 1 }],
  "idempotency": { "supported": true, "required": true },
  "dryRun": { "supported": true, "default": true },
  "confirmation": { "title": "Dispatch follow-up", "fields": ["target", "prompt"] },
  "guardrail": { "hook": "dispatch-target-policy", "failClosed": true },
  "audit": { "eventTypes": ["action.planned", "action.previewed", "action.executed"] },
  "evidence": { "required": false, "fields": ["dispatchId", "captureBefore"] },
  "rollback": { "strategy": "none", "notes": "Dispatch cannot be undone; use a compensating follow-up prompt." },
  "executorBindings": [
    {
      "kind": "local-shell",
      "command": "dispatch",
      "args": ["send", "--json", "--dry-run"],
      "inputMode": "env-json",
      "outputMode": "json"
    }
  ]
}
```

Run a local shell action manifest:

```bash
actions run examples/local-shell.manifest.json \
  --input '{"name":"open-actions"}' \
  --idempotency-key demo-1 \
  --dry-run \
  --json
```

## CLI

CLI output is compact by default for humans and agents. List commands cap human
rows, truncate long summaries, include totals, and print the next command to run
when more rows are available. Use `show`/`inspect` or `--verbose` for bounded
detail. Use `--json` only when a full machine-readable record is needed; JSON
output preserves the stored manifest/run shape.

```text
actions status
actions status --verbose
actions manifests validate <file>
actions manifests list --limit 20
actions manifests show <id> --verbose
actions manifests inspect <id>
actions run <manifest-file> --input <json> --dry-run
actions run <manifest-file> --input-file input.json --approve --verbose
actions runs list --status previewed --limit 20 --cursor 20
actions runs show <run-id>
actions runs inspect <run-id>
actions approve <run-id> --reason "reviewed"
actions execute <run-id> <manifest-file> --verbose
actions runs list --json
actions runs show <run-id> --json
```

## MCP

`actions-mcp` exposes the same local-first action store to agents:

- `actions_register_manifest`
- `actions_list_manifests`
- `actions_show_manifest`
- `actions_run`
- `actions_approve`
- `actions_deny`
- `actions_execute`
- `actions_show_run`
- `actions_list_runs`

MCP tools also use compact output by default. `actions_list_manifests` and
`actions_list_runs` return paginated summary envelopes with `page.nextCursor`.
Pass `limit` and `cursor` to page through records. Pass `detail: "verbose"` for
bounded previews or `detail: "full"` for paginated full records. Prefer
`actions_show_manifest` and `actions_show_run` when an agent needs one complete
record.

The first version executes stored local-shell manifests over MCP. TypeScript SDK
actions are registered in-process by the host application.

## Integration Model

- `open-guardrails`: provide guardrail hooks that inspect manifest, actor,
  input, scope, and preview before execution.
- `open-orgs`: resolve actor roles and approval authority before calling
  `approve`.
- `open-dispatch`: expose dispatch operations as medium/high-risk actions with
  dry-run, target policy, and capture evidence.
- `open-projects`: represent create/publish/update workflows as composable
  action plans with rollback or compensating-action metadata.
- `open-events`: receive audit events emitted by `ActionsClient` audit sinks.

## Storage

Default local data directory:

```text
~/.hasna/actions
```

Override with `HASNA_ACTIONS_DIR` or `HASNA_ACTIONS_HOME`.

The storage interface is intentionally small so the same contract can later be
backed by SQLite, Postgres, a gateway service, or a signed audit ledger.

Local shell executors pass `PATH`, `HOME`, and temp directory variables by
default, plus explicit manifest `env` values. They do not inherit the whole
process environment unless `inheritEnv` is set, so unrelated local secrets are
not casually forwarded to action commands.
