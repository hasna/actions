import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { ActionManifest, ActorRef } from "../types.js";
import { ActionsClient, assertManifest, createLocalShellAction } from "../index.js";
import { MCP_DEFAULT_LIST_LIMIT, compactManifest, compactRun, detailLevel, mcpListResponse, paginate } from "../presentation.js";

export interface ToolDeps {
  client: ActionsClient;
}

export interface ToolDef {
  name: string;
  verb: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown>;
}

function actorFromArgs(args: Record<string, unknown>): ActorRef {
  return {
    id: typeof args.actorId === "string" ? args.actorId : "mcp",
    type: typeof args.actorType === "string" ? args.actorType as ActorRef["type"] : "agent",
  };
}

async function registerManifest(deps: ToolDeps, manifest: ActionManifest): Promise<ActionManifest> {
  assertManifest(manifest);
  if (manifest.executorBindings.some((binding) => binding.kind === "local-shell")) {
    await deps.client.register(createLocalShellAction(manifest));
    return manifest;
  }
  return deps.client.register({
    manifest,
    executor: {
      execute: async () => {
        throw new Error(`Action ${manifest.id} has no executable in-process binding`);
      },
    },
  });
}

const detailSchema = z.enum(["compact", "verbose", "full"]).optional().describe("Output detail level. Defaults to compact; use full to return the full stored object.");

function detailFromArgs(args: Record<string, unknown>) {
  return detailLevel(args.detail);
}

function manifestResult(manifest: ActionManifest, args: Record<string, unknown>): unknown {
  const detail = detailFromArgs(args);
  if (detail === "full") return manifest;
  return compactManifest(manifest, { verbose: detail === "verbose" });
}

function runResult(run: unknown, args: Record<string, unknown>): unknown {
  if (!run || typeof run !== "object" || !("status" in run)) return run;
  const detail = detailFromArgs(args);
  if (detail === "full") return run;
  return compactRun(run as Parameters<typeof compactRun>[0], { verbose: detail === "verbose" });
}

