import {
  parseContract,
  SCHEMA_IDS,
  type ActorKind,
  type ActorPointer,
  type ActorRef,
  type ActorRefInput,
  type CapabilityCard,
  type CapabilityCardInput,
  type ContractStatus,
  type DecisionEnvelope,
  type DecisionEnvelopeInput,
  type EvidencePointer,
  type EvidenceRef,
  type EvidenceRefInput,
  type ResourcePointer,
  type WorkRun,
  type WorkRunInput,
} from "@hasna/contracts";
import type {
  ActionActor,
  ActionInvocation,
  ActionManifest,
  ActionRun,
  ActionRunStatus,
  ApprovalDecision,
  ApprovalDecisionStatus,
  DryRunContract,
  JsonObject,
} from "../types.js";

export const ACTIONS_CONTRACT_SOURCE_PACKAGE = "@hasna/actions" as const;

// actor_ref.v1 has "human" but not "user"; preserve the original ActionActor
// type in metadata for identity adapters that need the legacy vocabulary.
export const ACTION_ACTOR_KIND_TO_CONTRACT_KIND = {
  user: "human",
  agent: "agent",
  system: "system",
  service: "service",
} as const satisfies Record<ActionActor["type"], ActorKind>;

export const ACTION_RUN_STATUS_TO_CONTRACT_STATUS = {
  pending: "pending",
  queued: "pending",
  waiting_approval: "pending",
  claimed: "running",
  running: "running",
  retrying: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  dead: "failed",
} as const satisfies Record<ActionRunStatus, ContractStatus>;

export const APPROVAL_DECISION_STATUS_TO_CONTRACT_STATUS = {
  pending: "approval_required",
  approved: "allowed",
  rejected: "denied",
  expired: "denied",
  cancelled: "skipped",
} as const satisfies Record<ApprovalDecisionStatus, DecisionEnvelope["status"]>;

const CONTRACT_URI_PREFIXES = [
  "artifact://",
  "repo://",
  "project://",
  "dashboard://",
  "render://",
  "integration://",
  "task://",
  "todo://",
  "file://",
  "files://",
  "mailery://",
  "conversation://",
  "knowledge://",
  "memento://",
  "http://",
  "https://",
  "git+https://",
] as const;

export interface ContractAdapterOptions {
  createdAt?: string;
}

export interface ApprovalDecisionContractOptions extends ContractAdapterOptions {
  actionId?: string;
  manifestVersion?: string;
}

export interface ActionRunContractOptions {
  objective?: string;
}

export interface CapabilityCardOptions extends ContractAdapterOptions {
  version?: string;
}

export interface ExampleActionContracts {
  actorRef: ActorRef;
  evidenceRef: EvidenceRef;
  decisionEnvelope: DecisionEnvelope;
  workRun: WorkRun;
  capabilityCard: CapabilityCard;
}

export function actionActorKindToContractKind(kind: ActionActor["type"]): ActorKind {
  return ACTION_ACTOR_KIND_TO_CONTRACT_KIND[kind];
}

export function actionRunStatusToContractStatus(status: ActionRunStatus): ContractStatus {
  return ACTION_RUN_STATUS_TO_CONTRACT_STATUS[status];
}

export function actionActorToActorPointer(actor: ActionActor | undefined): ActorPointer {
  if (!actor) {
    return {
      kind: "system",
      id: "actions-runtime",
      name: "Actions runtime",
      provider: ACTIONS_CONTRACT_SOURCE_PACKAGE,
    };
  }

  return pruneUndefined({
    kind: actionActorKindToContractKind(actor.type),
    id: actor.id,
    name: actor.displayName,
  });
}

export function actionActorToActorRef(actor: ActionActor, options: ContractAdapterOptions = {}): ActorRef {
  const draft: ActorRefInput = {
    schema: SCHEMA_IDS.actorRef,
    id: actor.id,
    createdAt: options.createdAt ?? new Date().toISOString(),
    kind: actionActorKindToContractKind(actor.type),
    name: actor.displayName,
    capabilities: actor.type === "agent" ? ["action-execution"] : [],
    metadata: pruneUndefined({
      ...actor.metadata,
      sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
      originalActionActorType: actor.type,
      tenantId: actor.tenantId,
    }),
  };

  return parseContract(SCHEMA_IDS.actorRef, pruneUndefined(draft));
}

