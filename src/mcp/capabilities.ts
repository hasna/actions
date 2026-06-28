export const ACTIONS_MCP_CAPABILITIES = {
  server: "open-actions",
  schemaVersion: "1.0",
  capabilities: {
    tools: true,
    manifestCatalog: true,
    dryRunPreviews: true,
    approvalMetadata: true,
  },
} as const;
