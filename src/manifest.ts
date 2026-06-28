import { randomUUID } from "node:crypto";
import type {
  ActionAuditEvent,
  ActionBindingKind,
  ActionDeadLetter,
  ActionError,
  ActionInvocation,
  ActionManifest,
  ActionManifestValidationError,
  ActionManifestValidationResult,
  ActionRunStatus,
  DryRunPreview,
  JsonObject,
  JsonValue,
} from "./types.js";
import {
  ACTION_BINDING_KINDS,
  ACTION_MANIFEST_SCHEMA_VERSION,
  ACTION_RUN_STATUSES,
  SUPPORTED_ACTION_MANIFEST_SCHEMA_VERSIONS,
  TERMINAL_ACTION_RUN_STATUSES,
} from "./types.js";

export class ActionManifestValidationException extends Error {
  readonly errors: ActionManifestValidationError[];

  constructor(errors: ActionManifestValidationError[]) {
    super(`Invalid action manifest: ${errors.map((error) => `${error.path} ${error.message}`).join("; ")}`);
    this.name = "ActionManifestValidationException";
    this.errors = errors;
  }
}

export function validateActionManifest(input: unknown): ActionManifestValidationResult {
  const errors: ActionManifestValidationError[] = [];

  if (!isRecord(input)) {
    return {
      valid: false,
      errors: [{ path: "$", code: "manifest.type", message: "manifest must be an object" }],
    };
  }

  requireString(errors, input, "schemaVersion");
  requireString(errors, input, "id");
  requireString(errors, input, "name");
  requireString(errors, input, "version");
  if (typeof input.schemaVersion === "string" && !(SUPPORTED_ACTION_MANIFEST_SCHEMA_VERSIONS as readonly string[]).includes(input.schemaVersion)) {
    errors.push({ path: "$.schemaVersion", code: "schema_version.unsupported", message: `schemaVersion must be one of ${SUPPORTED_ACTION_MANIFEST_SCHEMA_VERSIONS.join(", ")}` });
  }

  if (typeof input.id === "string" && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(input.id)) {
    errors.push({ path: "$.id", code: "manifest.id", message: "id must start with an alphanumeric character and contain only letters, numbers, dots, underscores, colons, or dashes" });
  }

  if (input.inputSchema !== undefined && !isRecord(input.inputSchema)) {
    errors.push({ path: "$.inputSchema", code: "manifest.input_schema", message: "inputSchema must be an object when provided" });
  }
  if (input.outputSchema !== undefined && !isRecord(input.outputSchema)) {
    errors.push({ path: "$.outputSchema", code: "manifest.output_schema", message: "outputSchema must be an object when provided" });
  }

  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    errors.push({ path: "$.bindings", code: "bindings.required", message: "at least one binding is required" });
  } else {
    input.bindings.forEach((binding, index) => validateBinding(errors, binding, index));
  }

  if (input.idempotency !== undefined) {
    validateIdempotency(errors, input.idempotency);
  }
  if (input.approval !== undefined) {
    validateApproval(errors, input.approval);
  }
  if (input.policy !== undefined) {
    validatePolicy(errors, input.policy);
  }
  if (input.secrets !== undefined) {
    validateSecrets(errors, input.secrets);
  }
  if (input.retry !== undefined) {
    validateRetry(errors, input.retry);
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest: errors.length === 0 ? input as unknown as ActionManifest : undefined,
  };
}

export function parseActionManifest(input: unknown): ActionManifest {
  const result = validateActionManifest(input);
  if (!result.valid || !result.manifest) {
    throw new ActionManifestValidationException(result.errors);
  }
  return result.manifest;
}

export function isTerminalActionStatus(status: ActionRunStatus): boolean {
  return (TERMINAL_ACTION_RUN_STATUSES as readonly string[]).includes(status);
}

export function isRetryableActionStatus(status: ActionRunStatus): boolean {
  return status === "failed" || status === "retrying";
}