export function evidenceRefFromActionEvidenceRef(
  evidenceRef: string,
  options: ContractAdapterOptions & {
    id?: string;
    kind?: EvidenceRefInput["kind"];
    summary?: string;
  } = {},
): EvidenceRef {
  const draft: EvidenceRefInput = {
    schema: SCHEMA_IDS.evidenceRef,
    id: options.id ?? stableId("evidence", evidenceRef),
    createdAt: options.createdAt ?? new Date().toISOString(),
    kind: options.kind ?? "artifact",
    uri: evidenceUriFromRef(evidenceRef),
    summary: options.summary ?? "Evidence referenced by an @hasna/actions contract.",
    redaction: "unknown",
    tags: ["actions"],
    metadata: {
      sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
      originalEvidenceRef: evidenceRef,
      lossyMapping: "ApprovalDecision.evidenceRef is a string; evidence_ref.v1 requires a URI, so non-URI refs are represented under artifact://actions/evidence/.",
    },
  };

  return parseContract(SCHEMA_IDS.evidenceRef, draft);
}

export function approvalDecisionToDecisionEnvelope(
  decision: ApprovalDecision,
  options: ApprovalDecisionContractOptions = {},
): DecisionEnvelope {
  const status = APPROVAL_DECISION_STATUS_TO_CONTRACT_STATUS[decision.status];
  const action = actionResourcePointer(options.actionId ?? "unknown-action", options.manifestVersion);
  const evidence = decision.evidenceRef ? [evidencePointerFromActionEvidenceRef(decision.evidenceRef)] : [];
  const obligations = approvalDecisionObligations(decision.status);
  const selected = decision.status === "approved" ? [action] : [];
  const skipped = status === "skipped" ? [action] : [];

  const draft: DecisionEnvelopeInput = {
    schema: SCHEMA_IDS.decisionEnvelope,
    id: decision.id,
    createdAt: decision.requestedAt,
    updatedAt: decision.decidedAt,
    decisionType: "approval",
    status,
    actor: actionActorToActorPointer(decision.decidedBy ?? decision.requestedBy),
    selected,
    skipped,
    reason: decision.reason ?? defaultApprovalReason(decision.status),
    obligations,
    evidenceRefs: evidence,
    metadata: pruneUndefined({
      ...decision.metadata,
      sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
      originalApprovalDecisionStatus: decision.status,
      originalEvidenceRef: decision.evidenceRef,
      requestedByActionActorType: decision.requestedBy?.type,
      requestedByTenantId: decision.requestedBy?.tenantId,
      decidedByActionActorType: decision.decidedBy?.type,
      decidedByTenantId: decision.decidedBy?.tenantId,
      lossyMapping: "ApprovalDecision uses one evidenceRef string; decision_envelope.v1 uses evidenceRefs pointers.",
    }),
  };

  return parseContract(SCHEMA_IDS.decisionEnvelope, pruneUndefined(draft));
}

export function actionInvocationToWorkRun(
  invocation: ActionInvocation,
  options: ActionRunContractOptions = {},
): WorkRun {
  const draft: WorkRunInput = {
    schema: SCHEMA_IDS.workRun,
    id: invocation.runId ?? `invocation_${invocation.id}`,
    createdAt: invocation.requestedAt,
    objective: options.objective ?? `Execute action ${invocation.actionId}.`,
    status: "pending",
    actor: actionActorToActorPointer(invocation.actor),
    resourceRefs: [
      actionResourcePointer(invocation.actionId, invocation.manifestVersion),
      invocationResourcePointer(invocation),
    ],
    constraints: invocation.dryRun ? ["dry-run-requested"] : [],
    metadata: pruneUndefined({
      sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
      actionId: invocation.actionId,
      invocationId: invocation.id,
      manifestVersion: invocation.manifestVersion,
      automationId: invocation.automationId,
      dryRun: invocation.dryRun,
      idempotencyKey: invocation.idempotencyKey,
      inputRedacted: true,
      runtimeMetadataRedacted: hasOwnMetadata(invocation.metadata),
      runtimeMetadataKeys: metadataKeys(invocation.metadata),
      actorOriginalActionActorType: invocation.actor?.type,
      actorTenantId: invocation.actor?.tenantId,
      lossyMapping: "ActionInvocation input and runtime metadata have no first-class work_run.v1 fields and are not copied into shared contract metadata by default; ids, state, and redaction markers are preserved.",
    }),
  };

  return parseContract(SCHEMA_IDS.workRun, draft);
}

