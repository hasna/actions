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
  ACTION_APPROVAL_HOOK_STAGES,
  ACTION_AUDIT_EVENT_FIELDS,
  ACTION_BINDING_KINDS,
  ACTION_DRY_RUN_CAPABILITIES,
  ACTION_EXECUTION_MODES,
  ACTION_GRANT_KINDS,
  ACTION_MANIFEST_SCHEMA_VERSION,
  ACTION_RUN_STATUSES,
  ACTION_SIDE_EFFECT_CLASSES,
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

  if (input.provider === undefined) {
    errors.push({ path: "$.provider", code: "provider.required", message: "provider is required" });
  } else {
    validateProvider(errors, input.provider);
  }

  if (input.sideEffects === undefined) {
    errors.push({ path: "$.sideEffects", code: "side_effects.required", message: "sideEffects is required" });
  } else {
    validateSideEffects(errors, input.sideEffects);
  }

  if (input.requiredGrants === undefined) {
    errors.push({ path: "$.requiredGrants", code: "required_grants.required", message: "requiredGrants is required" });
  } else {
    validateRequiredGrants(errors, input.requiredGrants);
  }

  if (!Array.isArray(input.bindings) || input.bindings.length === 0) {
    errors.push({ path: "$.bindings", code: "bindings.required", message: "at least one binding is required" });
  } else {
    input.bindings.forEach((binding, index) => validateBinding(errors, binding, index));
  }

  if (input.idempotency !== undefined) {
    validateIdempotency(errors, input.idempotency);
  }

  if (input.dryRun === undefined) {
    errors.push({ path: "$.dryRun", code: "dry_run.required", message: "dryRun is required" });
  } else {
    validateDryRun(errors, input.dryRun);
  }

  if (input.approval === undefined) {
    errors.push({ path: "$.approval", code: "approval.required", message: "approval is required" });
  } else {
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
  if (input.audit === undefined) {
    errors.push({ path: "$.audit", code: "audit.required", message: "audit is required" });
  } else {
    validateAudit(errors, input.audit);
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
    provider: {
      id: "hasna.support",
      name: "Hasna Support",
      version: "1.0.0",
    },
    sideEffects: {
      classification: "write",
      resources: ["support.ticket"],
      externalSystems: ["tickets"],
      reversible: true,
      description: "Creates one support ticket in the configured ticketing system.",
    },
    requiredGrants: [
      {
        kind: "service",
        resource: "tickets",
        operations: ["create"],
        scope: "tenant",
        reason: "Create support tickets on behalf of an approved automation.",
      },
    ],
    bindings: [
      {
        id: "tickets-cli",
        kind: "cli",
        command: "tickets",
        args: ["create", "--json"],
        timeoutMs: 30000,
        execution: {
          mode: "sync",
          runner: "bun",
          entrypoint: "tickets create --json",
          timeoutMs: 30000,
          requiresNetwork: true,
          sandboxProfile: "workspace",
        },
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
      capability: "effect-preview-and-policy",
      defaultMode: "preview-and-policy",
    },
    approval: {
      mode: "preview",
      requiresApproval: false,
      policyRefs: ["policy://tickets/create"],
      hooks: [
        {
          id: "tickets-create-policy",
          stage: "before-preview",
          ref: "policy://tickets/create",
          failClosed: true,
        },
      ],
    },
    policy: {
      risk: "medium",
      hooks: [
        {
          id: "tickets-preflight",
          kind: "preflight",
          ref: "policy://tickets/create/preflight",
          failClosed: true,
        },
      ],
    },
    retry: {
      strategy: "exponential",
      maxAttempts: 3,
      initialBackoffMs: 1000,
      multiplier: 2,
    },
    audit: {
      eventSource: "hasna.actions",
      requiredFields: ["id", "source", "type", "actionId", "time", "data"],
      events: [
        {
          type: "action.invocation.created",
          dataSchema: {
            type: "object",
            required: ["actionId", "manifestVersion"],
            properties: {
              actionId: { type: "string" },
              manifestVersion: { type: "string" },
            },
          },
        },
        {
          type: "action.completed",
          dataSchema: {
            type: "object",
            required: ["status"],
            properties: {
              status: { type: "string" },
            },
          },
        },
      ],
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
  if (binding.id !== undefined && (typeof binding.id !== "string" || binding.id.trim() === "")) {
    errors.push({ path: `${path}.id`, code: "binding.id", message: "id must be a non-empty string when provided" });
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
  if (binding.timeoutMs !== undefined && !isPositiveNumber(binding.timeoutMs)) {
    errors.push({ path: `${path}.timeoutMs`, code: "binding.timeout_ms", message: "timeoutMs must be a positive number when provided" });
  }
  if (binding.execution !== undefined) {
    validateExecutionBinding(errors, binding.execution, `${path}.execution`);
  }
}

function validateProvider(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.provider", code: "provider.type", message: "provider must be an object" });
    return;
  }
  requireString(errors, value, "id", "$.provider");
  requireString(errors, value, "name", "$.provider");
  validateOptionalString(errors, value, "version", "$.provider");
  validateOptionalString(errors, value, "url", "$.provider");
  validateOptionalString(errors, value, "supportUrl", "$.provider");
}

function validateSideEffects(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.sideEffects", code: "side_effects.type", message: "sideEffects must be an object" });
    return;
  }
  if (!(ACTION_SIDE_EFFECT_CLASSES as readonly string[]).includes(String(value.classification))) {
    errors.push({ path: "$.sideEffects.classification", code: "side_effects.classification", message: `classification must be one of ${ACTION_SIDE_EFFECT_CLASSES.join(", ")}` });
  }
  validateOptionalStringArray(errors, value, "resources", "$.sideEffects");
  validateOptionalStringArray(errors, value, "externalSystems", "$.sideEffects");
  if (value.reversible !== undefined && typeof value.reversible !== "boolean") {
    errors.push({ path: "$.sideEffects.reversible", code: "side_effects.reversible", message: "reversible must be a boolean when provided" });
  }
  validateOptionalString(errors, value, "description", "$.sideEffects");
}

function validateRequiredGrants(errors: ActionManifestValidationError[], value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "$.requiredGrants", code: "required_grants.type", message: "requiredGrants must be an array" });
    return;
  }
  value.forEach((grant, index) => {
    const path = `$.requiredGrants[${index}]`;
    if (!isRecord(grant)) {
      errors.push({ path, code: "required_grant.type", message: "required grant must be an object" });
      return;
    }
    if (!(ACTION_GRANT_KINDS as readonly string[]).includes(String(grant.kind))) {
      errors.push({ path: `${path}.kind`, code: "required_grant.kind", message: `kind must be one of ${ACTION_GRANT_KINDS.join(", ")}` });
    }
    requireString(errors, grant, "resource", path);
    validateOptionalStringArray(errors, grant, "operations", path);
    validateOptionalString(errors, grant, "scope", path);
    validateOptionalString(errors, grant, "reason", path);
  });
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
  validateOptionalStringArray(errors, value, "policyRefs", "$.approval");
  if (value.hooks !== undefined) {
    validateApprovalHooks(errors, value.hooks);
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
  if (value.hooks !== undefined) {
    validatePolicyHooks(errors, value.hooks);
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

function validateDryRun(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.dryRun", code: "dry_run.type", message: "dryRun must be an object" });
    return;
  }
  if (typeof value.supported !== "boolean") {
    errors.push({ path: "$.dryRun.supported", code: "dry_run.supported", message: "supported must be a boolean" });
  }
  if (!(ACTION_DRY_RUN_CAPABILITIES as readonly string[]).includes(String(value.capability))) {
    errors.push({ path: "$.dryRun.capability", code: "dry_run.capability", message: `capability must be one of ${ACTION_DRY_RUN_CAPABILITIES.join(", ")}` });
  }
  if (value.supported === false && value.capability !== "none") {
    errors.push({ path: "$.dryRun.capability", code: "dry_run.capability_conflict", message: "unsupported dry runs must use capability none" });
  }
  if (value.supported === true && value.capability === "none") {
    errors.push({ path: "$.dryRun.capability", code: "dry_run.capability_conflict", message: "supported dry runs must declare a preview capability" });
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    errors.push({ path: "$.dryRun.required", code: "dry_run.required_flag", message: "required must be a boolean when provided" });
  }
  if (value.defaultMode !== undefined && !["preview-only", "preview-and-policy", "execute"].includes(String(value.defaultMode))) {
    errors.push({ path: "$.dryRun.defaultMode", code: "dry_run.default_mode", message: "defaultMode must be preview-only, preview-and-policy, or execute" });
  }
  if (value.outputSchema !== undefined && !isRecord(value.outputSchema)) {
    errors.push({ path: "$.dryRun.outputSchema", code: "dry_run.output_schema", message: "outputSchema must be an object when provided" });
  }
}

function validateApprovalHooks(errors: ActionManifestValidationError[], value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "$.approval.hooks", code: "approval_hooks.type", message: "approval hooks must be an array" });
    return;
  }
  value.forEach((hook, index) => {
    const path = `$.approval.hooks[${index}]`;
    if (!isRecord(hook)) {
      errors.push({ path, code: "approval_hook.type", message: "approval hook must be an object" });
      return;
    }
    requireString(errors, hook, "id", path);
    requireString(errors, hook, "ref", path);
    if (!(ACTION_APPROVAL_HOOK_STAGES as readonly string[]).includes(String(hook.stage))) {
      errors.push({ path: `${path}.stage`, code: "approval_hook.stage", message: `stage must be one of ${ACTION_APPROVAL_HOOK_STAGES.join(", ")}` });
    }
    if (hook.failClosed !== undefined && typeof hook.failClosed !== "boolean") {
      errors.push({ path: `${path}.failClosed`, code: "approval_hook.fail_closed", message: "failClosed must be a boolean when provided" });
    }
  });
}

