import type { ActionsStatus } from "./storage.js";
import type { ActionManifest, ActionRun, JsonValue } from "./types.js";

export const DEFAULT_LIST_LIMIT = 20;
export const MCP_DEFAULT_LIST_LIMIT = 10;
const MAX_LIMIT = 100;
const TRUNCATION_SUFFIX = "...";

export type DetailLevel = "compact" | "verbose" | "full";

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  cursor: number;
  nextCursor?: string;
}

export function detailLevel(value: unknown): DetailLevel {
  if (value === "verbose" || value === "full") return value;
  return "compact";
}

export function parsePositiveIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

export function paginate<T>(
  items: T[],
  options: { limit?: number; cursor?: string | number; defaultLimit?: number } = {},
): Page<T> {
  const total = items.length;
  const limit = normalizeLimit(options.limit, options.defaultLimit ?? DEFAULT_LIST_LIMIT);
  const cursor = normalizeCursor(options.cursor);
  const pageItems = items.slice(cursor, cursor + limit);
  const nextOffset = cursor + pageItems.length;
  return {
    items: pageItems,
    total,
    limit,
    cursor,
    nextCursor: nextOffset < total ? String(nextOffset) : undefined,
  };
}

export function truncateText(value: unknown, maxLength = 96): string {
  const raw = stringifyInline(value);
  if (raw.length <= maxLength) return raw;
  if (maxLength <= TRUNCATION_SUFFIX.length) return raw.slice(0, maxLength);
  return `${raw.slice(0, maxLength - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

export function formatStatus(status: ActionsStatus, options: { verbose?: boolean } = {}): string {
  const lines = [
    `actions manifests=${status.counts.manifests} runs=${status.counts.runs} auditEvents=${status.counts.auditEvents}`,
    `dataDir: ${status.dataDir}`,
  ];
  if (options.verbose) {
    lines.push("files:");
    lines.push(`  manifests ${status.files.manifests.exists ? "exists" : "missing"} records=${status.files.manifests.records} path=${status.files.manifests.path}`);
    lines.push(`  runs ${status.files.runs.exists ? "exists" : "missing"} records=${status.files.runs.records} path=${status.files.runs.path}`);
    lines.push(`  auditEvents ${status.files.auditEvents.exists ? "exists" : "missing"} records=${status.files.auditEvents.records} path=${status.files.auditEvents.path}`);
  }
  return lines.join("\n");
}

export function compactManifest(manifest: ActionManifest, options: { verbose?: boolean } = {}): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    riskLevel: manifest.riskLevel,
    scope: manifest.scope.level,
    approvals: approvalRequirementSummary(manifest.requiredApprovals),
    executors: manifest.executorBindings.map((binding) => binding.kind),
    description: truncateText(manifest.description, 120),
  };
  if (options.verbose) {
    summary.actorTypes = manifest.actor.types;
    summary.resource = manifest.resource.type;
    summary.idempotency = manifest.idempotency.required ? "required" : manifest.idempotency.supported ? "supported" : "none";
    summary.dryRunDefault = manifest.dryRun.default === true;
    summary.rollback = manifest.rollback.strategy;
    summary.guardrail = manifest.guardrail?.hook ?? "none";
  }
  return summary;
}

export function compactRun(run: ActionRun, options: { verbose?: boolean } = {}): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: run.id,
    status: run.status,
    actionId: run.actionId,
    riskLevel: run.riskLevel,
    dryRun: run.dryRun,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    summary: truncateText(run.confirmationSummary || run.preview?.summary || run.error || "", 120),
    approvals: `${run.approvals.length}/${requiredApprovalCount(run.requiredApprovals)}`,
    events: run.events.length,
    hasInput: run.input !== undefined,
    hasOutput: run.output !== undefined,
    hasError: Boolean(run.error),
  };
  if (options.verbose) {
    summary.actor = run.actor ? `${run.actor.type}:${run.actor.id}` : "";
    summary.preview = run.preview ? truncateText(run.preview.summary, 180) : "";
    summary.input = truncateText(run.input, 180);
    summary.output = run.output === undefined ? "" : truncateText(run.output, 180);
    summary.error = run.error ? truncateText(run.error, 180) : "";
    summary.latestEvent = run.events[run.events.length - 1]?.type ?? "";
  }
  return summary;
}

export function formatManifestList(page: Page<ActionManifest>, options: { verbose?: boolean } = {}): string {
  if (page.total === 0) return "no manifests";
  const rows = page.items.map((manifest) => ({
    id: manifest.id,
    version: manifest.version,
    risk: manifest.riskLevel,
    scope: manifest.scope.level,
    approvals: approvalRequirementSummary(manifest.requiredApprovals),
    executors: manifest.executorBindings.map((binding) => binding.kind).join(","),
    description: truncateText(manifest.description, options.verbose ? 100 : 64),
  }));
  const table = formatTable(rows, [
    { header: "ID", key: "id", maxWidth: 48 },
    { header: "VERSION", key: "version", maxWidth: 12 },
    { header: "RISK", key: "risk", maxWidth: 8 },
    { header: "SCOPE", key: "scope", maxWidth: 12 },
    { header: "APPROVALS", key: "approvals", maxWidth: 12 },
    { header: "EXECUTORS", key: "executors", maxWidth: 18 },
    { header: "DESCRIPTION", key: "description", maxWidth: options.verbose ? 100 : 64 },
  ]);
  return withListFooter(table, page, "manifests", "actions manifests list", "use actions manifests show <id> for details, --verbose for more columns, or --json for full records");
}

export function formatManifestDetail(manifest: ActionManifest, options: { verbose?: boolean } = {}): string {
  const lines = [
    `manifest ${manifest.id}@${manifest.version}`,
    `name: ${manifest.name}`,
    `risk: ${manifest.riskLevel}`,
    `scope: ${manifest.scope.level}${manifest.scope.permissions?.length ? ` permissions=${manifest.scope.permissions.join(",")}` : ""}`,
    `resource: ${manifest.resource.type}`,
    `approvals: ${approvalRequirementSummary(manifest.requiredApprovals)}`,
    `executors: ${manifest.executorBindings.map((binding) => binding.kind).join(",")}`,
    `description: ${truncateText(manifest.description, 160)}`,
  ];
  if (options.verbose) {
    lines.push(`actorTypes: ${manifest.actor.types.join(",")}`);
    lines.push(`idempotency: ${manifest.idempotency.required ? "required" : manifest.idempotency.supported ? "supported" : "none"}`);
    lines.push(`dryRunDefault: ${manifest.dryRun.default === true}`);
    lines.push(`guardrail: ${manifest.guardrail?.hook ?? "none"}`);
    lines.push(`rollback: ${manifest.rollback.strategy}`);
    lines.push(`inputSchema: ${truncateText(manifest.inputSchema, 240)}`);
    lines.push(`outputSchema: ${truncateText(manifest.outputSchema, 240)}`);
  } else {
    lines.push("hint: use --verbose for schemas/bindings or --json for the full manifest");
  }
  return lines.join("\n");
}

export function formatRunList(page: Page<ActionRun>, options: { verbose?: boolean } = {}): string {
  if (page.total === 0) return "no runs";
  const rows = page.items.map((run) => ({
    id: run.id,
    status: run.status,
    action: run.actionId,
    risk: run.riskLevel,
    created: run.createdAt,
    approvals: `${run.approvals.length}/${requiredApprovalCount(run.requiredApprovals)}`,
    events: String(run.events.length),
    summary: truncateText(run.confirmationSummary || run.preview?.summary || run.error || "", options.verbose ? 100 : 64),
  }));
  const columns = options.verbose
    ? [
      { header: "ID", key: "id", maxWidth: 36 },
      { header: "STATUS", key: "status", maxWidth: 18 },
      { header: "ACTION", key: "action", maxWidth: 42 },
      { header: "RISK", key: "risk", maxWidth: 8 },
      { header: "APPROVALS", key: "approvals", maxWidth: 10 },
      { header: "EVENTS", key: "events", maxWidth: 6 },
      { header: "SUMMARY", key: "summary", maxWidth: 100 },
    ]
    : [
      { header: "ID", key: "id", maxWidth: 36 },
      { header: "STATUS", key: "status", maxWidth: 18 },
      { header: "ACTION", key: "action", maxWidth: 42 },
      { header: "RISK", key: "risk", maxWidth: 8 },
      { header: "SUMMARY", key: "summary", maxWidth: 64 },
    ];
  const table = formatTable(rows, columns);
  return withListFooter(table, page, "runs", "actions runs list", "use actions runs show <id> for details, --verbose for expanded summaries, or --json for full records");
}

export function formatRunDetail(run: ActionRun, options: { verbose?: boolean } = {}): string {
  const lines = [
    `run ${run.id}`,
    `status: ${run.status}`,
    `action: ${run.actionId}@${run.actionVersion}`,
    `risk: ${run.riskLevel} dryRun=${run.dryRun} approvals=${run.approvals.length}/${requiredApprovalCount(run.requiredApprovals)} events=${run.events.length}`,
    `created: ${run.createdAt}`,
    `updated: ${run.updatedAt}`,
    `summary: ${truncateText(run.confirmationSummary, 180)}`,
  ];
  if (run.preview?.summary) lines.push(`preview: ${truncateText(run.preview.summary, 180)}`);
  if (run.error) lines.push(`error: ${truncateText(run.error, 180)}`);

  if (options.verbose) {
    lines.push(`input: ${truncateText(run.input, 180)}`);
    if (run.output !== undefined) lines.push(`output: ${truncateText(run.output, 180)}`);
    if (run.plan.length > 0) {
      lines.push("plan:");
      for (const step of run.plan.slice(0, 10)) {
        lines.push(`  ${step.id} ${step.status} ${truncateText(step.title, 120)}`);
      }
      if (run.plan.length > 10) lines.push(`  ... ${run.plan.length - 10} more steps`);
    }
    if (run.events.length > 0) {
      lines.push("events:");
      for (const event of run.events.slice(-5)) {
        lines.push(`  ${event.time} ${event.type} ${truncateText(event.message ?? "", 120)}`);
      }
      if (run.events.length > 5) lines.push(`  ... ${run.events.length - 5} earlier events`);
    }
  } else {
    lines.push("hint: use --verbose for input/output/events or --json for the full run");
  }
  return lines.join("\n");
}

export function mcpListResponse<T>(
  kind: "manifests" | "runs",
  page: Page<T>,
  items: unknown[],
  hint: string,
): Record<string, unknown> {
  return {
    items,
    page: {
      kind,
      count: page.items.length,
      total: page.total,
      limit: page.limit,
      cursor: page.cursor,
      nextCursor: page.nextCursor ?? null,
    },
    hint,
  };
}

function normalizeLimit(limit: number | undefined, defaultLimit: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return defaultLimit;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function normalizeCursor(cursor: string | number | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const parsed = typeof cursor === "number" ? cursor : Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function stringifyInline(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value as JsonValue).replace(/\s+/g, " ").trim();
  } catch {
    return String(value).replace(/\s+/g, " ").trim();
  }
}

function approvalRequirementSummary(requirements: ActionManifest["requiredApprovals"]): string {
  const count = requiredApprovalCount(requirements);
  if (count === 0) return "none";
  const roles = requirements.flatMap((requirement) => requirement.roles ?? []);
  return roles.length > 0 ? `${count} (${roles.join(",")})` : String(count);
}

function requiredApprovalCount(requirements: ActionManifest["requiredApprovals"]): number {
  return requirements.reduce((total, requirement) => {
    if (requirement.kind === "none") return total;
    return total + Math.max(1, requirement.count ?? 1);
  }, 0);
}

function formatTable(rows: Record<string, string>[], columns: { header: string; key: string; maxWidth: number }[]): string {
  const widths = columns.map((column) => {
    const valueWidth = rows.reduce((width, row) => Math.max(width, truncateText(row[column.key] ?? "", column.maxWidth).length), 0);
    return Math.min(column.maxWidth, Math.max(column.header.length, valueWidth));
  });
  const renderRow = (values: string[]) => values.map((value, index) => truncateText(value, widths[index]).padEnd(widths[index])).join("  ").trimEnd();
  return [
    renderRow(columns.map((column) => column.header)),
    renderRow(columns.map((_, index) => "-".repeat(widths[index]))),
    ...rows.map((row) => renderRow(columns.map((column) => row[column.key] ?? ""))),
  ].join("\n");
}

function withListFooter(table: string, page: Page<unknown>, noun: string, command: string, hint: string): string {
  const lines = [table, `showing ${page.items.length} of ${page.total} ${noun}`];
  if (page.nextCursor) lines.push(`next: ${command} --cursor ${page.nextCursor} --limit ${page.limit}`);
  lines.push(`hint: ${hint}`);
  return lines.join("\n");
}