export function actionRunToWorkRun(run: ActionRun, options: ActionRunContractOptions = {}): WorkRun {
  const status = actionRunStatusToContractStatus(run.status);
  const decisions = run.approvalGate?.decision
    ? [approvalDecisionToDecisionEnvelope(run.approvalGate.decision, {
      actionId: run.invocation.actionId,
      manifestVersion: run.invocation.manifestVersion,
    })]
    : [];
  const evidenceRefs = collectActionRunEvidenceRefs(run, status, decisions);
  const finishedAt = isTerminalContractStatus(status) ? run.completedAt ?? run.updatedAt : run.completedAt;

  const draft: WorkRunInput = {
    schema: SCHEMA_IDS.workRun,
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    objective: options.objective ?? `Execute action ${run.invocation.actionId}.`,
    status,
    actor: actionActorToActorPointer(run.invocation.actor),
    traceId: run.invocation.runId ?? run.id,
    startedAt: run.startedAt ?? run.claimedAt,
    finishedAt,
    constraints: [
      run.invocation.dryRun ? "dry-run-requested" : undefined,
      run.approvalGate?.blockedUntilApproved ? "blocked-until-approved" : undefined,
    ].filter(isString),
    resourceRefs: [
      actionResourcePointer(run.invocation.actionId, run.invocation.manifestVersion),
      invocationResourcePointer(run.invocation),
      runResourcePointer(run.id),
    ],
    decisions,
    evidenceRefs,
    metadata: pruneUndefined({
      sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
      originalActionRunStatus: run.status,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      claimedBy: run.claimedBy,
      nextAttemptAt: run.nextAttemptAt,
      actionId: run.invocation.actionId,
      invocationId: run.invocation.id,
      manifestVersion: run.invocation.manifestVersion,
      automationId: run.invocation.automationId,
      idempotencyKey: run.invocation.idempotencyKey,
      inputRedacted: true,
      dryRun: run.invocation.dryRun,
      resultOutputRedacted: run.result?.output !== undefined ? true : undefined,
      resultSummaryRedacted: run.result?.summary !== undefined ? true : undefined,
      errorRedacted: run.error !== undefined ? true : undefined,
      errorCode: run.error?.code,
      errorRetryable: run.error?.retryable,
      deadLetterRedacted: run.deadLetter !== undefined ? true : undefined,
      deadLetterAttempts: run.deadLetter?.attempts,
      deadLetterReplayable: run.deadLetter?.replayable,
      runtimeMetadataRedacted: hasOwnMetadata(run.metadata),
      runtimeMetadataKeys: metadataKeys(run.metadata),
      actorOriginalActionActorType: run.invocation.actor?.type,
      actorTenantId: run.invocation.actor?.tenantId,
      lossyMapping: "ActionRun retry, result, error, and dead-letter payloads have no first-class work_run.v1 fields and are not copied into shared contract metadata by default; safe state, evidence pointers, and redaction markers are preserved.",
    }),
  };

  return parseContract(SCHEMA_IDS.workRun, pruneUndefined(draft));
}

export function actionManifestToCapabilityCard(
  manifest: ActionManifest,
  options: CapabilityCardOptions = {},
): CapabilityCard {
  const bindingKinds = [...new Set(manifest.bindings.map((binding) => binding.kind))].sort();
  const dryRun = dryRunCapabilities(manifest.dryRun);
  const capabilities = [
    "action-manifest",
    "manifest-validation",
    ...bindingKinds.map((kind) => `binding:${kind}`),
    manifest.idempotency?.required ? `idempotency:${manifest.idempotency.scope}` : undefined,
    manifest.approval?.requiresApproval ? `approval:${manifest.approval.mode}` : undefined,
    ...dryRun.capabilities,
  ].filter(isString);
  const limitations = [
    ...dryRun.limitations,
    manifest.secrets && manifest.secrets.length > 0 ? "requires configured secret references" : undefined,
    manifest.sandbox?.filesystem ? `filesystem:${manifest.sandbox.filesystem}` : undefined,
    manifest.sandbox?.network ? `network:${manifest.sandbox.network}` : undefined,
  ].filter(isString);

  const draft: CapabilityCardInput = {
    schema: SCHEMA_IDS.capabilityCard,
    id: stableId("capability", manifest.id),
    createdAt: options.createdAt ?? new Date().toISOString(),
    kind: "tool",
    name: manifest.title ?? manifest.name,
    version: manifest.version,
    status: "available",
    capabilities,
    limitations,
    riskLevel: manifest.policy?.risk ?? "unknown",
    metadata: pruneUndefined({
      sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
      actionId: manifest.id,
      namespace: manifest.namespace,
      bindingKinds,
      dryRun: manifest.dryRun,
      lossyMapping: "DryRunContract is represented as capability and limitation metadata because capability_card.v1 has no dry-run-specific field.",
    }),
  };

  return parseContract(SCHEMA_IDS.capabilityCard, pruneUndefined(draft));
}