function validatePolicyHooks(errors: ActionManifestValidationError[], value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push({ path: "$.policy.hooks", code: "policy_hooks.type", message: "policy hooks must be an array" });
    return;
  }
  value.forEach((hook, index) => {
    const path = `$.policy.hooks[${index}]`;
    if (!isRecord(hook)) {
      errors.push({ path, code: "policy_hook.type", message: "policy hook must be an object" });
      return;
    }
    requireString(errors, hook, "id", path);
    requireString(errors, hook, "ref", path);
    if (!["preflight", "pre-execute", "post-execute"].includes(String(hook.kind))) {
      errors.push({ path: `${path}.kind`, code: "policy_hook.kind", message: "kind must be preflight, pre-execute, or post-execute" });
    }
    if (hook.failClosed !== undefined && typeof hook.failClosed !== "boolean") {
      errors.push({ path: `${path}.failClosed`, code: "policy_hook.fail_closed", message: "failClosed must be a boolean when provided" });
    }
  });
}

function validateAudit(errors: ActionManifestValidationError[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push({ path: "$.audit", code: "audit.type", message: "audit must be an object" });
    return;
  }
  requireString(errors, value, "eventSource", "$.audit");
  validateAuditFields(errors, value.requiredFields, "$.audit.requiredFields");
  if (!Array.isArray(value.events) || value.events.length === 0) {
    errors.push({ path: "$.audit.events", code: "audit.events", message: "audit events must be a non-empty array" });
  } else {
    value.events.forEach((event, index) => {
      const path = `$.audit.events[${index}]`;
      if (!isRecord(event)) {
        errors.push({ path, code: "audit_event.type", message: "audit event shape must be an object" });
        return;
      }
      requireString(errors, event, "type", path);
      if (event.dataSchema !== undefined && !isRecord(event.dataSchema)) {
        errors.push({ path: `${path}.dataSchema`, code: "audit_event.data_schema", message: "dataSchema must be an object when provided" });
      }
      validateAuditFields(errors, event.requiredFields, `${path}.requiredFields`);
    });
  }
  if (value.includeInput !== undefined && typeof value.includeInput !== "boolean") {
    errors.push({ path: "$.audit.includeInput", code: "audit.include_input", message: "includeInput must be a boolean when provided" });
  }
  if (value.includeOutput !== undefined && typeof value.includeOutput !== "boolean") {
    errors.push({ path: "$.audit.includeOutput", code: "audit.include_output", message: "includeOutput must be a boolean when provided" });
  }
  validateOptionalStringArray(errors, value, "redactPaths", "$.audit");
  validateOptionalStringArray(errors, value, "evidenceRefs", "$.audit");
}

