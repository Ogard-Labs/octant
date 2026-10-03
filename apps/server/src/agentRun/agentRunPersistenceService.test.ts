import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AgentRunRequested,
  AgentRunStatusChanged,
  AgentRunResultAcknowledged,
  AgentRunResultDeliverySettled,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunRequestId,
  USAGE_RESUME_CANCELLED,
  USAGE_RESUME_SCHEDULED,
  USAGE_RESUME_SETTLED,
  UsageResumeCancelled,
  UsageResumeScheduled,
  UsageResumeSettled,
  type AgentRunAuthority,
  type AgentRunCommand,
  type AgentRunRoutingReceipt,
  type AgentRunWorkspaceReceipt,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import {
  writeAgentRunResultEvidence,
  readAgentRunAdmittedContext,
} from "../persistence/agentRunContentStore";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { purgeThreadContent } from "../persistence/chatProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection, ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  AGENT_RUN_RESULT_DELIVERY_SETTLED,
  AGENT_RUN_REQUESTED,
  AGENT_RUN_RESULT_ACKNOWLEDGED,
  AGENT_RUN_STATUS_CHANGED,
  AgentRunEventStore,
} from "./agentRunEventStore";
import { AgentRunPersistenceService } from "./agentRunPersistenceService";
import { AgentRunProjection } from "./agentRunProjection";

const directories: Array<string> = [];
const now = "2026-08-01T10:00:00.000Z";
const later = "2026-08-01T10:05:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-agent-run-persist-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  run: decodeAgentRunId("11111111-1111-4111-8111-111111111111"),
  request: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222222"),
  thread: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333333"),
  provider: "55555555-5555-4555-8555-555555555555",
  providerB: "88888888-8888-4888-8888-888888888888",
  snapshot: "66666666-6666-4666-8666-666666666666",
  actor: "77777777-7777-4777-8777-777777777777",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });

const parentAuthority: AgentRunAuthority = {
  filesystem: true,
  shell: true,
  git: true,
  network: true,
  tools: true,
  subagents: true,
  executionPolicy: "approval-gated",
  permissionPersistence: "project-default",
};

const requestedAuthority: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};

const routingReceipt: AgentRunRoutingReceipt = {
  executionResolution: {
    providerInstanceId: ids.provider as never,
    modelId: "gpt-4o" as never,
    hostId: "local" as never,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
    effectivePermissions: {
      filesystem: false,
      shell: false,
      git: false,
      network: true,
      tools: true,
      subagents: false,
    },
    source: "project-default",
    fallbackChain: ["project-default"],
    downgradeReasons: [],
  },
  selectedExecutionKind: "octant-managed",
  attemptedExecutionKind: "provider-native",
  selectedProviderInstanceId: ids.provider as never,
  selectedModelId: "gpt-4o" as never,
  fallbackCandidates: [],
  capabilityDegradations: ["native-child-agents-unavailable"],
  contextSnapshotId: ids.snapshot as never,
  effectiveAuthorityDigest: "digest-1",
  usageQuality: "provider-reported",
  hostId: "local" as never,
  mode: "chat",
};

const workspaceReceipt: AgentRunWorkspaceReceipt = { kind: "chat-virtual", mode: "chat" };
const workWorkspaceReceipt: AgentRunWorkspaceReceipt = {
  kind: "work-root",
  mode: "work",
  projectId: "55555555-5555-4555-8555-555555555555" as never,
  bindingRevisionId: "88888888-8888-4888-8888-888888888888" as never,
  canonicalRoot: "/projects/demo",
};

const poolRequested = { hostId: "local", providerInstanceId: ids.provider, modelId: "gpt-4o" };
const poolFallbackCandidate = {
  hostId: "local",
  providerInstanceId: ids.providerB,
  modelId: "claude-x",
};
const poolFallbackReason =
  "The requested model is unavailable; an explicitly permitted pool fallback was selected.";
const poolWaitingMessage = "No selected model is currently eligible.";

function poolRoutedReceipt(kind: "fallback" | "waiting"): AgentRunRoutingReceipt {
  const shared = {
    request: {
      pool: {
        candidates: [poolRequested, poolFallbackCandidate],
        mixedVendorEnabled: true,
        fallbackAllowed: true,
        higherCostFallbackAllowed: true,
      },
      requestedCandidate: poolRequested,
      requiredCapabilities: [],
    },
    mode: "chat" as const,
    activeHostId: "local" as never,
    parentCandidate: poolRequested,
  };
  const poolRoute = {
    decidedAt: now as never,
    decision:
      kind === "fallback"
        ? {
            kind: "selected" as const,
            ...shared,
            eligibility: [
              {
                candidate: poolRequested,
                eligible: false,
                reasons: ["model-unavailable" as const],
              },
              { candidate: poolFallbackCandidate, eligible: true, reasons: [] },
            ],
            selectedCandidate: poolFallbackCandidate,
            selectionKind: "fallback" as const,
            reason: poolFallbackReason,
          }
        : {
            kind: "waiting" as const,
            ...shared,
            eligibility: [
              {
                candidate: poolRequested,
                eligible: false,
                reasons: ["model-unavailable" as const],
              },
              {
                candidate: poolFallbackCandidate,
                eligible: false,
                reasons: ["provider-not-ready" as const],
              },
            ],
            reason: "no-eligible-candidate" as const,
            message: poolWaitingMessage,
          },
  };
  return {
    ...routingReceipt,
    ...(kind === "fallback"
      ? {
          selectedFallback: {
            providerInstanceId: ids.providerB as never,
            modelId: "claude-x" as never,
            reason: poolFallbackReason,
          },
        }
      : {}),
    poolRoute: poolRoute as never,
  };
}

