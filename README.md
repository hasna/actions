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
actions --json contracts examples
```

## `@hasna/contracts` Adapters

The package exports additive adapters for `hasna.actor_ref.v1`,
`hasna.evidence_ref.v1`, `hasna.work_run.v1`,
`hasna.decision_envelope.v1`, and `hasna.capability_card.v1`. Adapter output is
validated with `parseContract` from `@hasna/contracts`.

Mapping notes:

- `ActionActor.type` maps `user -> human`, `agent -> agent`,
  `system -> system`, and `service -> service`. The original action actor type
  remains in contract metadata, either as `metadata.originalActionActorType` on
  full actor refs or as `metadata.*ActionActorType` fields on enclosing
  `decision_envelope` and `work_run` payloads whose actor fields are pointers.
- `ActionRunStatus` maps `pending|queued|waiting_approval -> pending`,
  `claimed|running|retrying -> running`, `succeeded -> succeeded`,
  `failed|dead -> failed`, `cancelled -> cancelled`, and `skipped -> skipped`.
  The original action status remains in `metadata.originalActionRunStatus`.
- `ApprovalDecision.evidenceRef` is a string, while `evidence_ref.v1` requires a
  URI. Existing URI-shaped values are preserved; other values are represented as
  `artifact://actions/evidence/<encoded-ref>` with the original string in
  metadata.
- `ApprovalDecision.status` maps `pending -> approval_required`,
  `approved -> allowed`, `rejected|expired -> denied`, and
  `cancelled -> skipped`.
- `ActionInvocation`, `ActionRun` result/error details, `ActionActor.metadata`,
  `ApprovalDecision.metadata`, and `DryRunContract` do not have exact one-to-one
  fields in the shared schemas; ids, idempotency-key redaction markers, dry-run
  constraints, status, retry counters, safe error codes, metadata key names, and
  redaction markers are preserved in metadata and capability/constraint fields.
  Raw invocation input, result output, arbitrary runtime metadata, idempotency
  keys, error objects, approval metadata values, actor metadata values, and
  dead-letter objects are not copied into shared contract metadata by default.

```ts
import {
  actionActorToActorRef,
  actionRunToWorkRun,
  createActionsCliCapabilityCard,
} from "@hasna/actions";
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