function validateExecutionBinding(errors: ActionManifestValidationError[], value: unknown, path: string): void {
  if (!isRecord(value)) {
    errors.push({ path, code: "binding.execution.type", message: "execution must be an object" });
    return;
  }
  if (!(ACTION_EXECUTION_MODES as readonly string[]).includes(String(value.mode))) {
    errors.push({ path: `${path}.mode`, code: "binding.execution.mode", message: `mode must be one of ${ACTION_EXECUTION_MODES.join(", ")}` });
  }
  validateOptionalString(errors, value, "runner", path);
  validateOptionalString(errors, value, "entrypoint", path);
  validateOptionalString(errors, value, "sandboxProfile", path);
  if (value.timeoutMs !== undefined && !isPositiveNumber(value.timeoutMs)) {
    errors.push({ path: `${path}.timeoutMs`, code: "binding.execution.timeout_ms", message: "timeoutMs must be a positive number when provided" });
  }
  if (value.requiresNetwork !== undefined && typeof value.requiresNetwork !== "boolean") {
    errors.push({ path: `${path}.requiresNetwork`, code: "binding.execution.requires_network", message: "requiresNetwork must be a boolean when provided" });
  }
}

function validateAuditFields(errors: ActionManifestValidationError[], value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path, code: "audit.fields", message: "audit fields must be an array when provided" });
    return;
  }
  value.forEach((field, index) => {
    if (!(ACTION_AUDIT_EVENT_FIELDS as readonly string[]).includes(String(field))) {
      errors.push({ path: `${path}[${index}]`, code: "audit.field", message: `field must be one of ${ACTION_AUDIT_EVENT_FIELDS.join(", ")}` });
    }
  });
}

function requireString(errors: ActionManifestValidationError[], record: Record<string, unknown>, key: string, parentPath = "$"): void {
  if (typeof record[key] !== "string" || record[key].trim() === "") {
    errors.push({ path: `${parentPath}.${key}`, code: `${key}.required`, message: `${key} is required` });
  }
}

function validateOptionalString(errors: ActionManifestValidationError[], record: Record<string, unknown>, key: string, parentPath: string): void {
  if (record[key] !== undefined && (typeof record[key] !== "string" || record[key].trim() === "")) {
    errors.push({ path: `${parentPath}.${key}`, code: `${key}.string`, message: `${key} must be a non-empty string when provided` });
  }
}

function validateOptionalStringArray(errors: ActionManifestValidationError[], record: Record<string, unknown>, key: string, parentPath: string): void {
  const value = record[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: `${parentPath}.${key}`, code: `${key}.array`, message: `${key} must be an array when provided` });
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push({ path: `${parentPath}.${key}[${index}]`, code: `${key}.string`, message: `${key} entries must be non-empty strings` });
    }
  });
}

function isActionBindingKind(value: unknown): value is ActionBindingKind {
  return typeof value === "string" && (ACTION_BINDING_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
