import { randomUUID } from "node:crypto";
import type {
  ActionAuditEvent,
  ActionAuditSink,
  ActionDefinition,
  ActionExecutionContext,
  ActionGuardrailHook,
  ActionManifest,
  ActionPlanStep,
  ActionPreview,
  ActionRequest,
  ActionRun,
  ApprovalDecision,
  ApprovalRequirement,
  GuardrailResult,
  JsonObject,
  RunActionOptions,
} from "./types.js";
import { JsonActionsStore, type ActionsStore } from "./storage.js";

export * from "./types.js";
export * from "./storage.js";
export * from "./executors/local-shell.js";
export * from "./executors/typescript.js";
export * from "./project-dashboard.js";

export interface ActionsClientOptions {
  store?: ActionsStore;
  dataDir?: string;
  guardrailHooks?: ActionGuardrailHook[];
  auditSinks?: ActionAuditSink[];
}

export function defineAction<TInput = unknown, TOutput = unknown>(
  definition: ActionDefinition<TInput, TOutput> | (Omit<ActionDefinition<TInput, TOutput>, "executor"> & ActionDefinition<TInput, TOutput>["executor"]),
): ActionDefinition<TInput, TOutput> {
  if ("executor" in definition) return definition;
  return {
    manifest: definition.manifest,
    input: definition.input,
    output: definition.output,
    executor: {
      plan: definition.plan,
      preview: definition.preview,
      execute: definition.execute,
      rollback: definition.rollback,
    },
  };
}

export class ActionsClient {
  private readonly store: ActionsStore;
  private readonly definitions = new Map<string, ActionDefinition>();
  private readonly guardrailHooks: ActionGuardrailHook[];
  private readonly auditSinks: ActionAuditSink[];

  constructor(options: ActionsClientOptions = {}) {
    this.store = options.store ?? new JsonActionsStore(options.dataDir);
    this.guardrailHooks = options.guardrailHooks ?? [];
    this.auditSinks = options.auditSinks ?? [];
  }

  async register<TInput, TOutput>(definition: ActionDefinition<TInput, TOutput>): Promise<ActionManifest> {
    assertManifest(definition.manifest);
    this.definitions.set(definition.manifest.id, definition as ActionDefinition);
    return this.store.saveManifest(definition.manifest);
  }

  async listManifests(): Promise<ActionManifest[]> {
    return this.store.listManifests();
  }

  async getManifest(actionId: string): Promise<ActionManifest | undefined> {
    return this.definitions.get(actionId)?.manifest ?? this.store.getManifest(actionId);
  }

