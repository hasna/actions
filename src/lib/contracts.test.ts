import { describe, expect, test } from "bun:test";
import { SCHEMA_IDS, parseContract } from "@hasna/contracts";
import { exampleActionManifest } from "../manifest.js";
import {
  ACTION_ACTOR_KIND_TO_CONTRACT_KIND,
  ACTION_RUN_STATUS_TO_CONTRACT_STATUS,
  APPROVAL_DECISION_STATUS_TO_CONTRACT_STATUS,
  actionActorKindToContractKind,
  actionActorToActorRef,
  actionInvocationToWorkRun,
  actionManifestToCapabilityCard,
  actionRunToWorkRun,
  approvalDecisionToDecisionEnvelope,
  createActionsCliCapabilityCard,
  createExampleActionContracts,
  evidenceRefFromActionEvidenceRef,
} from "./contracts.js";
import type { ActionActor, ActionInvocation, ActionRun, ActionRunStatus, ApprovalDecision, ApprovalDecisionStatus } from "../types.js";

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

  test("documents every ActionActor kind to actor_ref kind mapping", () => {
    const expected = {
      user: "human",
      agent: "agent",
      system: "system",
      service: "service",
    } as const satisfies Record<ActionActor["type"], string>;

    expect(ACTION_ACTOR_KIND_TO_CONTRACT_KIND).toEqual(expected);
    for (const [actionKind, contractKind] of Object.entries(expected)) {
      expect(actionActorKindToContractKind(actionKind as ActionActor["type"])).toBe(contractKind);
    }
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

  test("documents every ApprovalDecision status to decision_envelope status mapping", () => {
    const expected = {
      pending: "approval_required",
      approved: "allowed",
      rejected: "denied",
      expired: "denied",
      cancelled: "skipped",
    } as const satisfies Record<ApprovalDecisionStatus, string>;

    expect(APPROVAL_DECISION_STATUS_TO_CONTRACT_STATUS).toEqual(expected);
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
        input: { privateInput: "do-not-copy-input" },
        actor,
        runId: "run_123",
        idempotencyKey: "do-not-copy-idempotency-key",
        requestedAt: createdAt,
      },
      status: "dead",
      attempt: 3,
      maxAttempts: 3,
      createdAt,
      updatedAt: "2026-06-28T00:02:00.000Z",
      startedAt: "2026-06-28T00:00:10.000Z",
      result: {
        summary: "do-not-copy-result-summary",
        output: { privateOutput: "do-not-copy-output" },
      },
      error: { code: "HTTP_500", message: "do-not-copy-error-message", retryable: false },
      deadLetter: {
        reason: "do-not-copy-dead-letter-reason",
        failedAt: "2026-06-28T00:02:00.000Z",
        attempts: 3,
        replayable: true,
      },
      metadata: { privateRunMetadata: "do-not-copy-run-metadata" },
    };

    const workRun = actionRunToWorkRun(run);
    const serialized = JSON.stringify(workRun);

    expect(workRun).toMatchObject({
      schema: SCHEMA_IDS.workRun,
      id: "run_123",
      status: "failed",
      finishedAt: "2026-06-28T00:02:00.000Z",
      metadata: {
        originalActionRunStatus: "dead",
        idempotencyKeyRedacted: true,
        inputRedacted: true,
        resultOutputRedacted: true,
        resultSummaryRedacted: true,
        errorRedacted: true,
        errorCode: "HTTP_500",
        errorRetryable: false,
        deadLetterRedacted: true,
        deadLetterAttempts: 3,
        deadLetterReplayable: true,
        runtimeMetadataRedacted: true,
        runtimeMetadataKeys: ["privateRunMetadata"],
        actorOriginalActionActorType: "agent",
      },
    });
    expect(workRun.evidenceRefs).toEqual([
      {
        id: "run_123_failure",
        kind: "artifact",
        summary: "Action run failed; error details are stored outside the shared work_run contract.",
      },
    ]);
    expect(serialized).not.toContain("do-not-copy");
  });

  test("maps ActionInvocation to work_run without copying raw input metadata", () => {
    const invocation: ActionInvocation = {
      id: "inv_123",
      actionId: "tickets.create",
      manifestVersion: "1.0.0",
      input: { privateInput: "do-not-copy-invocation-input" },
      actor: { id: "agent_1", type: "agent", displayName: "Runner" },
      runId: "run_123",
      idempotencyKey: "do-not-copy-invocation-idempotency-key",
      requestedAt: createdAt,
      metadata: { privateInvocationMetadata: "do-not-copy-invocation-metadata" },
    };

    const workRun = actionInvocationToWorkRun(invocation);
    const serialized = JSON.stringify(workRun);

    expect(workRun).toMatchObject({
      schema: SCHEMA_IDS.workRun,
      id: "run_123",
      status: "pending",
      metadata: {
        idempotencyKeyRedacted: true,
        inputRedacted: true,
        runtimeMetadataRedacted: true,
        runtimeMetadataKeys: ["privateInvocationMetadata"],
      },
    });
    expect(serialized).not.toContain("do-not-copy");
  });

  test("keeps result evidence even when approval evidence is present", () => {
    const examples = createExampleActionContracts({ createdAt });

    expect(examples.workRun.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run_123_result",
          summary: "Action run result is stored outside the shared work_run contract.",
        }),
        expect.objectContaining({ summary: "Approval evidence." }),
      ]),
    );
    expect(examples.workRun.metadata).toMatchObject({
      inputRedacted: true,
      resultOutputRedacted: true,
      resultSummaryRedacted: true,
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
