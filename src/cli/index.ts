#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { ProjectPanelSchema, SCHEMA_IDS } from "@hasna/contracts/schemas";
import type { ActionManifest, ActionRun, ActorRef, JsonObject, RiskLevel } from "../types.js";
import { ActionsClient, assertManifest, createLocalShellAction } from "../index.js";
import { JsonActionsStore, getActionsStatus } from "../storage.js";
import {
  DEFAULT_LIST_LIMIT,
  formatManifestDetail,
  formatManifestList,
  formatRunDetail,
  formatRunList,
  formatStatus,
  paginate,
  parsePositiveIntOption,
  truncateText,
} from "../presentation.js";
import { ACTIONS_VERSION } from "../version.js";

export interface RunActionsCliOptions {
  programName?: string;
  argv?: string[];
}

function parseJsonObject(value: string): unknown {
  const parsed = JSON.parse(value);
  return parsed;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readManifest(path: string): ActionManifest {
  const manifest = readJsonFile(path) as ActionManifest;
  assertManifest(manifest);
  return manifest;
}

function inputFromOptions(options: { input?: string; inputFile?: string }): unknown {
  if (options.inputFile) return readJsonFile(options.inputFile);
  if (options.input) return parseJsonObject(options.input);
  return {};
}

function actorFromOption(actor: string | undefined): ActorRef {
  return { id: actor ?? "cli", type: "human" };
}

function output(json: boolean | undefined, value: unknown, human: () => string): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(human());
}

function clientFor(dir?: string): ActionsClient {
  return new ActionsClient({ store: new JsonActionsStore(dir) });
}

async function registerShellManifest(client: ActionsClient, manifest: ActionManifest): Promise<void> {
  await client.register(createLocalShellAction(manifest));
}

