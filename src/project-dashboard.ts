import type { ActionManifest, ApprovalRequirement, JsonObject, RiskLevel } from "./types.js";

export const PROJECT_ACTION_CAPABILITY_SCHEMA = "hasna.project_action_capability.v1" as const;

export type ProjectActionDefaultMode = "read-only" | "dry-run";
export type ProjectActionExecutionPolicy = "server-issued-run" | "unavailable";

export interface ProjectActionCapability {
  schema: typeof PROJECT_ACTION_CAPABILITY_SCHEMA;
  id: string;
  version: string;
  label: string;
  description: string;
  riskLevel: RiskLevel;
  resource: {
    type: string;
    identifiers: string[];
    description?: string;
  };
  scope: {
    level: ActionManifest["scope"]["level"];
    permissions: string[];
    boundaries: string[];
  };
  presentation: {
    defaultMode: ProjectActionDefaultMode;
    executionPolicy: ProjectActionExecutionPolicy;
    confirmationTitle: string;
    dryRunSupported: boolean;
    dryRunDefault: boolean;
    approvalRequired: boolean;
    idempotencyRequired: boolean;
    rollbackStrategy: ActionManifest["rollback"]["strategy"];
  };
  preflight: {
    supported: boolean;
    summary: string;
    warnings: string[];
  };
  audit: {
    eventTypes: string[];
    evidenceRequired: boolean;
    evidenceFields: string[];
    redactedFields: string[];
  };
  safety: {
    guardrailHook?: string;
    failClosed: boolean;
    blockers: string[];
  };
  links: {
    manifestRef: string;
    actionRef: string;
  };
  metadata: JsonObject;
}

export interface ProjectActionCapabilityOptions {
  projectId?: string;
  manifestRef?: string;
  actionBasePath?: string;
}

export function projectActionCapability(
  manifest: ActionManifest,
  options: ProjectActionCapabilityOptions = {},
): ProjectActionCapability {
  const blockers = projectActionBoundaryBlockers(manifest);
  const approvalRequired = approvalCount(manifest.requiredApprovals) > 0;
  const actionRef = `${manifest.id}@${manifest.version}`;
  const actionBasePath = options.actionBasePath ?? "/api/actions";

  return {
    schema: PROJECT_ACTION_CAPABILITY_SCHEMA,
    id: manifest.id,
    version: manifest.version,
    label: manifest.name,
    description: manifest.description,
    riskLevel: manifest.riskLevel,
    resource: {
      type: manifest.resource.type,
      identifiers: manifest.resource.identifiers ?? [],
      description: manifest.resource.description,
    },
    scope: {
      level: manifest.scope.level,
      permissions: manifest.scope.permissions ?? [],
      boundaries: manifest.scope.boundaries ?? [],
    },
    presentation: {
      defaultMode: manifest.dryRun.default === true ? "dry-run" : "read-only",
      executionPolicy: blockers.length === 0 ? "server-issued-run" : "unavailable",
      confirmationTitle: manifest.confirmation.title,
      dryRunSupported: manifest.dryRun.supported,
      dryRunDefault: manifest.dryRun.default === true,
      approvalRequired,
      idempotencyRequired: manifest.idempotency.required === true,
      rollbackStrategy: manifest.rollback.strategy,
    },
    preflight: {
      supported: manifest.dryRun.supported,
      summary: manifest.dryRun.supported
        ? "Dashboard may request a server-side dry-run preview before any mutation."
        : "Dashboard can display this action, but execution is unavailable until a dry-run is added.",
      warnings: confirmationWarnings(manifest),
    },
    audit: {
      eventTypes: manifest.audit.eventTypes,
      evidenceRequired: manifest.evidence.required === true,
      evidenceFields: manifest.evidence.fields ?? [],
      redactedFields: manifest.audit.redactedFields ?? [],
    },
    safety: {
      guardrailHook: manifest.guardrail?.hook,
      failClosed: manifest.guardrail?.failClosed === true,
      blockers,
    },
    links: {
      manifestRef: options.manifestRef ?? `action-manifest://${actionRef}`,
      actionRef: `${actionBasePath}/${encodeURIComponent(manifest.id)}/runs?version=${encodeURIComponent(manifest.version)}`,
    },
    metadata: {
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(manifest.metadata ?? {}),
    },
  };
}

export function projectActionCapabilities(
  manifests: ActionManifest[],
  options: ProjectActionCapabilityOptions = {},
): ProjectActionCapability[] {
  return manifests.map((manifest) => projectActionCapability(manifest, options));
}

export function projectActionBoundaryBlockers(manifest: ActionManifest): string[] {
  const blockers: string[] = [];
  if (!manifest.dryRun.supported) blockers.push("dry-run preview is required before dashboard execution");
  if (manifest.dryRun.default !== true) blockers.push("dashboard actions must default to dry-run/read-only");
  if (!manifest.confirmation.title.trim()) blockers.push("confirmation title is required");
  if (!manifest.audit.eventTypes.includes("action.previewed")) blockers.push("preview audit event is required");
  if (manifest.riskLevel !== "low" && approvalCount(manifest.requiredApprovals) === 0) {
    blockers.push("medium/high/critical actions require explicit approval policy");
  }
  if (manifest.riskLevel === "critical" && manifest.guardrail?.failClosed !== true) {
    blockers.push("critical actions require a fail-closed guardrail");
  }
  return blockers;
}

function approvalCount(requirements: ApprovalRequirement[]): number {
  return requirements.reduce((total, requirement) => total + (requirement.kind === "none" ? 0 : requirement.count ?? 1), 0);
}

function confirmationWarnings(manifest: ActionManifest): string[] {
  const warnings = [...(manifest.confirmation.warnings ?? [])];
  if (manifest.riskLevel === "high" || manifest.riskLevel === "critical") {
    warnings.unshift(`${manifest.riskLevel} risk action requires explicit confirmation before execution.`);
  }
  if (!manifest.idempotency.supported) warnings.push("Action does not advertise idempotency support.");
  return warnings;
}