export const TOOLS: ToolDef[] = [
  {
    name: "actions_register_manifest",
    verb: "register_manifest",
    title: "Register an action manifest",
    description: "Validate and store a portable action manifest. Local-shell manifests become executable in this MCP process.",
    inputSchema: {
      manifest: z.record(z.unknown()).describe("Action manifest object"),
      detail: detailSchema,
    },
    handler: async (deps, args) => manifestResult(await registerManifest(deps, args.manifest as ActionManifest), args),
  },
  {
    name: "actions_list_manifests",
    verb: "list_manifests",
    title: "List action manifests",
    description: "List locally stored action manifests. Compact and paginated by default.",
    inputSchema: {
      limit: z.number().int().positive().optional().describe(`Maximum records to return. Defaults to ${MCP_DEFAULT_LIST_LIMIT} for compact/verbose output.`),
      cursor: z.union([z.string(), z.number()]).optional().describe("Offset cursor from a previous list response."),
      detail: detailSchema,
    },
    handler: async (deps, args) => {
      const detail = detailFromArgs(args);
      const manifests = await deps.client.listManifests();
      const page = paginate(manifests, { limit: args.limit as number | undefined, cursor: args.cursor as string | number | undefined, defaultLimit: MCP_DEFAULT_LIST_LIMIT });
      return mcpListResponse(
        "manifests",
        page,
        detail === "full" ? page.items : page.items.map((manifest) => compactManifest(manifest, { verbose: detail === "verbose" })),
        "Use actions_show_manifest for one manifest, detail=\"verbose\" for more fields, or detail=\"full\" for paginated full records.",
      );
    },
  },
  {
    name: "actions_show_manifest",
    verb: "show_manifest",
    title: "Show an action manifest",
    description: "Return one stored action manifest by id. Compact by default.",
    inputSchema: {
      actionId: z.string(),
      detail: detailSchema,
    },
    handler: async (deps, args) => {
      const manifest = await deps.client.getManifest(args.actionId as string);
      if (!manifest) return { error: "not found", id: args.actionId };
      return manifestResult(manifest, args);
    },
  },
  {
    name: "actions_run",
    verb: "run",
    title: "Run an action",
    description: "Plan, preview, and optionally execute a registered action. Use dryRun=true for no-write preview.",
    inputSchema: {
      actionId: z.string(),
      input: z.unknown().optional(),
      idempotencyKey: z.string().optional(),
      dryRun: z.boolean().optional(),
      approve: z.boolean().optional(),
      actorId: z.string().optional(),
      actorType: z.enum(["human", "agent", "service", "system"]).optional(),
      detail: detailSchema,
    },
    handler: async (deps, args) => {
      const actor = actorFromArgs(args);
      const run = await deps.client.run(
        {
          actionId: args.actionId as string,
          input: args.input ?? {},
          actor,
          idempotencyKey: args.idempotencyKey as string | undefined,
          dryRun: args.dryRun as boolean | undefined,
        },
        args.approve === true ? { autoApprove: { actor, decision: "approved", reason: "MCP approve=true" } } : {},
      );
      return runResult(run, args);
    },
  },
  {
    name: "actions_approve",
    verb: "approve",
    title: "Approve an action run",
    description: "Approve a planned or previewed action run.",
    inputSchema: {
      runId: z.string(),
      reason: z.string().optional(),
      actorId: z.string().optional(),
      actorType: z.enum(["human", "agent", "service", "system"]).optional(),
      detail: detailSchema,
    },
    handler: async (deps, args) =>
      runResult(await deps.client.approve(args.runId as string, {
        actor: actorFromArgs(args),
        decision: "approved",
        reason: args.reason as string | undefined,
      }), args),
  },
  {
    name: "actions_deny",
    verb: "deny",
    title: "Deny an action run",
    description: "Deny a planned or previewed action run.",
    inputSchema: {
      runId: z.string(),
      reason: z.string().optional(),
      actorId: z.string().optional(),
      actorType: z.enum(["human", "agent", "service", "system"]).optional(),
      detail: detailSchema,
    },
    handler: async (deps, args) =>
      runResult(await deps.client.deny(args.runId as string, {
        actor: actorFromArgs(args),
        decision: "denied",
        reason: args.reason as string | undefined,
      }), args),
  },
  {
    name: "actions_execute",
    verb: "execute",
    title: "Execute an action run",
    description: "Execute an approved action run.",
    inputSchema: {
      runId: z.string(),
      rollbackOnFailure: z.boolean().optional(),
      detail: detailSchema,
    },
    handler: async (deps, args) => runResult(await deps.client.execute(args.runId as string, { rollbackOnFailure: args.rollbackOnFailure as boolean | undefined }), args),
  },
  {
    name: "actions_show_run",
    verb: "show_run",
    title: "Show an action run",
    description: "Return one action run by id. Compact by default.",
    inputSchema: { runId: z.string(), detail: detailSchema },
    handler: async (deps, args) => runResult(await deps.client.getRun(args.runId as string) ?? { error: "not found", id: args.runId }, args),
  },
  {
    name: "actions_list_runs",
    verb: "list_runs",
    title: "List action runs",
    description: "List local action runs. Compact and paginated by default.",
    inputSchema: {
      actionId: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().int().positive().optional().describe(`Maximum records to return. Defaults to ${MCP_DEFAULT_LIST_LIMIT} for compact/verbose output.`),
      cursor: z.union([z.string(), z.number()]).optional().describe("Offset cursor from a previous list response."),
      detail: detailSchema,
    },
    handler: async (deps, args) => {
      const detail = detailFromArgs(args);
      const runs = await deps.client.listRuns({
        actionId: args.actionId as string | undefined,
        status: args.status as string | undefined,
      });
      const page = paginate(runs, { limit: args.limit as number | undefined, cursor: args.cursor as string | number | undefined, defaultLimit: MCP_DEFAULT_LIST_LIMIT });
      return mcpListResponse(
        "runs",
        page,
        detail === "full" ? page.items : page.items.map((run) => compactRun(run, { verbose: detail === "verbose" })),
        "Use actions_show_run for one run, detail=\"verbose\" for compact input/output previews, or detail=\"full\" for paginated full records.",
      );
    },
  },
];