export function assertActionRunStatus(status: string): ActionRunStatus {
  if (!(ACTION_RUN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unknown action run status: ${status}`);
  }
  return status as ActionRunStatus;
}

export function createActionInvocation<TInput extends JsonValue = JsonObject>(
  manifest: ActionManifest,
  input: TInput,
  options: Partial<Omit<ActionInvocation<TInput>, "id" | "actionId" | "manifestVersion" | "input" | "requestedAt">> & {
    id?: string;
    requestedAt?: string | Date;
  } = {},
): ActionInvocation<TInput> {
  const requestedAt = normalizeIsoTime(options.requestedAt);
  const invocation: ActionInvocation<TInput> = {
    id: options.id ?? randomUUID(),
    actionId: manifest.id,
    manifestVersion: manifest.version,
    input,
    actor: options.actor,
    automationId: options.automationId,
    runId: options.runId,
    dryRun: options.dryRun,
    idempotencyKey: options.idempotencyKey ?? deriveIdempotencyKey(manifest, input),
    requestedAt,
    metadata: options.metadata,
  };
  return pruneUndefined(invocation);
}

export function deriveIdempotencyKey(manifest: ActionManifest, input: JsonValue): string | undefined {
  if (!manifest.idempotency?.required) return undefined;
  const template = manifest.idempotency.keyTemplate;
  if (!template) return `${manifest.id}:${manifest.version}:${stableStringify(input)}`;
  return template
    .replaceAll("{action.id}", manifest.id)
    .replaceAll("{action.version}", manifest.version)
    .replace(/\{input\.([a-zA-Z0-9_.-]+)\}/g, (_match, path: string) => stringifyTemplateValue(readPath(input, path)));
}

export function createDryRunPreview<TPreview extends JsonValue = JsonObject>(
  invocation: ActionInvocation,
  input: Omit<DryRunPreview<TPreview>, "invocationId" | "actionId">,
): DryRunPreview<TPreview> {
  return {
    invocationId: invocation.id,
    actionId: invocation.actionId,
    ...input,
  };
}

export function createDeadLetter(input: {
  reason: string;
  attempts: number;
  lastError?: ActionError;
  replayable?: boolean;
  replayAfter?: string | Date;
  failedAt?: string | Date;
  metadata?: JsonObject;
}): ActionDeadLetter {
  return pruneUndefined({
    reason: input.reason,
    failedAt: normalizeIsoTime(input.failedAt),
    lastError: input.lastError,
    attempts: input.attempts,
    replayable: input.replayable ?? true,
    replayAfter: input.replayAfter ? normalizeIsoTime(input.replayAfter) : undefined,
    metadata: input.metadata,
  }) as ActionDeadLetter;
}

export function createActionAuditEvent<TData extends JsonObject = JsonObject>(
  input: Omit<ActionAuditEvent<TData>, "id" | "time"> & { id?: string; time?: string | Date },
): ActionAuditEvent<TData> {
  return pruneUndefined({
    id: input.id ?? randomUUID(),
    source: input.source,
    type: input.type,
    actionId: input.actionId,
    invocationId: input.invocationId,
    runId: input.runId,
    time: normalizeIsoTime(input.time),
    actor: input.actor,
    data: input.data,
    metadata: input.metadata,
  }) as ActionAuditEvent<TData>;
}

export function exampleActionManifest(): ActionManifest {
  return {
    schemaVersion: ACTION_MANIFEST_SCHEMA_VERSION,
    id: "tickets.create",
    name: "tickets.create",
    title: "Create ticket",
    description: "Create a support ticket through a deterministic action binding.",
    version: "1.0.0",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
      },
    },
    outputSchema: {
      type: "object",
      required: ["ticketId"],
      properties: {
        ticketId: { type: "string" },
      },
    },
    bindings: [
      {
        kind: "cli",
        command: "tickets",
        args: ["create", "--json"],
        timeoutMs: 30000,
      },
    ],
    idempotency: {
      required: true,
      scope: "tenant",
      keyTemplate: "{action.id}:{input.title}",
      conflictPolicy: "return-existing",
    },
    dryRun: {
      supported: true,
      defaultMode: "preview-and-policy",
    },
    approval: {
      mode: "preview",
      requiresApproval: false,
    },
    policy: {
      risk: "medium",
    },
    retry: {
      strategy: "exponential",
      maxAttempts: 3,
      initialBackoffMs: 1000,
      multiplier: 2,
    },
    audit: {
      eventSource: "hasna.actions",
      includeInput: false,
      includeOutput: false,
      redactPaths: ["input.token", "output.secret"],
    },
  };
}

function validateBinding(errors: ActionManifestValidationError[], binding: unknown, index: number): void {
  const path = `$.bindings[${index}]`;
  if (!isRecord(binding)) {
    errors.push({ path, code: "binding.type", message: "binding must be an object" });
    return;
  }
  if (!isActionBindingKind(binding.kind)) {
    errors.push({ path: `${path}.kind`, code: "binding.kind", message: `kind must be one of ${ACTION_BINDING_KINDS.join(", ")}` });
  }
  if (binding.kind === "cli" && typeof binding.command !== "string") {
    errors.push({ path: `${path}.command`, code: "binding.cli.command", message: "cli bindings require command" });
  }
  if (binding.kind === "http" && typeof binding.url !== "string") {
    errors.push({ path: `${path}.url`, code: "binding.http.url", message: "http bindings require url" });
  }
  if (binding.kind === "mcp" && typeof binding.toolName !== "string") {
    errors.push({ path: `${path}.toolName`, code: "binding.mcp.tool", message: "mcp bindings require toolName" });
  }
  if (binding.kind === "sdk") {
    if (typeof binding.package !== "string") {
      errors.push({ path: `${path}.package`, code: "binding.sdk.package", message: "sdk bindings require package" });
    }
    if (typeof binding.export !== "string") {
      errors.push({ path: `${path}.export`, code: "binding.sdk.export", message: "sdk bindings require export" });
    }
  }
  if (binding.kind === "workflow" && typeof binding.workflowRef !== "string") {
    errors.push({ path: `${path}.workflowRef`, code: "binding.workflow.ref", message: "workflow bindings require workflowRef" });
  }
  if (binding.kind === "agent" && typeof binding.name !== "string" && typeof binding.toolName !== "string" && typeof binding.command !== "string") {
    errors.push({ path: `${path}.name`, code: "binding.agent.target", message: "agent bindings require name, toolName, or command" });
  }
}

function validateIdempotency(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.idempotency", code: "idempotency.type", message: "idempotency must be an object" });
    return;
  }
  if (typeof value.required !== "boolean") {
    errors.push({ path: "$.idempotency.required", code: "idempotency.required", message: "required must be a boolean" });
  }
  if (!["global", "tenant", "actor", "automation", "action"].includes(String(value.scope))) {
    errors.push({ path: "$.idempotency.scope", code: "idempotency.scope", message: "scope must be global, tenant, actor, automation, or action" });
  }
}

function validateApproval(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.approval", code: "approval.type", message: "approval must be an object" });
    return;
  }
  if (!["never", "preview", "manual", "step-up"].includes(String(value.mode))) {
    errors.push({ path: "$.approval.mode", code: "approval.mode", message: "mode must be never, preview, manual, or step-up" });
  }
  if (typeof value.requiresApproval !== "boolean") {
    errors.push({ path: "$.approval.requiresApproval", code: "approval.requires_approval", message: "requiresApproval must be a boolean" });
  }
}

function validatePolicy(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.policy", code: "policy.type", message: "policy must be an object" });
    return;
  }
  if (!["low", "medium", "high", "critical"].includes(String(value.risk))) {
    errors.push({ path: "$.policy.risk", code: "policy.risk", message: "risk must be low, medium, high, or critical" });
  }
}

function validateSecrets(errors: ActionManifestValidationError[], value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "$.secrets", code: "secrets.type", message: "secrets must be an array" });
    return;
  }
  value.forEach((secret, index) => {
    const path = `$.secrets[${index}]`;
    if (!isRecord(secret)) {
      errors.push({ path, code: "secret.type", message: "secret must be an object" });
      return;
    }
    requireString(errors, secret, "name", path);
    requireString(errors, secret, "ref", path);
    if (Object.hasOwn(secret, "value")) {
      errors.push({ path: `${path}.value`, code: "secret.raw_value", message: "raw secret values are not allowed in action manifests" });
    }
  });
}

function validateRetry(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.retry", code: "retry.type", message: "retry must be an object" });
    return;
  }
  if (!["none", "fixed", "exponential"].includes(String(value.strategy))) {
    errors.push({ path: "$.retry.strategy", code: "retry.strategy", message: "strategy must be none, fixed, or exponential" });
  }
  if (typeof value.maxAttempts !== "number" || value.maxAttempts < 1) {
    errors.push({ path: "$.retry.maxAttempts", code: "retry.max_attempts", message: "maxAttempts must be a positive number" });
  }
}

function requireString(errors: ActionManifestValidationError[], record: Record<string, unknown>, key: string, parentPath = "$"): void {
  if (typeof record[key] !== "string" || record[key].trim() === "") {
    errors.push({ path: `${parentPath}.${key}`, code: `${key}.required`, message: `${key} is required` });
  }
}

function isActionBindingKind(value: unknown): value is ActionBindingKind {
  return typeof value === "string" && (ACTION_BINDING_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIsoTime(value?: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readPath(value: JsonValue, path: string): JsonValue | undefined {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as JsonValue | undefined;
}

function stringifyTemplateValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return stableStringify(value);
}

function pruneUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
