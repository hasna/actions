import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleActionManifest } from "../manifest.js";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hasna-actions-cli-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  const child = Bun.spawn({
    cmd: ["bun", "run", "src/cli/index.ts", ...args],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("actions CLI", () => {
  test("prints help and status", async () => {
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("actions");
    expect(help.stdout).toContain("validate <manifest.json>");
    expect(help.stdout).toContain("contracts examples");

    const status = await runCli(["--json", "status"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      service: "actions",
      package: "@hasna/actions",
      capabilities: { manifestValidation: true, mcpCatalog: true, contractAdapters: true },
    });
  });

  test("prints and validates an example manifest", async () => {
    const example = await runCli(["--json", "manifest", "example"]);
    expect(example.exitCode).toBe(0);
    const manifest = JSON.parse(example.stdout);
    expect(manifest).toMatchObject({ id: "tickets.create", bindings: [{ kind: "cli" }] });

    const manifestPath = join(dataDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(exampleActionManifest(), null, 2));

    const valid = await runCli(["--json", "validate", manifestPath]);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, errors: [] });
  });

  test("returns non-zero for invalid manifests", async () => {
    const manifestPath = join(dataDir, "bad.json");
    writeFileSync(manifestPath, JSON.stringify({ id: "bad", version: "1.0.0", bindings: [] }));

    const invalid = await runCli(["--json", "validate", manifestPath]);
    expect(invalid.exitCode).toBe(1);
    const result = JSON.parse(invalid.stdout);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error: { code: string }) => error.code)).toContain("bindings.required");
  });

  test("prints contract adapter examples without changing existing command shapes", async () => {
    const examples = await runCli(["--json", "contracts", "examples"]);
    expect(examples.exitCode).toBe(0);
    expect(examples.stderr).toBe("");
    expect(JSON.parse(examples.stdout)).toMatchObject({
      actorRef: { schema: "hasna.actor_ref.v1", kind: "human" },
      evidenceRef: { schema: "hasna.evidence_ref.v1" },
      decisionEnvelope: { schema: "hasna.decision_envelope.v1" },
      workRun: { schema: "hasna.work_run.v1", status: "succeeded" },
      capabilityCard: { schema: "hasna.capability_card.v1", name: "actions CLI" },
    });

    const card = await runCli(["--json", "contracts", "capability-card"]);
    expect(card.exitCode).toBe(0);
    expect(JSON.parse(card.stdout)).toMatchObject({
      schema: "hasna.capability_card.v1",
      capabilities: expect.arrayContaining(["contracts:examples"]),
    });
  });
});