export function createActionsCliCapabilityCard(options: CapabilityCardOptions = {}): CapabilityCard {
  const draft: CapabilityCardInput = {
    schema: SCHEMA_IDS.capabilityCard,
    id: "capability_actions_cli",
    createdAt: options.createdAt ?? new Date().toISOString(),
    kind: "tool",
    name: "actions CLI",
    version: options.version ?? "0.1.0",
    status: "available",
    capabilities: [
      "status",
      "manifest:example",
      "manifest:validate",
      "mcp:capabilities",
      "contracts:examples",
    ],
    limitations: [
      "does not execute actions directly",
      "requires external runner for queueing and durable state",
    ],
    riskLevel: "medium",
    metadata: {
      sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
      command: "actions",
    },
  };

  return parseContract(SCHEMA_IDS.capabilityCard, draft);
}

export function createExampleActionContracts(options: ContractAdapterOptions = {}): ExampleActionContracts {
  const createdAt = options.createdAt ?? "2026-06-28T00:00:00.000Z";
  const actor: ActionActor = {
    id: "user_123",
    type: "user",
    displayName: "Pat Reviewer",
    tenantId: "tenant_hasna",
    metadata: { role: "approver" },
  };
  const invocation: ActionInvocation = {
    id: "inv_123",
    actionId: "tickets.create",
    manifestVersion: "1.0.0",
    input: { title: "Need help" },
    actor,
    runId: "run_123",
    dryRun: true,
    requestedAt: createdAt,
  };
  const approval: ApprovalDecision = {
    id: "approval_123",
    status: "approved",
    requestedAt: createdAt,
    decidedAt: "2026-06-28T00:01:00.000Z",
    requestedBy: actor,
    decidedBy: actor,
    reason: "Approved after dry-run preview.",
    evidenceRef: "artifact://actions/evidence/approval_123",
  };
  const run: ActionRun = {
    id: "run_123",
    invocation,
    status: "succeeded",
    attempt: 1,
    maxAttempts: 3,
    createdAt,
    updatedAt: "2026-06-28T00:02:00.000Z",
    claimedBy: "agent_actions_runner",
    claimedAt: "2026-06-28T00:00:30.000Z",
    startedAt: "2026-06-28T00:00:45.000Z",
    completedAt: "2026-06-28T00:02:00.000Z",
    approvalGate: {
      requirement: { mode: "manual", requiresApproval: true },
      decision: approval,
      blockedUntilApproved: false,
    },
    result: {
      summary: "Created ticket TCK-123.",
      output: { ticketId: "TCK-123" },
    },
  };

  return {
    actorRef: actionActorToActorRef(actor, { createdAt }),
    evidenceRef: evidenceRefFromActionEvidenceRef("artifact://actions/evidence/approval_123", { createdAt }),
    decisionEnvelope: approvalDecisionToDecisionEnvelope(approval, {
      createdAt,
      actionId: invocation.actionId,
      manifestVersion: invocation.manifestVersion,
    }),
    workRun: actionRunToWorkRun(run),
    capabilityCard: createActionsCliCapabilityCard({ createdAt }),
  };
}

function approvalDecisionObligations(status: ApprovalDecisionStatus): string[] {
  if (status === "pending") return ["await-approval-decision"];
  if (status === "rejected") return ["do-not-execute-action"];
  if (status === "expired") return ["request-new-approval"];
  return [];
}

