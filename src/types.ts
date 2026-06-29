export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonSchema = {
  $schema?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  enum?: JsonValue[];
  const?: JsonValue;
  default?: JsonValue;
  examples?: JsonValue[];
  [key: string]: unknown;
};

export type ActorType = "human" | "agent" | "service" | "system";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalKind = "none" | "manual" | "policy";
export type ApprovalDecisionValue = "approved" | "denied";
export type GuardrailDecision = "allow" | "warn" | "deny";
export type ActionExecutorKind = "typescript" | "local-shell" | "mcp" | "http";
export type ActionRunStatus =
  | "planned"
  | "previewed"
  | "awaiting_approval"
  | "approved"
  | "denied"
  | "executing"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "cancelled";

export type ActionQueueStatus =
  | "queued"
  | "waiting_approval"
  | "claimed"
  | "retrying"
  | "succeeded"
  | "failed"
  | "dead"
  | "cancelled";

export const ACTION_RUN_STATUSES = [
  "planned",
  "previewed",
  "awaiting_approval",
  "approved",
  "denied",
  "executing",
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled",
] as const satisfies readonly ActionRunStatus[];

export const TERMINAL_ACTION_RUN_STATUSES = [
  "denied",
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled",
] as const satisfies readonly ActionRunStatus[];

export const ACTION_QUEUE_STATUSES = [
  "queued",
  "waiting_approval",
  "claimed",
  "retrying",
  "succeeded",
  "failed",
  "dead",
  "cancelled",
] as const satisfies readonly ActionQueueStatus[];

export const TERMINAL_ACTION_QUEUE_STATUSES = [
  "succeeded",
  "failed",
  "dead",
  "cancelled",
] as const satisfies readonly ActionQueueStatus[];

export function assertActionRunStatus(value: string): ActionRunStatus {
  if (!(ACTION_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unsupported action run status: ${value}`);
  }
  return value as ActionRunStatus;
}

export function isTerminalActionStatus(status: ActionRunStatus): boolean {
  return (TERMINAL_ACTION_RUN_STATUSES as readonly string[]).includes(status);
}

export function assertActionQueueStatus(value: string): ActionQueueStatus {
  if (!(ACTION_QUEUE_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unsupported action queue status: ${value}`);
  }
  return value as ActionQueueStatus;
}

export function isTerminalActionQueueStatus(status: ActionQueueStatus): boolean {
  return (TERMINAL_ACTION_QUEUE_STATUSES as readonly string[]).includes(status);
}

export interface ActorRef {
  id: string;
  type: ActorType;
  roles?: string[];
  displayName?: string;
  metadata?: JsonObject;
}

export interface ActorMetadata {
  types: ActorType[];
  required?: boolean;
  roles?: string[];
  notes?: string;
}

export interface ResourceMetadata {
  type: string;
  identifiers?: string[];
  description?: string;
}

export interface ScopeMetadata {
  level: "local" | "machine" | "workspace" | "project" | "org" | "cloud";
  permissions?: string[];
  boundaries?: string[];
  description?: string;
}

export interface ApprovalRequirement {
  kind: ApprovalKind;
  count?: number;
  roles?: string[];
  reason?: string;
  policy?: string;
}

export interface IdempotencySpec {
  supported: boolean;
  required?: boolean;
  keyHint?: string;
  retentionSeconds?: number;
}

export interface DryRunSpec {
  supported: boolean;
  default?: boolean;
  notes?: string;
}

export interface ConfirmationSpec {
  title: string;
  summaryTemplate?: string;
  fields?: string[];
  warnings?: string[];
}

export interface GuardrailSpec {
  hook: string;
  failClosed?: boolean;
  description?: string;
}

export interface AuditSpec {
  eventTypes: string[];
  includeInput?: boolean;
  includeOutput?: boolean;
  redactedFields?: string[];
}

export interface EvidenceSpec {
  required?: boolean;
  fields?: string[];
  retention?: string;
}

export interface RollbackSpec {
  strategy: "none" | "automatic" | "manual" | "compensating-action";
  actionId?: string;
  notes?: string;
}

export interface TypeScriptExecutorBinding {
  kind: "typescript";
  ref: string;
}

export interface LocalShellExecutorBinding {
  kind: "local-shell";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  inputMode?: "stdin-json" | "env-json" | "stdin-and-env-json" | "none";
  outputMode?: "json" | "text" | "shell-result";
  timeoutMs?: number;
}

export interface McpExecutorBinding {
  kind: "mcp";
  server: string;
  tool: string;
}

export interface HttpExecutorBinding {
  kind: "http";
  method: "POST" | "PUT" | "PATCH";
  url: string;
  headers?: Record<string, string>;
}

export type ActionExecutorBinding =
  | TypeScriptExecutorBinding
  | LocalShellExecutorBinding
  | McpExecutorBinding
  | HttpExecutorBinding;

export interface ActionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  actor: ActorMetadata;
  resource: ResourceMetadata;
  scope: ScopeMetadata;
  riskLevel: RiskLevel;
  requiredApprovals: ApprovalRequirement[];
  idempotency: IdempotencySpec;
  dryRun: DryRunSpec;
  confirmation: ConfirmationSpec;
  guardrail?: GuardrailSpec;
  audit: AuditSpec;
  evidence: EvidenceSpec;
  rollback: RollbackSpec;
  executorBindings: ActionExecutorBinding[];
  metadata?: JsonObject;
}

