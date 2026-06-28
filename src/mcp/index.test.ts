import { describe, expect, test } from "bun:test";
import { actionManifestToMcpTool, ACTIONS_MCP_CAPABILITIES, createActionsMcpCatalog } from "./index.js";
import { exampleActionManifest } from "../manifest.js";

describe("actions MCP skeleton", () => {
  test("exposes static capabilities", () => {
    expect(ACTIONS_MCP_CAPABILITIES).toMatchObject({
      server: "open-actions",
      schemaVersion: "1.0",
      capabilities: { tools: true, manifestCatalog: true },
    });
  });

  test("maps action manifests into MCP tools", () => {
    const manifest = {
      ...exampleActionManifest(),
      bindings: [{ kind: "mcp" as const, toolName: "tickets_create" }],
    };
    const tool = actionManifestToMcpTool(manifest);
    expect(tool).toMatchObject({
      name: "tickets_create",
      title: "Create ticket",
      annotations: {
        actionId: "tickets.create",
        actionVersion: "1.0.0",
        dryRunSupported: true,
        idempotencyRequired: true,
      },
    });
    expect(tool.inputSchema).toMatchObject({ type: "object" });
  });

  test("builds catalogs from manifests", () => {
    const catalog = createActionsMcpCatalog([exampleActionManifest()]);
    expect(catalog.server).toBe("open-actions");
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]?.name).toBe("tickets_create");
  });
});
