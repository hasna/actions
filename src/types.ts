export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type ActionSchema = Record<string, unknown>;

export const ACTION_MANIFEST_SCHEMA_VERSION = "1.0" as const;

export const ACTION_BINDING_KINDS = [
  "cli",
  "http",
  "mcp",
  "sdk",
  "workflow",
  "agent",
] as const;

export type ActionBindingKind = (typeof ACTION_BINDING_KINDS)[number];

export const ACTION_RUN_STATUSES = [
  "pending",
  "queued",
  "waiting_approval",
  "claimed",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "dead",
] as const;

export type ActionRunStatus = (typeof ACTION_RUN_STATUSES)[number];

export const TERMINAL_ACTION_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "dead",
] as const satisfies readonly ActionRunStatus[];

export type TerminalActionRunStatus = (typeof TERMINAL_ACTION_RUN_STATUSES)[number];

export const SUPPORTED_ACTION_MANIFEST_SCHEMA_VERSIONS = [
  ACTION_MANIFEST_SCHEMA_VERSION,
] as const;

export type SupportedActionManifestSchemaVersion = (typeof SUPPORTED_ACTION_MANIFEST_SCHEMA_VERSIONS)[number];

export type IdempotencyScope = "global" | "tenant" | "actor" | "automation" | "action";
export type ApprovalMode = "never" | "preview" | "manual" | "step-up";
export type ApprovalDecisionStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
export type ActionRiskLevel = "low" | "medium" | "high" | "critical";
export type RetryStrategy = "none" | "fixed" | "exponential";

export interface ActionBinding {
  kind: ActionBindingKind;
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  package?: string;
  export?: string;
  toolName?: string;
  workflowRef?: string;
  timeoutMs?: number;
  metadata?: JsonObject;
}

export interface IdempotencyContract {
  required: boolean;
  scope: IdempotencyScope;
  keyTemplate?: string;
  ttlSeconds?: number;
  conflictPolicy?: "return-existing" | "reject" | "enqueue-new-attempt";
}

export interface DryRunContract {
  supported: boolean;
  defaultMode?: "preview-only" | "preview-and-policy" | "execute";
  outputSchema?: ActionSchema;
}

export interface ApprovalRequirement {
  mode: ApprovalMode;
  requiresApproval: boolean;
  reason?: string;
  approverKinds?: Array<"human" | "policy" | "system">;
  timeoutSeconds?: number;
}

export interface ApprovalDecision {
  id: string;
  status: ApprovalDecisionStatus;
  requestedAt: string;
  decidedAt?: string;
  requestedBy?: ActionActor;
  decidedBy?: ActionActor;
  reason?: string;
  evidenceRef?: string;
  metadata?: JsonObject;
}

export interface ApprovalGate {
  requirement: ApprovalRequirement;
  decision?: ApprovalDecision;
  blockedUntilApproved: boolean;
}

export interface PolicyHook {
  id: string;
  name?: string;
  kind: "preflight" | "pre-execute" | "post-execute";
  ref: string;
  failClosed?: boolean;
}

export interface ActionPolicy {
  risk: ActionRiskLevel;
  hooks?: PolicyHook[];
  allowedActors?: string[];
  deniedActors?: string[];
}

export interface SecretReference {
  name: string;
  ref: string;
  required?: boolean;
  redaction?: "full" | "partial" | "none";
  env?: string;
}

export interface SandboxRequirement {
  profile?: string;
  network?: "deny" | "allow" | "limited";
  filesystem?: "readonly" | "workspace" | "limited" | "full";
  commands?: "deny" | "allowlisted" | "allow";
  allowlist?: string[];
}

export interface RetryPolicy {
  strategy: RetryStrategy;
  maxAttempts: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  multiplier?: number;
}

export interface AuditContract {
  eventSource?: string;
  includeInput?: boolean;
  includeOutput?: boolean;
  redactPaths?: string[];
  evidenceRefs?: string[];
}

export interface ActionManifest<
  TInputSchema extends ActionSchema = ActionSchema,
  TOutputSchema extends ActionSchema = ActionSchema,
> {
  schemaVersion: SupportedActionManifestSchemaVersion;
  id: string;
  name: string;
  version: string;
  namespace?: string;
  title?: string;
  description?: string;
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  bindings: ActionBinding[];
  idempotency?: IdempotencyContract;
  dryRun?: DryRunContract;
  approval?: ApprovalRequirement;
  policy?: ActionPolicy;
  secrets?: SecretReference[];
  sandbox?: SandboxRequirement;
  retry?: RetryPolicy;
  audit?: AuditContract;
  metadata?: JsonObject;
}

export interface ActionActor {
  id: string;
  type: "user" | "agent" | "system" | "service";
  displayName?: string;
  tenantId?: string;
  metadata?: JsonObject;
}

export interface ActionInvocation<TInput extends JsonValue = JsonObject> {
  id: string;
  actionId: string;
  manifestVersion: string;
  input: TInput;
  actor?: ActionActor;
  automationId?: string;
  runId?: string;
  dryRun?: boolean;
  idempotencyKey?: string;
  requestedAt: string;
  metadata?: JsonObject;
}

export interface DryRunPreview<TPreview extends JsonValue = JsonObject> {
  invocationId: string;
  actionId: string;
  safeToRun: boolean;
  summary?: string;
  preview?: TPreview;
  requiredApprovals?: ApprovalRequirement[];
  policyFindings?: PolicyFinding[];
  metadata?: JsonObject;
}

export interface PolicyFinding {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  policyRef?: string;
  metadata?: JsonObject;
}

export interface ActionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
}

export interface ActionResult<TOutput extends JsonValue = JsonValue> {
  output?: TOutput;
  summary?: string;
  auditEvents?: ActionAuditEvent[];
  metadata?: JsonObject;
}

export interface ActionDeadLetter {
  reason: string;
  failedAt: string;
  lastError?: ActionError;
  attempts: number;
  replayable: boolean;
  replayAfter?: string;
  metadata?: JsonObject;
}

export interface ActionRun<TInput extends JsonValue = JsonObject, TOutput extends JsonValue = JsonValue> {
  id: string;
  invocation: ActionInvocation<TInput>;
  status: ActionRunStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  claimedBy?: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  nextAttemptAt?: string;
  approvalGate?: ApprovalGate;
  result?: ActionResult<TOutput>;
  error?: ActionError;
  deadLetter?: ActionDeadLetter;
  metadata?: JsonObject;
}

export interface ActionAuditEvent<TData extends JsonObject = JsonObject> {
  id: string;
  source: string;
  type: string;
  actionId: string;
  invocationId?: string;
  runId?: string;
  time: string;
  actor?: ActionActor;
  data: TData;
  metadata?: JsonObject;
}

export interface ActionManifestValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ActionManifestValidationResult {
  valid: boolean;
  errors: ActionManifestValidationError[];
  manifest?: ActionManifest;
}