export interface ActionPlanStep {
  id: string;
  kind: "input" | "guardrail" | "approval" | "execute" | "audit" | "evidence" | "rollback" | string;
  title: string;
  status: "planned" | "skipped";
  detail?: string;
  metadata?: JsonObject;
}

export interface ActionChangePreview {
  kind: string;
  target: string;
  before?: unknown;
  after?: unknown;
  detail?: string;
}

export interface ActionPreview {
  summary: string;
  steps?: ActionPlanStep[];
  changes?: ActionChangePreview[];
  warnings?: string[];
  evidence?: EvidenceRef[];
  metadata?: JsonObject;
}

export interface ActionInvocation<TInput = JsonValue> {
  id: string;
  actionId: string;
  manifestVersion?: string;
  input: TInput;
  actor?: ActorRef;
  requestedAt?: string;
  idempotencyKey?: string;
  automationId?: string;
  runId?: string;
  metadata?: JsonObject;
}

export interface ActionResult<TOutput = JsonValue> {
  summary?: string;
  output?: TOutput;
  evidence?: EvidenceRef[];
  metadata?: JsonObject;
}

export interface ActionError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonValue;
  cause?: string;
  metadata?: JsonObject;
}

export interface ActionDeadLetter {
  reason: string;
  failedAt: string;
  lastError?: ActionError;
  attempts: number;
  replayable: boolean;
  metadata?: JsonObject;
}

export type ActionQueueApprovalDecisionStatus = "pending" | "approved" | "rejected";

export interface ActionQueueApprovalRequirement {
  mode: ApprovalKind;
  requiresApproval: boolean;
  count?: number;
  roles?: string[];
  reason?: string;
  policy?: string;
  metadata?: JsonObject;
}

export interface ActionQueueApprovalDecision {
  id: string;
  status: ActionQueueApprovalDecisionStatus;
  requestedAt: string;
  decidedAt?: string;
  reason?: string;
  metadata?: JsonObject;
}

export interface ActionQueueApprovalGate {
  requirement: ActionQueueApprovalRequirement;
  blockedUntilApproved: boolean;
  decision?: ActionQueueApprovalDecision;
  metadata?: JsonObject;
}

export type ApprovalGate = ActionQueueApprovalGate;

export interface EvidenceRef {
  kind: "file" | "url" | "event" | "log" | "stdout" | "stderr" | "artifact" | string;
  ref: string;
  label?: string;
  metadata?: JsonObject;
}

export interface GuardrailResult {
  decision: GuardrailDecision;
  reason?: string;
  warnings?: string[];
  metadata?: JsonObject;
}

export interface ApprovalDecision {
  actor: ActorRef;
  decision: ApprovalDecisionValue;
  reason?: string;
  createdAt?: string;
  metadata?: JsonObject;
}

export interface ActionAuditEvent {
  id: string;
  runId: string;
  actionId: string;
  type: string;
  time: string;
  actor?: ActorRef;
  severity: "debug" | "info" | "notice" | "warning" | "error" | "critical";
  message?: string;
  data: JsonObject;
  metadata: JsonObject;
}

export interface ActionRun<TInput = unknown, TOutput = unknown> {
  id: string;
  actionId: string;
  actionVersion: string;
  status: ActionRunStatus;
  actor?: ActorRef;
  input: TInput;
  output?: TOutput;
  preview?: ActionPreview;
  plan: ActionPlanStep[];
  riskLevel: RiskLevel;
  requiredApprovals: ApprovalRequirement[];
  approvals: ApprovalDecision[];
  guardrailResults: GuardrailResult[];
  evidence: EvidenceRef[];
  idempotencyKey?: string;
  dryRun: boolean;
  confirmationSummary: string;
  rollback?: RollbackSpec;
  dedupedFromRunId?: string;
  error?: string;
  events: ActionAuditEvent[];
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  executedAt?: string;
  completedAt?: string;
}

export interface SchemaAdapter<T> {
  parse(value: unknown): T;
}

export interface ActionExecutionContext<TInput = unknown> {
  run: ActionRun<TInput>;
  manifest: ActionManifest;
  input: TInput;
  actor?: ActorRef;
  idempotencyKey?: string;
  dryRun: boolean;
}

export interface ActionExecutor<TInput = unknown, TOutput = unknown> {
  plan?: (context: ActionExecutionContext<TInput>) => ActionPlanStep[] | Promise<ActionPlanStep[]>;
  preview?: (context: ActionExecutionContext<TInput>) => ActionPreview | Promise<ActionPreview>;
  execute: (context: ActionExecutionContext<TInput>) => TOutput | Promise<TOutput>;
  rollback?: (context: ActionExecutionContext<TInput> & { output?: TOutput; error?: unknown }) => ActionPreview | Promise<ActionPreview>;
}

export interface ActionDefinition<TInput = unknown, TOutput = unknown> {
  manifest: ActionManifest;
  input?: SchemaAdapter<TInput>;
  output?: SchemaAdapter<TOutput>;
  executor: ActionExecutor<TInput, TOutput>;
}

export interface ActionRequest {
  actionId: string;
  input: unknown;
  actor?: ActorRef;
  idempotencyKey?: string;
  dryRun?: boolean;
  evidence?: EvidenceRef[];
  metadata?: JsonObject;
}

export interface RunActionOptions {
  autoApprove?: ApprovalDecision;
  rollbackOnFailure?: boolean;
}

export type ActionGuardrailHook = (context: ActionExecutionContext) => GuardrailResult | Promise<GuardrailResult>;
export type ActionAuditSink = (event: ActionAuditEvent) => void | Promise<void>;