function defaultApprovalReason(status: ApprovalDecisionStatus): string {
  if (status === "pending") return "Approval is pending.";
  if (status === "approved") return "Approval was granted.";
  if (status === "rejected") return "Approval was rejected.";
  if (status === "expired") return "Approval expired before a decision.";
  return "Approval was cancelled.";
}

function dryRunCapabilities(dryRun: DryRunContract | undefined): {
  capabilities: string[];
  limitations: string[];
} {
  if (!dryRun) return { capabilities: [], limitations: ["dry-run contract unspecified"] };
  if (!dryRun.supported) return { capabilities: [], limitations: ["dry-run unsupported"] };
  return {
    capabilities: [`dry-run:${dryRun.defaultMode ?? "preview-only"}`],
    limitations: dryRun.outputSchema ? [] : ["dry-run output schema unspecified"],
  };
}

function collectActionRunEvidenceRefs(
  run: ActionRun,
  status: ContractStatus,
  decisions: DecisionEnvelope[],
): EvidencePointer[] {
  const evidenceRefs: EvidencePointer[] = [];
  const approvalEvidenceRef = run.approvalGate?.decision?.evidenceRef;
  if (approvalEvidenceRef) {
    evidenceRefs.push(evidencePointerFromActionEvidenceRef(approvalEvidenceRef, "Approval evidence."));
  }
  for (const auditEvent of run.result?.auditEvents ?? []) {
    evidenceRefs.push({
      id: auditEvent.id,
      kind: "artifact",
      summary: `${auditEvent.source}:${auditEvent.type}`,
    });
  }

  if (status === "succeeded" && run.result) {
    evidenceRefs.push({
      id: `${run.id}_result`,
      kind: "artifact",
      summary: "Action run result is stored outside the shared work_run contract.",
    });
  }
  if (status === "succeeded" && evidenceRefs.length === 0) {
    evidenceRefs.push({
      id: `${run.id}_result`,
      kind: "artifact",
      summary: "Action run succeeded; result details are stored outside the shared work_run contract.",
    });
  }
  if (status === "failed" && evidenceRefs.length === 0 && decisions.length === 0) {
    evidenceRefs.push({
      id: `${run.id}_failure`,
      kind: "artifact",
      summary: "Action run failed; error details are stored outside the shared work_run contract.",
    });
  }

  return evidenceRefs;
}

function evidencePointerFromActionEvidenceRef(evidenceRef: string, summary?: string): EvidencePointer {
  return {
    id: stableId("evidence", evidenceRef),
    kind: "artifact",
    uri: evidenceUriFromRef(evidenceRef),
    summary,
  };
}

function actionResourcePointer(actionId: string, manifestVersion?: string): ResourcePointer {
  return {
    kind: "action",
    id: stableId("action", `${actionId}_${manifestVersion ?? "latest"}`),
    name: actionId,
    externalId: actionId,
    sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
    tags: manifestVersion ? [`version:${manifestVersion}`] : [],
  };
}

function invocationResourcePointer(invocation: ActionInvocation): ResourcePointer {
  return {
    kind: "run",
    id: stableId("invocation", invocation.id),
    name: `Invocation ${invocation.id}`,
    externalId: invocation.id,
    sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
    tags: [],
  };
}

function runResourcePointer(runId: string): ResourcePointer {
  return {
    kind: "run",
    id: stableId("run", runId),
    name: `Action run ${runId}`,
    externalId: runId,
    sourcePackage: ACTIONS_CONTRACT_SOURCE_PACKAGE,
    tags: [],
  };
}

function evidenceUriFromRef(value: string): string {
  if (CONTRACT_URI_PREFIXES.some((prefix) => value.startsWith(prefix))) return value;
  return `artifact://actions/evidence/${encodeURIComponent(value)}`;
}

function stableId(prefix: string, value: string): string {
  const slug = value
    .replace(/[^a-zA-Z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return `${prefix}_${slug || "ref"}`;
}

function isTerminalContractStatus(status: ContractStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "blocked" || status === "skipped";
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOwnMetadata(value: JsonObject | undefined): boolean | undefined {
  return value && Object.keys(value).length > 0 ? true : undefined;
}

function metadataKeys(value: JsonObject | undefined): string[] | undefined {
  const keys = value ? Object.keys(value).sort() : [];
  return keys.length > 0 ? keys : undefined;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}