function requestCommand(): Extract<AgentRunCommand, { kind: "request-agent-run" }> {
  return {
    kind: "request-agent-run",
    requestId: ids.request,
    parentThreadId: ids.thread,
    role: "research",
    task: "Summarize the design.",
    creationPosture: "automatic",
    requestedAuthority,
    routingReceipt,
    workspaceReceipt,
  };
}

function createHarness(connection = openConnection()) {
  const registry = new EventRegistry()
    .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
    .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
    .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged)
    .register(AGENT_RUN_RESULT_DELIVERY_SETTLED, 1, AgentRunResultDeliverySettled)
    .register(USAGE_RESUME_SCHEDULED, 1, UsageResumeScheduled)
    .register(USAGE_RESUME_CANCELLED, 1, UsageResumeCancelled)
    .register(USAGE_RESUME_SETTLED, 1, UsageResumeSettled);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    if (counter === 1) return ids.run;
    const suffix = counter.toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
  const store = new AgentRunEventStore({ journal, uuid, actor });
  const projection = new AgentRunProjection();
  const service = new AgentRunPersistenceService({
    store,
    projection,
    uuid,
    clock: () => later,
    connection,
  });
  return { connection, store, projection, service, journal, registry, projections };
}

describe("AgentRunPersistenceService", () => {
  it("accepts a fresh request, projects it, and returns parent summary", () => {
    const { service } = createHarness();
    const result = service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(result.kind).toBe("run-accepted");
    if (result.kind !== "run-accepted") return;
    expect(result.run.id).toBe(ids.run);
    expect(result.run.lifecycleStatus).toBe("queued");
    expect(result.run.routingReceipt.usageQuality).toBe("provider-reported");

    const summary = service.parentSummary(ids.thread);
    expect(summary).toHaveLength(1);
    expect(summary[0]?.runId).toBe(ids.run);
  });

  it("journals a Work binding receipt and rebuilds it on replay", () => {
    const first = createHarness();
    const workRouting = { ...routingReceipt, mode: "work" as const };
    const accepted = first.service.requestRun({
      command: {
        ...requestCommand(),
        requestedAuthority: {
          ...requestedAuthority,
          filesystem: true,
          network: false,
          executionPolicy: "approval-gated",
        },
        routingReceipt: workRouting,
        workspaceReceipt: workWorkspaceReceipt,
      },
      parentAuthority: {
        ...parentAuthority,
        network: false,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
      },
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    expect(accepted.run.workspaceReceipt).toEqual(workWorkspaceReceipt);

    const replayed = createHarness(first.connection);
    replayed.service.rebuildFromJournal();
    const restored = replayed.service.getById(accepted.run.id);
    expect(restored?.workspaceReceipt).toEqual(workWorkspaceReceipt);
  });

  it("is request-id idempotent on retry and does not create a second run", () => {
    const { service, projection } = createHarness();
    const first = service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    const second = service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(first).toEqual(second);
    expect(projection.snapshot().size).toBe(1);
  });

  it("derives child depth from the persisted same-thread parent and rejects forged parents", () => {
    const { service, projection } = createHarness();
    const root = service.requestRun({
      command: {
        ...requestCommand(),
        requestedAuthority: { ...requestedAuthority, subagents: true },
      },
      parentAuthority,
      confirmed: true,
    });
    expect(root.kind).toBe("run-accepted");
    if (root.kind !== "run-accepted") return;

    const child = service.requestRun({
      command: {
        ...requestCommand(),
        requestId: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222223"),
        parentRunId: root.run.id,
        requestedAuthority: { ...requestedAuthority, subagents: true },
      },
      parentAuthority,
      confirmed: true,
    });
    expect(child.kind).toBe("run-accepted");
    if (child.kind !== "run-accepted") return;
    expect(child.run.depth).toBe(1);

    const grandchild = service.requestRun({
      command: {
        ...requestCommand(),
        requestId: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222224"),
        parentRunId: child.run.id,
        requestedAuthority: { ...requestedAuthority, subagents: true },
      },
      parentAuthority,
      confirmed: true,
    });
    expect(grandchild.kind).toBe("run-accepted");
    if (grandchild.kind !== "run-accepted") return;
    expect(grandchild.run.depth).toBe(2);

    const tooDeep = service.requestRun({
      command: {
        ...requestCommand(),
        requestId: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222225"),
        parentRunId: grandchild.run.id,
      },
      parentAuthority,
      confirmed: true,
    });
    expect(tooDeep).toMatchObject({ kind: "run-command-failed", reason: "invalid" });

    const forged = service.requestRun({
      command: {
        ...requestCommand(),
        requestId: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222226"),
        parentThreadId: decodeAgentRunParentThreadId("33333333-3333-4333-8333-333333333334"),
        parentRunId: root.run.id,
      },
      parentAuthority,
      confirmed: true,
    });
    expect(forged).toMatchObject({ kind: "run-command-failed", reason: "invalid" });
    expect(projection.snapshot().size).toBe(3);
  });

  it("uses the persisted parent authority for nested creation", () => {
    const noSubagentHarness = createHarness();
    const parentWithoutSubagents = noSubagentHarness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(parentWithoutSubagents.kind).toBe("run-accepted");
    if (parentWithoutSubagents.kind !== "run-accepted") return;

    const rejected = noSubagentHarness.service.requestRun({
      command: {
        ...requestCommand(),
        requestId: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222227"),
        parentRunId: parentWithoutSubagents.run.id,
      },
      // The outer Chat authority permits subagents, but the persisted parent
      // was intentionally narrowed to `subagents: false`.
      parentAuthority,
      confirmed: true,
    });
    expect(rejected).toMatchObject({ kind: "run-command-failed", reason: "unauthorized" });
    expect(noSubagentHarness.projection.snapshot().size).toBe(1);

    const narrowedHarness = createHarness();
    const narrowedParent = narrowedHarness.service.requestRun({
      command: {
        ...requestCommand(),
        requestedAuthority: { ...parentAuthority, shell: false },
      },
      parentAuthority,
      confirmed: true,
    });
    expect(narrowedParent.kind).toBe("run-accepted");
    if (narrowedParent.kind !== "run-accepted") return;

    const widenedChild = narrowedHarness.service.requestRun({
      command: {
        ...requestCommand(),
        requestId: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222228"),
        parentRunId: narrowedParent.run.id,
        requestedAuthority: { ...parentAuthority, shell: true },
      },
      parentAuthority,
      confirmed: true,
    });
    expect(widenedChild).toMatchObject({
      kind: "run-command-failed",
      reason: "authority-widening",
    });
    expect(narrowedHarness.projection.snapshot().size).toBe(1);
  });

  it("applies lifecycle commands, rebuilds from journal, and preserves acknowledgement follow-up", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;

    harness.service.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    const running = harness.service.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    expect(running.kind).toBe("run-updated");
    if (running.kind !== "run-updated") return;

    const completed = harness.service.applyCommand({
      kind: "complete-agent-run",
      runId: accepted.run.id,
      expectedVersion: running.run.version as never,
      result: {
        reference: `octant://agent-run/${String(accepted.run.id)}/result`,
        truncated: false,
      },
      resultText: "The fallback is safe.",
      usage: { inputTokens: 1200, outputTokens: 300 },
    });
    expect(completed.kind).toBe("run-updated");
    if (completed.kind !== "run-updated") return;
    expect(completed.run.resultAcknowledgement.followUpReason).toBe("unacknowledged-child-result");
    expect(completed.run.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });

    // rebuild into a fresh projection from journal
    const rebuiltProjection = new AgentRunProjection();
    const rebuiltService = new AgentRunPersistenceService({
      store: harness.store,
      projection: rebuiltProjection,
      uuid: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clock: () => later,
      connection: harness.connection,
    });
    rebuiltService.rebuildFromJournal();
    const rebuilt = rebuiltProjection.getById(accepted.run.id);
    expect(rebuilt?.lifecycleStatus).toBe("completed");
    expect(rebuilt?.resultAcknowledgement).toEqual({
      required: true,
      acknowledged: false,
      followUpReason: "unacknowledged-child-result",
    });
    // Replay rebuilds the reply's identity; its text is stored beside the run
    // rather than journaled, so a restart still hands the parent the reply.
    expect(rebuilt?.result).toEqual({
      reference: `octant://agent-run/${String(accepted.run.id)}/result`,
      truncated: false,
    });
    expect(rebuiltService.resultText(accepted.run.id)).toBe("The fallback is safe.");
    expect(rebuiltService.resultPackets(accepted.run.id)).toMatchObject({
      packets: [
        {
          generation: 1,
          providerInstanceId: ids.provider,
          reportedSummary: { status: "available", text: "The fallback is safe." },
          files: { status: "unavailable", items: [] },
          checks: { status: "unavailable", items: [] },
        },
      ],
      truncated: false,
    });
    expect(rebuilt?.routingReceipt.usageQuality).toBe("provider-reported");
    expect(rebuilt?.authority.network).toBe(true);
    expect(rebuilt?.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
  });

  it("truncates large recorded evidence instead of losing the child completion", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("Admission failed");
    const runId = accepted.run.id;
    const apply = (command: Parameters<typeof harness.service.applyCommand>[0]) => {
      const result = harness.service.applyCommand(command);
      if (result.kind !== "run-updated") throw new Error("Update failed");
      return result.run;
    };
    const started = apply({
      kind: "start-agent-run",
      runId,
      expectedVersion: accepted.run.version,
    });
    const running = apply({
      kind: "mark-agent-run-running",
      runId,
      expectedVersion: started.version,
    });
    apply({
      kind: "complete-agent-run",
      runId,
      expectedVersion: running.version,
      result: { reference: `octant://agent-run/${runId}/result`, truncated: false },
      resultText: "Finished",
      resultEvidence: {
        files: {
          status: "recorded",
          items: Array.from({ length: 32 }, (_, i) => ({
            path: "x".repeat(2048),
            change: "modified",
            reference: `${i}${"r".repeat(2000)}`,
            source: "provider-reported",
            verified: false,
          })),
        },
        checks: {
          status: "recorded",
          items: Array.from({ length: 32 }, (_, i) => ({
            label: "Tool execution: inspect",
            outcome: "unknown",
            reference: `${i}${"r".repeat(2000)}`,
            source: "host-recorded",
            toolExecution: {
              toolName: "inspect",
              requestId: String(i),
              isError: false,
              output: "o".repeat(2048),
              truncated: false,
            },
          })),
        },
      },
    });
    const packet = harness.service.resultPackets(runId).packets[0];
    expect(packet?.reportedSummary.text).toBe("Finished");
    expect(packet?.files.status).toBe("truncated");
    expect(packet?.checks.status).toBe("truncated");
    expect(JSON.stringify(packet).length).toBeLessThan(131072);
  });

  it("keeps earlier result generations through follow-ups, replay and content purge", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("Admission failed");
    const runId = accepted.run.id;
    const version = () => {
      const run = harness.service.getById(runId);
      if (run === undefined) throw new Error("Missing run");
      return run.version;
    };
    const apply = (command: Parameters<typeof harness.service.applyCommand>[0]) => {
      const result = harness.service.applyCommand(command);
      expect(result.kind).toBe("run-updated");
    };
    apply({ kind: "start-agent-run", runId, expectedVersion: version() });
    apply({ kind: "mark-agent-run-running", runId, expectedVersion: version() });
    apply({
      kind: "complete-agent-run",
      runId,
      expectedVersion: version(),
      result: { reference: `octant://agent-run/${runId}/result`, truncated: false },
      resultText: "Agent claims all checks pass.",
      resultEvidence: {
        files: {
          status: "recorded",
          items: [
            {
              path: "src/first.ts",
              change: "modified",
              source: "provider-reported",
              verified: false,
              reference: "first-generation-file",
            },
          ],
        },
        checks: {
          status: "recorded",
          items: [
            {
              label: "Tool execution: inspect",
              outcome: "unknown",
              source: "host-recorded",
              reference: "first-generation-tool",
              toolExecution: {
                toolName: "inspect",
                requestId: "first-tool",
                isError: false,
                output: "Actual recorded output",
                truncated: false,
              },
            },
          ],
        },
      },
    });
    apply({
      kind: "settle-agent-run-result-delivery",
      runId,
      expectedVersion: version(),
      outcome: "consumed",
    });
    apply({
      kind: "resume-agent-run",
      runId,
      expectedVersion: version(),
      message: "Continue the work.",
    });
    expect(harness.service.resultPackets(runId).packets).toMatchObject([
      { generation: 1, reportedSummary: { text: "Agent claims all checks pass." } },
      { generation: 2, reportedSummary: { status: "unavailable" }, lifecycleStatus: "starting" },
    ]);
    apply({ kind: "mark-agent-run-running", runId, expectedVersion: version() });
    apply({
      kind: "complete-agent-run",
      runId,
      expectedVersion: version(),
      result: { reference: `octant://agent-run/${runId}/result/2`, truncated: true },
      resultText: "Second response.",
    });
    harness.service.rebuildFromJournal();
    const packets = harness.service.resultPackets(runId).packets;
    expect(packets.map((packet) => [packet.generation, packet.reportedSummary.text])).toEqual([
      [1, "Agent claims all checks pass."],
      [2, "Second response."],
    ]);
    expect(packets[0]?.files.items[0]?.path).toBe("src/first.ts");
    expect(packets[0]?.files.reviewStatus).toBe("unavailable");
    expect(packets[0]?.checks.items[0]?.outcome).toBe("unknown");
    expect(packets[0]?.checks.items[0]?.toolExecution?.output).toBe("Actual recorded output");
    expect(packets[1]?.files.status).toBe("unavailable");
    expect(packets[1]?.checks.status).toBe("unavailable");
    expect(packets[1]?.reportedSummary.truncated).toBe(true);
    purgeThreadContent(harness.connection, String(ids.thread));
    harness.connection
      .prepare("INSERT INTO thread_purge_tombstone VALUES (?, ?, NULL, ?, 1)")
      .run("chat", String(ids.thread), later);
    const first = packets[0];
    if (first === undefined) throw new Error("Missing result packet");
    writeAgentRunResultEvidence(harness.connection, {
      run: accepted.run,
      reference: `octant://agent-run/${runId}/result`,
      createdAt: later,
      evidence: { files: first.files, checks: first.checks },
    });
    expect(
      harness.connection
        .prepare(
          "SELECT content_id FROM agent_run_content_store WHERE content_kind = 'result-evidence'",
        )
        .all(),
    ).toEqual([]);
    harness.service.rebuildFromJournal();
    expect(
      harness.service
        .resultPackets(runId)
        .packets.every(
          (packet) =>
            packet.reportedSummary.status === "unavailable" &&
            packet.reportedSummary.text === undefined &&
            packet.files.status === "unavailable" &&
            packet.checks.status === "unavailable",
        ),
    ).toBe(true);
  });

  it("refuses an over-limit admitted selection and admits nothing", () => {
    for (const admittedContext of [
      Array.from({ length: MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS + 1 }, () => ({
        kind: "user-message" as const,
        text: "Which service paged first?",
      })),
      [
        {
          kind: "user-message" as const,
          text: "y".repeat(MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS + 1),
        },
      ],
    ]) {
      const harness = createHarness();
      // The bound is checked where the selection is stored, inside the same
      // transaction as the admission, so refusing it rolls the whole admission
      // back rather than leaving a run admitted under a selection nobody holds.
      expect(() =>
        harness.service.requestRun({
          command: {
            ...requestCommand(),
            routingReceipt: { ...routingReceipt, admittedContextBlocks: 1 },
            admittedContext: admittedContext as never,
          },
          parentAuthority,
          confirmed: true,
        }),
      ).toThrow();
      expect(
        harness.connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get(),
      ).toEqual({ count: 0 });
      expect(
        harness.connection.prepare("SELECT COUNT(*) AS count FROM agent_run_content_store").get(),
      ).toEqual({ count: 0 });
    }
  });

  it("purges the admitted parent context and the child reply with the deleted thread", () => {
    const harness = createHarness();
    const parentWords = "Which service paged first, and who acknowledged the page?";
    const childReply = "The ingest worker paged at 02:14 and Dana acknowledged it.";
    const accepted = harness.service.requestRun({
      command: {
        ...requestCommand(),
        routingReceipt: { ...routingReceipt, admittedContextBlocks: 1 },
        admittedContext: [{ kind: "user-message", text: parentWords }],
      },
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;

    harness.service.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    const running = harness.service.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    expect(running.kind).toBe("run-updated");
    if (running.kind !== "run-updated") return;
    expect(
      harness.service.applyCommand({
        kind: "complete-agent-run",
        runId: accepted.run.id,
        expectedVersion: running.run.version as never,
        result: {
          reference: `octant://agent-run/${String(accepted.run.id)}/result`,
          truncated: false,
        },
        resultText: childReply,
      }).kind,
    ).toBe("run-updated");

    const journalMatches = (needle: string) =>
      (
        harness.connection
          .prepare("SELECT COUNT(*) AS count FROM event_journal WHERE payload_json LIKE ?")
          .get(`%${needle}%`) as { readonly count: number }
      ).count;

    // Neither piece was ever journaled: the admission carries the snapshot id
    // and the block count, the completion carries the reply's reference.
    expect(journalMatches("Which service paged first")).toBe(0);
    expect(journalMatches("ingest worker paged at 02:14")).toBe(0);
    expect(
      readAgentRunAdmittedContext(harness.connection, {
        runId: accepted.run.id,
        contextSnapshotId: accepted.run.routingReceipt.contextSnapshotId,
      }),
    ).toEqual([{ kind: "user-message", text: parentWords }]);
    expect(harness.service.resultText(accepted.run.id)).toBe(childReply);

    // Permanently deleting the parent Chat thread is what the chat purge runs,
    // on the command path and on projection replay alike. Afterwards neither
    // the parent's words nor the child's reply are recoverable anywhere.
    purgeThreadContent(harness.connection, String(ids.thread));

    expect(journalMatches("Which service paged first")).toBe(0);
    expect(journalMatches("ingest worker paged at 02:14")).toBe(0);
    expect(
      readAgentRunAdmittedContext(harness.connection, {
        runId: accepted.run.id,
        contextSnapshotId: accepted.run.routingReceipt.contextSnapshotId,
      }),
    ).toBeUndefined();
    expect(harness.service.resultText(accepted.run.id)).toBeUndefined();

    // A purged run degrades honestly rather than disappearing: the journal
    // keeps its identity, the run still reports Completed, and the parent
    // summary carries the reply's reference with no text — so a reader is told
    // the reply is gone instead of being handed an empty one.
    expect(journalMatches(`octant://agent-run/${String(accepted.run.id)}/result`)).toBeGreaterThan(
      0,
    );
    const purgedEntry = harness.service
      .parentSummary(ids.thread)
      .find((entry) => entry.runId === accepted.run.id);
    expect(purgedEntry?.lifecycleStatus).toBe("completed");
    expect(purgedEntry?.result).toEqual({
      reference: `octant://agent-run/${String(accepted.run.id)}/result`,
      truncated: false,
    });
    expect(purgedEntry?.resultText).toBeUndefined();

    // Replaying the journal into a fresh projection cannot bring the text back.
    const replayedProjection = new AgentRunProjection();
    const replayed = new AgentRunPersistenceService({
      store: harness.store,
      projection: replayedProjection,
      uuid: () => "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc",
      clock: () => later,
      connection: harness.connection,
    });
    replayed.rebuildFromJournal();
    expect(replayed.getById(accepted.run.id)?.lifecycleStatus).toBe("completed");
    expect(replayed.resultText(accepted.run.id)).toBeUndefined();
    expect(
      readAgentRunAdmittedContext(harness.connection, {
        runId: accepted.run.id,
        contextSnapshotId: accepted.run.routingReceipt.contextSnapshotId,
      }),
    ).toBeUndefined();
  });

  it("never auto-completes non-terminal runs during restart reconciliation", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    harness.service.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    harness.service.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });

    // restart: new projection rebuilt from journal, then reconcile
    const restartedProjection = new AgentRunProjection();
    const restarted = new AgentRunPersistenceService({
      store: harness.store,
      projection: restartedProjection,
      uuid: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      clock: () => later,
      connection: harness.connection,
    });
    restarted.rebuildFromJournal();
    const before = restartedProjection.getById(accepted.run.id);
    expect(before?.lifecycleStatus).toBe("running");

    const reconciled = restarted.reconcileAfterRestart();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.lifecycleStatus).toBe("interrupted");
    expect(reconciled[0]?.recoveryReason).toMatch(/restart/i);
    expect(reconciled[0]?.lifecycleStatus).not.toBe("completed");

    // rebuild again and ensure interrupted is durable
    const durableProjection = new AgentRunProjection();
    const durable = new AgentRunPersistenceService({
      store: harness.store,
      projection: durableProjection,
      uuid: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      clock: () => later,
      connection: harness.connection,
    });
    durable.rebuildFromJournal();
    expect(durableProjection.getById(accepted.run.id)?.lifecycleStatus).toBe("interrupted");
  });

  it("still lists a parent's children after a host restart resumes from stored checkpoints", () => {
    const connection = openConnection();
    const registry = new EventRegistry()
      .register(AGENT_RUN_REQUESTED, 1, AgentRunRequested)
      .register(AGENT_RUN_STATUS_CHANGED, 1, AgentRunStatusChanged)
      .register(AGENT_RUN_RESULT_ACKNOWLEDGED, 1, AgentRunResultAcknowledged);
    // As the host wires it: the projection is registered with the journal,
    // so every append also advances its stored checkpoint.
    const liveProjection = new AgentRunProjection();
    const journal = new Journal({
      connection,
      registry,
      projections: new ProjectionRegistry()
        .register(new AggregateHeadsProjection())
        .register(liveProjection),
      clock: () => now,
    });
    const store = new AgentRunEventStore({ journal, uuid: () => ids.run, actor });
    const live = new AgentRunPersistenceService({
      store,
      projection: liveProjection,
      uuid: () => ids.run,
      clock: () => later,
      connection,
    });
    expect(
      live.requestRun({ command: requestCommand(), parentAuthority, confirmed: true }).kind,
    ).toBe("run-accepted");

    // A new process: a fresh projection caught up the way startup does it.
    const restartedProjection = new AgentRunProjection();
    catchUpProjection({ connection, journal, projection: restartedProjection, clock: () => later });
    const restarted = new AgentRunPersistenceService({
      store,
      projection: restartedProjection,
      uuid: () => ids.run,
      clock: () => later,
      connection,
    });

    expect(restarted.parentSummary(ids.thread).map((entry) => entry.runId)).toEqual([ids.run]);
  });

  it("keeps ambiguous waiting runs non-completed on restart", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    harness.service.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    harness.service.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    harness.service.applyCommand({
      kind: "wait-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      recoveryReason: "awaiting-approval",
    });

    const restartedProjection = new AgentRunProjection();
    const restarted = new AgentRunPersistenceService({
      store: harness.store,
      projection: restartedProjection,
      uuid: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
      clock: () => later,
      connection: harness.connection,
    });
    restarted.rebuildFromJournal();
    const reconciled = restarted.reconcileAfterRestart();
    expect(reconciled[0]?.lifecycleStatus).toBe("interrupted");
    expect(reconciled[0]?.lifecycleStatus).not.toBe("completed");
  });

  it("replays the immutable pool-derived route and routing reason from the journal", () => {
    const harness = createHarness();
    const receipt = poolRoutedReceipt("fallback");
    const accepted = harness.service.requestRun({
      command: { ...requestCommand(), routingReceipt: receipt },
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;

    const rebuiltProjection = new AgentRunProjection();
    const rebuilt = new AgentRunPersistenceService({
      store: harness.store,
      projection: rebuiltProjection,
      uuid: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clock: () => later,
      connection: harness.connection,
    });
    rebuilt.rebuildFromJournal();
    const replayed = rebuiltProjection.getById(accepted.run.id);
    expect(replayed?.routingReceipt.poolRoute).toEqual(receipt.poolRoute);
    expect(replayed?.routingReceipt.selectedFallback).toEqual(receipt.selectedFallback);
    const summary = rebuilt.parentSummary(ids.thread);
    expect(summary[0]?.route).toMatchObject({
      poolDerived: true,
      selectionKind: "fallback",
      routingReason: poolFallbackReason,
      executionProviderInstanceId: ids.providerB,
      executionModelId: "claude-x",
    });
  });

  it("keeps a pool-waiting run Waiting with its original routing reason across restart", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: { ...requestCommand(), routingReceipt: poolRoutedReceipt("waiting") },
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    const waiting = harness.service.applyCommand({
      kind: "wait-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
      recoveryReason: "multi-model-pool-no-eligible-candidate",
    });
    expect(waiting.kind).toBe("run-updated");

    const restartedProjection = new AgentRunProjection();
    const restarted = new AgentRunPersistenceService({
      store: harness.store,
      projection: restartedProjection,
      uuid: () => "abababab-abab-4bab-8bab-abababababab",
      clock: () => later,
      connection: harness.connection,
    });
    restarted.rebuildFromJournal();
    const reconciled = restarted.reconcileAfterRestart();

    // The pool decision is immutable: restart must not rewrite the routing
    // reason or interrupt a run that never held execution state.
    expect(reconciled).toHaveLength(0);
    const preserved = restartedProjection.getById(accepted.run.id);
    expect(preserved?.lifecycleStatus).toBe("waiting");
    expect(preserved?.recoveryReason).toBe("multi-model-pool-no-eligible-candidate");
    expect(preserved?.routingReceipt.poolRoute?.decision.kind).toBe("waiting");
    expect(
      preserved?.routingReceipt.poolRoute?.decision.kind === "waiting"
        ? preserved.routingReceipt.poolRoute.decision.message
        : undefined,
    ).toBe(poolWaitingMessage);
  });

  it("carries a journaled usage limit on the waiting run, its summary row, and replay", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    harness.service.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    const running = harness.service.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    expect(running.kind).toBe("run-updated");
    if (running.kind !== "run-updated") return;

    const usageLimit = {
      kind: "exhausted" as const,
      resetsAt: "2026-08-01T11:00:00.000Z" as never,
    };
    const waited = harness.service.applyCommand({
      kind: "wait-agent-run",
      runId: accepted.run.id,
      expectedVersion: running.run.version as never,
      recoveryReason: "provider-usage-limit",
      usageLimit,
    });
    expect(waited.kind).toBe("run-updated");
    if (waited.kind !== "run-updated") return;
    expect(waited.run.lifecycleStatus).toBe("waiting");
    expect(waited.run.usageLimit).toEqual(usageLimit);

    const entry = harness.service
      .parentSummary(ids.thread)
      .find((candidate) => candidate.runId === accepted.run.id);
    expect(entry?.usageLimit).toEqual(usageLimit);

    const rebuiltProjection = new AgentRunProjection();
    const rebuilt = new AgentRunPersistenceService({
      store: harness.store,
      projection: rebuiltProjection,
      uuid: () => "abababab-abab-4bab-8bab-abababababab",
      clock: () => later,
      connection: harness.connection,
    });
    rebuilt.rebuildFromJournal();
    const replayed = rebuiltProjection.getById(accepted.run.id);
    expect(replayed?.usageLimit).toEqual(usageLimit);
    expect(replayed?.lifecycleStatus).toBe("waiting");
  });

  it("preserves a usage-limit wait across restart instead of interrupting it", () => {
    const harness = createHarness();
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    expect(accepted.kind).toBe("run-accepted");
    if (accepted.kind !== "run-accepted") return;
    harness.service.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    harness.service.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    const waited = harness.service.applyCommand({
      kind: "wait-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      recoveryReason: "provider-usage-limit",
      usageLimit: { kind: "exhausted", resetsAt: "2026-08-01T11:00:00.000Z" as never },
    });
    expect(waited.kind).toBe("run-updated");

    const restartedProjection = new AgentRunProjection();
    const restarted = new AgentRunPersistenceService({
      store: harness.store,
      projection: restartedProjection,
      uuid: () => "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      clock: () => later,
      connection: harness.connection,
    });
    restarted.rebuildFromJournal();
    const reconciled = restarted.reconcileAfterRestart();

    // A bounded wait on the provider's declared reset holds no live execution:
    // restarting must not rewrite it into an interruption.
    expect(reconciled).toHaveLength(0);
    const preserved = restartedProjection.getById(accepted.run.id);
    expect(preserved?.lifecycleStatus).toBe("waiting");
    expect(preserved?.usageLimit?.resetsAt).toBe("2026-08-01T11:00:00.000Z");
  });

  function usageLimitedRun(harness: ReturnType<typeof createHarness>) {
    const accepted = harness.service.requestRun({
      command: requestCommand(),
      parentAuthority,
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("run was not accepted");
    harness.service.applyCommand({
      kind: "start-agent-run",
      runId: accepted.run.id,
      expectedVersion: accepted.run.version as never,
    });
    harness.service.applyCommand({
      kind: "mark-agent-run-running",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 1) as never,
    });
    const waited = harness.service.applyCommand({
      kind: "wait-agent-run",
      runId: accepted.run.id,
      expectedVersion: (accepted.run.version + 2) as never,
      recoveryReason: "provider-usage-limit",
      usageLimit: { kind: "exhausted", resetsAt: "2026-08-01T11:00:00.000Z" as never },
    });
    if (waited.kind !== "run-updated") throw new Error("run did not wait");
    return waited.run;
  }

  it("arms the person's resume opt-in on the journaled limit facts alone", () => {
    const harness = createHarness();
    const run = usageLimitedRun(harness);

    const scheduled = harness.service.applyCommand({
      kind: "schedule-agent-run-usage-resume",
      runId: run.id,
      expectedVersion: run.version as never,
    });
    expect(scheduled.kind).toBe("run-updated");
    if (scheduled.kind !== "run-updated") return;
    expect(scheduled.run.usageResume?.status).toBe("scheduled");
    expect(scheduled.run.usageResume?.record).toMatchObject({
      threadId: String(run.id),
      providerInstanceId: ids.provider,
      resetsAt: "2026-08-01T11:00:00.000Z",
    });
    // The opt-in append is an event on the run's own aggregate, so the run's
    // version moved with it — a command against the pre-schedule version must
    // now stale-conflict rather than write over the armed opt-in.
    expect(scheduled.run.version).toBe(run.version + 1);
    expect(
      harness.service.applyCommand({
        kind: "cancel-agent-run",
        runId: run.id,
        expectedVersion: run.version as never,
        scope: "self",
      }),
    ).toMatchObject({ kind: "run-command-failed", reason: "stale-version" });
    const summary = harness.service
      .parentSummary(ids.thread)
      .find((entry) => entry.runId === run.id);
    expect(summary?.usageResume?.status).toBe("scheduled");
  });

  it("refuses to arm a resume the run's journaled facts do not support", () => {
    const harness = createHarness();
    const run = usageLimitedRun(harness);

    // Not waiting: a queued run has no limit to recover from.
    const accepted = harness.service.requestRun({
      command: {
        ...requestCommand(),
        requestId: decodeAgentRunRequestId("22222222-2222-4222-8222-222222222229"),
      },
      parentAuthority,
      confirmed: true,
    });
    if (accepted.kind !== "run-accepted") throw new Error("second run was not accepted");
    expect(
      harness.service.applyCommand({
        kind: "schedule-agent-run-usage-resume",
        runId: accepted.run.id,
        expectedVersion: accepted.run.version as never,
      }),
    ).toMatchObject({ kind: "run-command-failed", reason: "unsupported-transition" });

    // Double-schedule is refused: the opt-in is already armed.
    harness.service.applyCommand({
      kind: "schedule-agent-run-usage-resume",
      runId: run.id,
      expectedVersion: run.version as never,
    });
    const armed = harness.service.getById(run.id);
    expect(armed?.usageResume?.status).toBe("scheduled");
    if (armed === undefined) throw new Error("expected the armed run");
    expect(
      harness.service.applyCommand({
        kind: "schedule-agent-run-usage-resume",
        runId: run.id,
        expectedVersion: armed.version as never,
      }),
    ).toMatchObject({ kind: "run-command-failed", reason: "unsupported-transition" });
  });

  it("withdraws the opt-in when the person cancels it, leaving no armed state", () => {
    const harness = createHarness();
    const run = usageLimitedRun(harness);
    const scheduled = harness.service.applyCommand({
      kind: "schedule-agent-run-usage-resume",
      runId: run.id,
      expectedVersion: run.version as never,
    });
    expect(scheduled.kind).toBe("run-updated");
    if (scheduled.kind !== "run-updated") return;

    const cancelled = harness.service.applyCommand({
      kind: "cancel-agent-run-usage-resume",
      runId: run.id,
      expectedVersion: scheduled.run.version as never,
    });
    expect(cancelled.kind).toBe("run-updated");
    if (cancelled.kind !== "run-updated") return;
    expect(cancelled.run.usageResume).toBeUndefined();

    // A second cancel has no opt-in to withdraw.
    expect(
      harness.service.applyCommand({
        kind: "cancel-agent-run-usage-resume",
        runId: run.id,
        expectedVersion: cancelled.run.version as never,
      }),
    ).toMatchObject({ kind: "run-command-failed", reason: "unsupported-transition" });

    // Replay: withdrawing is journaled, so a rebuilt run reports nothing armed.
    const rebuiltProjection = new AgentRunProjection();
    const rebuilt = new AgentRunPersistenceService({
      store: harness.store,
      projection: rebuiltProjection,
      uuid: () => "dededede-dede-4ded-8ded-dedededede01",
      clock: () => later,
      connection: harness.connection,
    });
    rebuilt.rebuildFromJournal();
    expect(rebuiltProjection.getById(run.id)?.usageResume).toBeUndefined();
  });

  it("replays an armed opt-in and folds a journaled settle back into the run", () => {
    const harness = createHarness();
    const run = usageLimitedRun(harness);
    const scheduled = harness.service.applyCommand({
      kind: "schedule-agent-run-usage-resume",
      runId: run.id,
      expectedVersion: run.version as never,
    });
    expect(scheduled.kind).toBe("run-updated");
    if (scheduled.kind !== "run-updated") return;

    // A restart rebuilds the armed opt-in from the run's own aggregate events.
    const restartedProjection = new AgentRunProjection();
    const restarted = new AgentRunPersistenceService({
      store: harness.store,
      projection: restartedProjection,
      uuid: () => "efefefef-efef-4fef-8fef-efefefefef01",
      clock: () => later,
      connection: harness.connection,
    });
    restarted.rebuildFromJournal();
    const replayed = restartedProjection.getById(run.id);
    expect(replayed?.usageResume?.status).toBe("scheduled");
    expect(replayed?.usageResume?.record.resetsAt).toBe("2026-08-01T11:00:00.000Z");
    expect(replayed?.version).toBe(scheduled.run.version);

    // The scheduler settles straight to the journal; the fold lands the
    // outcome on the run rather than leaving it reporting `scheduled`.
    const record = replayed?.usageResume?.record;
    if (record === undefined) throw new Error("expected the armed record");
    harness.journal.append({
      aggregate: { aggregateType: "agent-run", aggregateId: String(run.id) },
      expectedVersion: scheduled.run.version,
      events: [
        {
          eventId: "12121212-1212-4212-8212-121212121212",
          eventName: USAGE_RESUME_SETTLED,
          eventVersion: 1,
          correlationId: "34343434-3434-4344-8434-343434343434",
          actor,
          occurredAt: later,
          payload: { resume: record, outcome: "dispatched" },
        },
      ],
    });
    restarted.applyUsageResumeSettled({
      resume: record,
      outcome: "dispatched",
    });
    const settled = restartedProjection.getById(run.id);
    expect(settled?.usageResume?.status).toBe("dispatched");
    // The settle was the aggregate head the fold read back.
    expect(settled?.version).toBe(scheduled.run.version + 1);
  });
});