async function findManifest(client: ActionsClient, idOrPrefix: string): Promise<ActionManifest | undefined> {
  const exact = await client.getManifest(idOrPrefix);
  if (exact) return exact;
  const matches = (await client.listManifests()).filter((manifest) => manifest.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

async function findRun(client: ActionsClient, idOrPrefix: string) {
  const exact = await client.getRun(idOrPrefix);
  if (exact) return exact;
  const matches = (await client.listRuns()).filter((run) => run.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0] : undefined;
}

function jsonList<T>(items: T[], options: { limit?: number; cursor?: string }): T[] {
  if (options.limit === undefined && options.cursor === undefined) return items;
  return paginate(items, { limit: options.limit, cursor: options.cursor }).items;
}

function metadataProjectId(metadata: JsonObject | undefined): string | undefined {
  const value = metadata?.["projectId"] ?? metadata?.["project"] ?? metadata?.["project_id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function manifestMatchesProject(manifest: ActionManifest, project: string): boolean {
  const explicitProject = metadataProjectId(manifest.metadata);
  if (explicitProject) return explicitProject === project;
  return manifest.scope.level === "project" && (manifest.resource.identifiers ?? []).includes(project);
}

function runMatchesProject(run: ActionRun, project: string, projectActionIds: Set<string>): boolean {
  const explicitProject = metadataProjectId(run.metadata);
  if (explicitProject) return explicitProject === project;
  return projectActionIds.has(run.actionId);
}

function riskPriority(riskLevel: RiskLevel): "low" | "medium" | "high" | "critical" {
  return riskLevel;
}

async function buildProjectPanel(client: ActionsClient, project: string, limit: number) {
  const generatedAt = new Date().toISOString();
  const manifests = (await client.listManifests()).filter((manifest) => manifestMatchesProject(manifest, project));
  const projectActionIds = new Set(manifests.map((manifest) => manifest.id));
  const runs = (await client.listRuns()).filter((run) => runMatchesProject(run, project, projectActionIds));
  const actionItems = manifests.slice(0, limit).map((manifest) => ({
    id: `action:${manifest.id}`,
    title: manifest.name,
    summary: truncateText(manifest.description, 160),
    status: `${manifest.riskLevel}; ${manifest.dryRun.default === true ? "dry-run-default" : "dry-run-not-default"}`,
    priority: riskPriority(manifest.riskLevel),
    resourceRefs: [{
      kind: "action" as const,
      id: manifest.id,
      name: manifest.name,
      uri: `dashboard://actions/${encodeURIComponent(manifest.id)}?version=${encodeURIComponent(manifest.version)}`,
      tags: [manifest.riskLevel, manifest.dryRun.default === true ? "dry-run-default" : "dry-run-not-default"],
    }],
  }));
  const remaining = Math.max(0, limit - actionItems.length);
  const runItems = runs.slice(0, remaining).map((run) => ({
    id: `run:${run.id}`,
    title: `${run.status} ${run.actionId}`,
    summary: `Action run ${run.id} for ${run.actionId}@${run.actionVersion}`,
    status: run.status,
    priority: riskPriority(run.riskLevel),
    timestamp: run.updatedAt,
    resourceRefs: [
      { kind: "run" as const, id: run.id, name: run.id, uri: `dashboard://actions/runs/${encodeURIComponent(run.id)}`, tags: [run.status] },
      { kind: "action" as const, id: run.actionId, name: run.actionId, uri: `dashboard://actions/${encodeURIComponent(run.actionId)}?version=${encodeURIComponent(run.actionVersion)}`, tags: [run.riskLevel] },
    ],
  }));

  return ProjectPanelSchema.parse({
    schema: SCHEMA_IDS.projectPanel,
    id: `actions_panel_${project}`,
    createdAt: generatedAt,
    projectId: project,
    provider: {
      kind: "actions",
      id: "open-actions",
      name: "Actions",
      sourcePackage: "@hasna/actions",
    },
    kind: "actions",
    title: "Actions",
    summary: "Project-scoped action manifests and recent action runs.",
    state: manifests.length || runs.length ? "ready" : "empty",
    generatedAt,
    freshness: "fresh",
    metrics: [
      { id: "actions", label: "Actions", value: manifests.length, status: manifests.length ? "good" : "unknown" },
      { id: "recent_runs", label: "Recent Runs", value: runs.length, status: runs.length ? "good" : "unknown" },
    ],
    items: [...actionItems, ...runItems],
    actions: manifests.slice(0, limit).map((manifest) => ({
      kind: "action" as const,
      id: manifest.id,
      name: manifest.name,
      uri: `dashboard://actions/${encodeURIComponent(manifest.id)}?version=${encodeURIComponent(manifest.version)}`,
      tags: [manifest.riskLevel, manifest.dryRun.default === true ? "dry-run-default" : "dry-run-not-default"],
    })),
  });
}

export function createProgram(): Command {
  const program = new Command();
  program.name("actions").description("Typed, auditable action contracts for agentic software").version(ACTIONS_VERSION);
  program.option("--dir <path>", "Override local actions data directory");

  program
    .command("status")
    .description("Show local actions storage status")
    .option("--verbose", "Show storage file details", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (options: { verbose?: boolean; json?: boolean }) => {
      const status = await getActionsStatus(program.opts<{ dir?: string }>().dir);
      output(options.json, status, () => formatStatus(status, { verbose: options.verbose }));
    });

  program
    .command("project-panel")
    .description("Emit a bounded project dashboard panel for action manifests and runs")
    .requiredOption("--project <slug>", "Project slug")
    .option("--limit <n>", `Limit panel items (default ${DEFAULT_LIST_LIMIT})`, parsePositiveIntOption)
    .option("--contract", "Validate and emit the hasna.project_panel.v1 contract", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (options: { project: string; limit?: number; contract?: boolean; json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const panel = await buildProjectPanel(client, options.project, options.limit ?? DEFAULT_LIST_LIMIT);
      output(options.json, panel, () => `actions panel ${options.project}: ${panel.metrics[0]?.value ?? 0} actions, ${panel.metrics[1]?.value ?? 0} recent runs`);
    });

  const manifests = program.command("manifests").description("Manage action manifests");
  manifests
    .command("validate <file>")
    .description("Validate a manifest file")
    .option("--verbose", "Show a compact manifest detail view", false)
    .option("-j, --json", "Print JSON output", false)
    .action((file: string, options: { verbose?: boolean; json?: boolean }) => {
      const manifest = readManifest(file);
      output(options.json, { ok: true, manifest }, () => options.verbose ? formatManifestDetail(manifest, { verbose: true }) : `valid ${manifest.id}@${manifest.version}`);
    });
  manifests
    .command("list")
    .description("List stored manifests")
    .option("--limit <n>", `Limit human output rows (default ${DEFAULT_LIST_LIMIT})`, parsePositiveIntOption)
    .option("--cursor <offset>", "Start human output at an offset cursor")
    .option("--verbose", "Show more manifest columns", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (options: { limit?: number; cursor?: string; verbose?: boolean; json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const items = await client.listManifests();
      output(options.json, jsonList(items, options), () => formatManifestList(paginate(items, { limit: options.limit, cursor: options.cursor }), { verbose: options.verbose }));
    });
  manifests
    .command("show <id>")
    .description("Show one stored manifest")
    .option("--verbose", "Show schemas and execution metadata", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, options: { verbose?: boolean; json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const manifest = await findManifest(client, id);
      if (!manifest) throw new Error(`Manifest not found or prefix is ambiguous: ${id}`);
      output(options.json, manifest, () => formatManifestDetail(manifest, { verbose: options.verbose }));
    });
  manifests
    .command("inspect <id>")
    .description("Inspect one stored manifest with expanded human detail")
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, options: { json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const manifest = await findManifest(client, id);
      if (!manifest) throw new Error(`Manifest not found or prefix is ambiguous: ${id}`);
      output(options.json, manifest, () => formatManifestDetail(manifest, { verbose: true }));
    });

  program
    .command("run <manifest>")
    .description("Plan, preview, and optionally execute a local-shell action manifest")
    .option("--input <json>", "Input JSON object")
    .option("--input-file <path>", "Read input JSON from a file")
    .option("--idempotency-key <key>", "Idempotency key")
    .option("--actor <id>", "Actor id")
    .option("--dry-run", "Preview without executing", false)
    .option("--approve", "Auto-approve this CLI run", false)
    .option("--verbose", "Show compact run detail after planning/execution", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (manifestPath: string, options: { input?: string; inputFile?: string; idempotencyKey?: string; actor?: string; dryRun?: boolean; approve?: boolean; verbose?: boolean; json?: boolean }) => {
      const manifest = readManifest(manifestPath);
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      await registerShellManifest(client, manifest);
      const actor = actorFromOption(options.actor);
      const run = await client.run(
        {
          actionId: manifest.id,
          input: inputFromOptions(options),
          actor,
          idempotencyKey: options.idempotencyKey,
          dryRun: options.dryRun,
        },
        options.approve
          ? { autoApprove: { actor, decision: "approved", reason: "CLI --approve" } }
          : {},
      );
      output(options.json, run, () => options.verbose ? formatRunDetail(run, { verbose: true }) : `${run.status} ${run.id} ${truncateText(run.confirmationSummary, 120)}`);
    });

  const runs = program.command("runs").description("Inspect action runs");
  runs
    .command("list")
    .description("List action runs")
    .option("--action <id>", "Filter by action id")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", `Limit human output rows (default ${DEFAULT_LIST_LIMIT})`, parsePositiveIntOption)
    .option("--cursor <offset>", "Start human output at an offset cursor")
    .option("--verbose", "Show more run columns", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (options: { action?: string; status?: string; limit?: number; cursor?: string; verbose?: boolean; json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const items = await client.listRuns({ actionId: options.action, status: options.status });
      output(options.json, jsonList(items, options), () => formatRunList(paginate(items, { limit: options.limit, cursor: options.cursor }), { verbose: options.verbose }));
    });
  runs
    .command("show <id>")
    .description("Show one action run")
    .option("--verbose", "Show input/output/events in compact form", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, options: { verbose?: boolean; json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const run = await findRun(client, id);
      if (!run) throw new Error(`Run not found or prefix is ambiguous: ${id}`);
      output(options.json, run, () => formatRunDetail(run, { verbose: options.verbose }));
    });
  runs
    .command("inspect <id>")
    .description("Inspect one action run with expanded human detail")
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, options: { json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const run = await findRun(client, id);
      if (!run) throw new Error(`Run not found or prefix is ambiguous: ${id}`);
      output(options.json, run, () => formatRunDetail(run, { verbose: true }));
    });

  program
    .command("approve <run-id>")
    .description("Approve a planned action run")
    .option("--actor <id>", "Actor id")
    .option("--reason <text>", "Approval reason")
    .option("--verbose", "Show compact run detail after approval", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (runId: string, options: { actor?: string; reason?: string; verbose?: boolean; json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const run = await client.approve(runId, {
        actor: actorFromOption(options.actor),
        decision: "approved",
        reason: options.reason,
      });
      output(options.json, run, () => options.verbose ? formatRunDetail(run, { verbose: true }) : `${run.status} ${run.id}`);
    });

  program
    .command("deny <run-id>")
    .description("Deny a planned action run")
    .option("--actor <id>", "Actor id")
    .option("--reason <text>", "Denial reason")
    .option("--verbose", "Show compact run detail after denial", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (runId: string, options: { actor?: string; reason?: string; verbose?: boolean; json?: boolean }) => {
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      const run = await client.deny(runId, {
        actor: actorFromOption(options.actor),
        decision: "denied",
        reason: options.reason,
      });
      output(options.json, run, () => options.verbose ? formatRunDetail(run, { verbose: true }) : `${run.status} ${run.id}`);
    });

  program
    .command("execute <run-id> <manifest>")
    .description("Execute an approved stored run using a local-shell manifest")
    .option("--verbose", "Show compact run detail after execution", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (runId: string, manifestPath: string, options: { verbose?: boolean; json?: boolean }) => {
      const manifest = readManifest(manifestPath);
      const client = clientFor(program.opts<{ dir?: string }>().dir);
      await registerShellManifest(client, manifest);
      const run = await client.execute(runId);
      output(options.json, run, () => options.verbose ? formatRunDetail(run, { verbose: true }) : `${run.status} ${run.id}`);
    });

  return program;
}

export async function runActionsCli(argv = process.argv.slice(2), options: RunActionsCliOptions = {}): Promise<void> {
  const program = createProgram();
  if (options.programName) program.name(options.programName);
  await program.parseAsync(argv, { from: "user" });
}

if (import.meta.main) {
  runActionsCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
