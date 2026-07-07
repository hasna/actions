import { describe, expect, test } from "bun:test";
import { SCHEMA_IDS, parseContract } from "@hasna/contracts";
import { exampleActionManifest } from "../manifest.js";
import {
  ACTION_ACTOR_KIND_TO_CONTRACT_KIND,
  ACTION_RUN_STATUS_TO_CONTRACT_STATUS,
  actionActorToActorRef,
  actionManifestToCapabilityCard,
  actionRunToWorkRun,
  approvalDecisionToDecisionEnvelope,
  createActionsCliCapabilityCard,
  createExampleActionContracts,
  evidenceRefFromActionEvidenceRef,
} from "./contracts.js";
import type { ActionActor, ActionRun, ActionRunStatus, ApprovalDecision } from "../types.js";

const createdAt = "2026-06-28T00:00:00.000Z";

describe("contract adapters", () => {
  test("maps ActionActor user to actor_ref human and preserves the legacy kind", () => {
    const actor: ActionActor = {
      id: "user_123",
      type: "user",
      displayName: "Pat Reviewer",
      tenantId: "tenant_hasna",
    };

    const ref = actionActorToActorRef(actor, { createdAt });

    expect(ACTION_ACTOR_KIND_TO_CONTRACT_KIND.user).toBe("human");
    expect(ref).toMatchObject({
      schema: SCHEMA_IDS.actorRef,
      id: "user_123",
      kind: "human",
      name: "Pat Reviewer",
      metadata: {
        originalActionActorType: "user",
        tenantId: "tenant_hasna",
      },
    });
  });

  test("documents every ActionRunStatus to ContractStatus mapping", () => {
    const expected = {
      pending: "pending",
      queued: "pending",
      waiting_approval: "pending",
      claimed: "running",
      running: "running",
      retrying: "running",
      succeeded: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
      skipped: "skipped",
      dead: "failed",
    } as const satisfies Record<ActionRunStatus, string>;

    expect(ACTION_RUN_STATUS_TO_CONTRACT_STATUS).toEqual(expected);
  });

  test("maps ApprovalDecision and its evidenceRef to decision_envelope and evidence_ref", () => {
    const actor: ActionActor = { id: "agent_1", type: "agent", displayName: "Runner" };
    const decision: ApprovalDecision = {
      id: "approval_123",
      status: "rejected",
      requestedAt: createdAt,
      decidedAt: "2026-06-28T00:01:00.000Z",
      requestedBy: actor,
      decidedBy: actor,
      reason: "Rejected by policy.",
      evidenceRef: "approval-log-123",
    };

    const envelope = approvalDecisionToDecisionEnvelope(decision, {
      actionId: "tickets.create",
      manifestVersion: "1.0.0",
    });
    const evidence = evidenceRefFromActionEvidenceRef(decision.evidenceRef!, { createdAt });

    expect(envelope).toMatchObject({
      schema: SCHEMA_IDS.decisionEnvelope,
      decisionType: "approval",
      status: "denied",
      evidenceRefs: [{ id: "evidence_approval-log-123" }],
      obligations: ["do-not-execute-action"],
      metadata: { originalApprovalDecisionStatus: "rejected" },
    });
    expect(evidence).toMatchObject({
      schema: SCHEMA_IDS.evidenceRef,
      uri: "artifact://actions/evidence/approval-log-123",
      metadata: { originalEvidenceRef: "approval-log-123" },
    });
  });

  test("maps ActionRun to work_run and preserves the original status", () => {
    const actor: ActionActor = { id: "agent_1", type: "agent", displayName: "Runner" };
    const run: ActionRun = {
      id: "run_123",
      invocation: {
        id: "inv_123",
        actionId: "tickets.create",
        manifestVersion: "1.0.0",
        input: { title: "Need help" },
        actor,
        runId: "run_123",
        requestedAt: createdAt,
      },
      status: "dead",
      attempt: 3,
      maxAttempts: 3,
      createdAt,
      updatedAt: "2026-06-28T00:02:00.000Z",
      startedAt: "2026-06-28T00:00:10.000Z",
      result: {
        summary: "Partial result before failure",
        output: { upstreamRequestId: "req_123" },
      },
      error: { code: "HTTP_500", message: "upstream failed", retryable: false },
      deadLetter: {
        reason: "max attempts exceeded",
        failedAt: "2026-06-28T00:02:00.000Z",
        attempts: 3,
        replayable: true,
      },
    };

    const workRun = actionRunToWorkRun(run);

    expect(workRun).toMatchObject({
      schema: SCHEMA_IDS.workRun,
      id: "run_123",
      status: "failed",
      finishedAt: "2026-06-28T00:02:00.000Z",
      metadata: {
        originalActionRunStatus: "dead",
        input: { title: "Need help" },
        resultOutput: { upstreamRequestId: "req_123" },
        error: { code: "HTTP_500", message: "upstream failed", retryable: false },
        deadLetter: { reason: "max attempts exceeded" },
        actorOriginalActionActorType: "agent",
      },
    });
    expect(workRun.evidenceRefs).toEqual([
      {
        id: "run_123_failure",
        kind: "artifact",
        summary: "upstream failed",
      },
    ]);
  });

  test("keeps result evidence even when approval evidence is present", () => {
    const examples = createExampleActionContracts({ createdAt });

    expect(examples.workRun.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run_123_result", summary: "Created ticket TCK-123." }),
        expect.objectContaining({ summary: "Approval evidence." }),
      ]),
    );
    expect(examples.workRun.metadata).toMatchObject({
      input: { title: "Need help" },
      resultOutput: { ticketId: "TCK-123" },
      actorOriginalActionActorType: "user",
      actorTenantId: "tenant_hasna",
    });
    expect(examples.decisionEnvelope.metadata).toMatchObject({
      requestedByActionActorType: "user",
      decidedByActionActorType: "user",
    });
  });

  test("maps manifests and the CLI surface to capability_card", () => {
    const manifestCard = actionManifestToCapabilityCard(exampleActionManifest(), { createdAt });
    const cliCard = createActionsCliCapabilityCard({ createdAt, version: "0.1.0" });

    expect(manifestCard).toMatchObject({
      schema: SCHEMA_IDS.capabilityCard,
      kind: "tool",
      name: "Create ticket",
      capabilities: expect.arrayContaining(["binding:cli", "dry-run:preview-and-policy"]),
      riskLevel: "medium",
    });
    expect(cliCard).toMatchObject({
      schema: SCHEMA_IDS.capabilityCard,
      kind: "tool",
      name: "actions CLI",
      capabilities: expect.arrayContaining(["contracts:examples"]),
    });
  });

  test("example payloads are parseContract-validated for every adopted schema", () => {
    const examples = createExampleActionContracts({ createdAt });

    expect(parseContract(SCHEMA_IDS.actorRef, examples.actorRef)).toEqual(examples.actorRef);
    expect(parseContract(SCHEMA_IDS.evidenceRef, examples.evidenceRef)).toEqual(examples.evidenceRef);
    expect(parseContract(SCHEMA_IDS.decisionEnvelope, examples.decisionEnvelope)).toEqual(examples.decisionEnvelope);
    expect(parseContract(SCHEMA_IDS.workRun, examples.workRun)).toEqual(examples.workRun);
    expect(parseContract(SCHEMA_IDS.capabilityCard, examples.capabilityCard)).toEqual(examples.capabilityCard);
  });
});