  async plan(request: ActionRequest): Promise<ActionRun> {
    const definition = this.requireDefinition(request.actionId);
    const manifest = definition.manifest;
    assertIdempotency(manifest, request.idempotencyKey);
    if (request.idempotencyKey) {
      const existing = await this.store.findRunByIdempotencyKey(manifest.id, request.idempotencyKey);
      if (existing && !["failed", "denied", "cancelled"].includes(existing.status)) {
        return { ...existing, dedupedFromRunId: existing.id };
      }
    }

    const input = parseInput(definition, request.input);
    const now = nowIso();
    const run: ActionRun = {
      id: randomUUID(),
      actionId: manifest.id,
      actionVersion: manifest.version,
      status: "planned",
      actor: request.actor,
      input,
      plan: [],
      riskLevel: manifest.riskLevel,
      requiredApprovals: manifest.requiredApprovals,
      approvals: [],
      guardrailResults: [],
      evidence: request.evidence ?? [],
      idempotencyKey: request.idempotencyKey,
      dryRun: request.dryRun ?? manifest.dryRun.default ?? false,
      confirmationSummary: renderConfirmationSummary(manifest, input),
      rollback: manifest.rollback,
      events: [],
      metadata: request.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const context = contextFor(run, manifest, input);
    run.plan = definition.executor.plan ? await definition.executor.plan(context) : defaultPlan(manifest);
    await this.store.createRun(run);
    await this.emitAudit(run, manifest, "action.planned", "Action planned", { dryRun: run.dryRun });
    return run;
  }

  async preview(runId: string): Promise<ActionRun> {
    const run = await this.requireRun(runId);
    const definition = this.requireDefinition(run.actionId);
    const manifest = definition.manifest;
    const context = contextFor(run, manifest, run.input);
    const guardrail = await this.runGuardrails(context);
    if (guardrail.decision === "deny") {
      run.status = "denied";
      run.error = guardrail.reason ?? "Guardrail denied preview";
      run.guardrailResults.push(guardrail);
      run.updatedAt = nowIso();
      await this.store.updateRun(run);
      await this.emitAudit(run, manifest, "action.denied", run.error, { stage: "preview" }, "warning");
      return run;
    }
    run.guardrailResults.push(guardrail);
    run.preview = definition.executor.preview
      ? await definition.executor.preview(context)
      : defaultPreview(run);
    run.status = "previewed";
    run.updatedAt = nowIso();
    await this.store.updateRun(run);
    await this.emitAudit(run, manifest, "action.previewed", "Action previewed", { summary: run.preview.summary });
    return run;
  }

  async approve(runId: string, decision: ApprovalDecision): Promise<ActionRun> {
    const run = await this.requireRun(runId);
    const manifest = await this.requireManifest(run.actionId);
    run.approvals.push({ ...decision, decision: "approved", createdAt: decision.createdAt ?? nowIso() });
    run.status = hasRequiredApprovals(run) ? "approved" : "awaiting_approval";
    run.updatedAt = nowIso();
    await this.store.updateRun(run);
    await this.emitAudit(run, manifest, "action.approved", decision.reason ?? "Action approved", { approvals: run.approvals.length });
    return run;
  }

  async deny(runId: string, decision: ApprovalDecision): Promise<ActionRun> {
    const run = await this.requireRun(runId);
    const manifest = await this.requireManifest(run.actionId);
    run.approvals.push({ ...decision, decision: "denied", createdAt: decision.createdAt ?? nowIso() });
    run.status = "denied";
    run.error = decision.reason ?? "Action denied";
    run.updatedAt = nowIso();
    await this.store.updateRun(run);
    await this.emitAudit(run, manifest, "action.denied", run.error, { approvals: run.approvals.length }, "warning");
    return run;
  }

  async execute(runId: string, options: RunActionOptions = {}): Promise<ActionRun> {
    const run = await this.requireRun(runId);
    const definition = this.requireDefinition(run.actionId);
    const manifest = definition.manifest;

    if (run.status === "denied") return run;
    if (run.dryRun) return this.preview(run.id);
    if (!hasRequiredApprovals(run)) {
      run.status = "awaiting_approval";
      run.updatedAt = nowIso();
      await this.store.updateRun(run);
      await this.emitAudit(run, manifest, "action.awaiting_approval", "Action requires approval before execution", {});
      return run;
    }

    const context = contextFor(run, manifest, run.input);
    const guardrail = await this.runGuardrails(context);
    run.guardrailResults.push(guardrail);
    if (guardrail.decision === "deny") {
      run.status = "denied";
      run.error = guardrail.reason ?? "Guardrail denied execution";
      run.updatedAt = nowIso();
      await this.store.updateRun(run);
      await this.emitAudit(run, manifest, "action.denied", run.error, { stage: "execute" }, "warning");
      return run;
    }

    run.status = "executing";
    run.executedAt = nowIso();
    run.updatedAt = run.executedAt;
    await this.store.updateRun(run);
    await this.emitAudit(run, manifest, "action.executing", "Action execution started", {});

    try {
      const output = await definition.executor.execute(context);
      run.output = parseOutput(definition, output);
      run.status = "succeeded";
      run.completedAt = nowIso();
      run.updatedAt = run.completedAt;
      await this.store.updateRun(run);
      await this.emitAudit(run, manifest, "action.executed", "Action executed", {
        includeOutput: manifest.audit.includeOutput === true,
      });
      return run;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = nowIso();
      run.updatedAt = run.completedAt;
      await this.store.updateRun(run);
      await this.emitAudit(run, manifest, "action.failed", run.error, {}, "error");
      if (options.rollbackOnFailure && definition.executor.rollback) {
        run.preview = await definition.executor.rollback({ ...context, error });
        run.status = "rolled_back";
        run.updatedAt = nowIso();
        await this.store.updateRun(run);
        await this.emitAudit(run, manifest, "action.rolled_back", "Rollback or compensating action recorded", {});
      }
      return run;
    }
  }

  async run(request: ActionRequest, options: RunActionOptions = {}): Promise<ActionRun> {
    let run = await this.plan(request);
    run = await this.preview(run.id);
    if (request.dryRun === true || run.dryRun) return run;
    if (options.autoApprove) run = await this.approve(run.id, options.autoApprove);
    return this.execute(run.id, options);
  }

  async getRun(id: string): Promise<ActionRun | undefined> {
    return this.store.getRun(id);
  }

  async listRuns(options: { actionId?: string; status?: string; limit?: number } = {}): Promise<ActionRun[]> {
    return this.store.listRuns(options);
  }

  async listAuditEvents(options: { runId?: string; actionId?: string; limit?: number } = {}): Promise<ActionAuditEvent[]> {
    return this.store.listAuditEvents(options);
  }

  private requireDefinition(actionId: string): ActionDefinition {
    const definition = this.definitions.get(actionId);
    if (!definition) throw new Error(`Action is not registered in this process: ${actionId}`);
    return definition;
  }

  private async requireManifest(actionId: string): Promise<ActionManifest> {
    const manifest = await this.getManifest(actionId);
    if (!manifest) throw new Error(`Action manifest not found: ${actionId}`);
    return manifest;
  }

  private async requireRun(runId: string): Promise<ActionRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Action run not found: ${runId}`);
    return run;
  }

  private async runGuardrails(context: ActionExecutionContext): Promise<GuardrailResult> {
    if (context.manifest.guardrail?.failClosed && this.guardrailHooks.length === 0) {
      return {
        decision: "deny",
        reason: `Guardrail ${context.manifest.guardrail.hook} is fail-closed but no guardrail hook is configured`,
      };
    }
    let combined: GuardrailResult = { decision: "allow" };
    for (const hook of this.guardrailHooks) {
      const result = await hook(context);
      if (result.decision === "deny") return result;
      if (result.decision === "warn") {
        combined = {
          decision: combined.decision === "deny" ? "deny" : "warn",
          warnings: [...(combined.warnings ?? []), ...(result.warnings ?? [])],
          reason: result.reason ?? combined.reason,
          metadata: { ...(combined.metadata ?? {}), ...(result.metadata ?? {}) },
        };
      }
    }
    return combined;
  }

  private async emitAudit(
    run: ActionRun,
    manifest: ActionManifest,
    type: string,
    message: string,
    data: JsonObject,
    severity: ActionAuditEvent["severity"] = "info",
  ): Promise<ActionAuditEvent> {
    const event: ActionAuditEvent = {
      id: randomUUID(),
      runId: run.id,
      actionId: manifest.id,
      type,
      time: nowIso(),
      actor: run.actor,
      severity,
      message,
      data,
      metadata: {
        actionVersion: manifest.version,
        riskLevel: manifest.riskLevel,
      },
    };
    await this.store.appendAuditEvent(event);
    run.events = [...run.events, event];
    run.updatedAt = event.time;
    await this.store.updateRun(run);
    for (const sink of this.auditSinks) await sink(event);
    return event;
  }
}

function parseInput<TInput, TOutput>(definition: ActionDefinition<TInput, TOutput>, input: unknown): TInput {
  return definition.input ? definition.input.parse(input) : (input as TInput);
}

function parseOutput<TInput, TOutput>(definition: ActionDefinition<TInput, TOutput>, output: unknown): TOutput {
  return definition.output ? definition.output.parse(output) : (output as TOutput);
}

function contextFor<TInput>(run: ActionRun<TInput>, manifest: ActionManifest, input: TInput): ActionExecutionContext<TInput> {
  return {
    run,
    manifest,
    input,
    actor: run.actor,
    idempotencyKey: run.idempotencyKey,
    dryRun: run.dryRun,
  };
}

function assertIdempotency(manifest: ActionManifest, key: string | undefined): void {
  if (manifest.idempotency.required && !key) {
    throw new Error(`Action ${manifest.id} requires an idempotency key`);
  }
}

export function assertManifest(manifest: ActionManifest): void {
  const missing = [
    ["id", manifest.id],
    ["name", manifest.name],
    ["version", manifest.version],
    ["description", manifest.description],
  ].filter(([, value]) => typeof value !== "string" || value.length === 0);
  if (missing.length > 0) throw new Error(`Invalid action manifest; missing ${missing.map(([key]) => key).join(", ")}`);
  if (!manifest.inputSchema || !manifest.outputSchema) throw new Error(`Action ${manifest.id} must define inputSchema and outputSchema`);
  if (!Array.isArray(manifest.executorBindings) || manifest.executorBindings.length === 0) {
    throw new Error(`Action ${manifest.id} must define at least one executor binding`);
  }
}

export function requiredApprovalCount(requirements: ApprovalRequirement[]): number {
  return requirements.reduce((total, requirement) => {
    if (requirement.kind === "none") return total;
    return total + Math.max(1, requirement.count ?? 1);
  }, 0);
}

export function hasRequiredApprovals(run: Pick<ActionRun, "requiredApprovals" | "approvals">): boolean {
  const denied = run.approvals.some((approval) => approval.decision === "denied");
  if (denied) return false;
  return run.requiredApprovals.every((requirement) => approvalRequirementSatisfied(requirement, run.approvals));
}

function approvalRequirementSatisfied(requirement: ApprovalRequirement, approvals: ApprovalDecision[]): boolean {
  if (requirement.kind === "none") return true;
  const approved = approvals.filter((approval) => {
    if (approval.decision !== "approved") return false;
    if (!requirement.roles || requirement.roles.length === 0) return true;
    const actorRoles = approval.actor.roles ?? [];
    return requirement.roles.some((role) => actorRoles.includes(role));
  });
  return approved.length >= Math.max(1, requirement.count ?? 1);
}

function defaultPlan(manifest: ActionManifest): ActionPlanStep[] {
  const steps: ActionPlanStep[] = [
    { id: "validate-input", kind: "input", title: "Validate action input", status: "planned" },
  ];
  if (manifest.guardrail) steps.push({ id: "guardrail", kind: "guardrail", title: `Run guardrail ${manifest.guardrail.hook}`, status: "planned" });
  if (requiredApprovalCount(manifest.requiredApprovals) > 0) {
    steps.push({ id: "approval", kind: "approval", title: "Collect required approvals", status: "planned" });
  }
  steps.push({ id: "execute", kind: "execute", title: "Execute bound action", status: "planned" });
  steps.push({ id: "audit", kind: "audit", title: "Emit audit event", status: "planned" });
  if (manifest.rollback.strategy !== "none") steps.push({ id: "rollback", kind: "rollback", title: "Record rollback or compensating action", status: "planned" });
  return steps;
}

function defaultPreview(run: ActionRun): ActionPreview {
  return {
    summary: run.confirmationSummary,
    steps: run.plan,
    warnings: [],
  };
}

function renderConfirmationSummary(manifest: ActionManifest, input: unknown): string {
  const template = manifest.confirmation.summaryTemplate;
  if (!template) return manifest.confirmation.title;
  if (!input || typeof input !== "object") return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const value = getPath(input as Record<string, unknown>, key);
    return value === undefined ? "" : String(value);
  });
}

function getPath(input: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = input;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createEventAuditSink(emit: (event: ActionAuditEvent) => void | Promise<void>): ActionAuditSink {
  return emit;
}
