# open-actions

Typed, auditable action contracts for agentic software.

`open-actions` defines the portable contract layer that real automation systems
can execute against without coupling themselves to one runner. It is not a
scheduler and it is not the OpenAutomations control plane. It gives callers a
shared language for action manifests, idempotency, dry-run previews, approvals,
policy hooks, audit events, runtime bindings, and dead-letter handling.

## Package

```sh
bun add @hasna/actions
```

```ts
import {
  createActionInvocation,
  exampleActionManifest,
  validateActionManifest,
} from "@hasna/actions";

const manifest = exampleActionManifest();
const validation = validateActionManifest(manifest);
if (!validation.valid) throw new Error("invalid action manifest");

const invocation = createActionInvocation(manifest, { title: "Need help" });
```

## Contract Boundaries

Action manifests describe what can be executed and what safety contract applies.
The execution owner, such as OpenAutomations, is responsible for queueing,
claiming, retrying, replaying, and storing durable run state.

Core contract pieces:

- `ActionManifest`: action identity, version, schemas, bindings, and policy.
- `ActionInvocation`: one requested execution with actor, input, dry-run flag,
  and idempotency key.
- `ActionRunStatus`: canonical lifecycle status, including `dead` for DLQ.
- `DryRunPreview`: pre-execution summary and policy/approval findings.
- `ApprovalGate` and `ApprovalDecision`: queue-safe approval state for manual
  or step-up actions before execution is claimed.
- `ActionDeadLetter`: terminal DLQ metadata with replay eligibility.
- `ActionAuditEvent`: audit evidence emitted by controllers or executors.

Supported binding kinds are `cli`, `http`, `mcp`, `sdk`, `workflow`, and
`agent`. A manifest must include at least one binding.

## CLI

```sh
actions --help
actions --json status
actions --json manifest example
actions validate manifest.json
```

## MCP Skeleton

The package exposes a small MCP-facing catalog shape:

```ts
import { actionManifestToMcpTool, createActionsMcpCatalog } from "@hasna/actions/mcp";

const tool = actionManifestToMcpTool(manifest);
const catalog = createActionsMcpCatalog([manifest]);
```

The `actions-mcp` binary currently prints capabilities and converts manifest
JSON into MCP tool descriptors. A full stdio server can be layered on this
stable contract later without changing manifest semantics.
