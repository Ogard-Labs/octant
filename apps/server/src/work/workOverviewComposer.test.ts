import {
  decodeWorkRequest,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeWorkflow,
  decodeProjectId as decodeWorkProjectId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decodeContentSha256 } from "@octant/contracts/previews";
import {
  decodeWorkArtifactId,
  decodeWorkArtifactMutationFrame,
  decodeWorkArtifactVersionId,
  decodeWorkMutationRequestId,
  type WorkArtifactMutationFrame,
} from "@octant/contracts/work-artifacts";
import { decodeProjectId } from "@octant/contracts/projects";
import { WorkArtifactProjection } from "./workArtifactProjection";
import { composeWorkOverviewProjection } from "./workOverviewComposer";
import "./workFormatAdapters";

const ids = {
  artifact: decodeWorkArtifactId("11111111-1111-4111-8111-111111111111"),
  version: decodeWorkArtifactVersionId("22222222-2222-4222-8222-222222222222"),
  request: decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333333"),
  project: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  other: decodeProjectId("55555555-5555-4555-8555-555555555555"),
  actor: "66666666-6666-4666-8666-666666666666",
} as const;

const occurredAt = "2026-07-23T12:00:00.000Z";
const actor = { kind: "local-user" as const, actorId: ids.actor };

describe("composeWorkOverviewProjection", () => {
  it("composes files, versions, and validation from the artifact projection", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(ids.project, "Brief.docx", "docx"));

    const overview = composeWorkOverviewProjection(projection, ids.project);
    expect(overview.filesAndArtifacts).toEqual([
      { id: String(ids.artifact), label: "Brief.docx", detail: "DOCX" },
    ]);
    expect(overview.versions[0]?.label).toBe("v1 · Brief.docx");
    expect(overview.validation[0]?.label).toMatch(/DOCX/);
    expect(overview.workflowsAndThreads).toEqual([]);
    expect(JSON.stringify(overview)).not.toMatch(/[/\\]|file:/i);
  });

  it("scopes composed items to the requested Project", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(ids.other, "Other.md", "markdown"));

    const overview = composeWorkOverviewProjection(projection, ids.project);
    expect(overview.filesAndArtifacts).toEqual([]);
    expect(overview.versions).toEqual([]);
  });

  it("composes active Work threads from the Work thread spine", () => {
    const threadId = decodeWorkThreadId("88888888-8888-4888-8888-888888888888");
    const overview = composeWorkOverviewProjection(new WorkArtifactProjection(), ids.project, [
      decodeWorkThread({
        id: threadId,
        projectId: decodeWorkProjectId(String(ids.project)),
        title: "Prepare the brief",
        lifecycle: "active",
        providerInstanceId: "99999999-9999-4999-8999-999999999999",
        modelId: "model-a",
        version: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }),
    ]);

    expect(overview.workflowsAndThreads).toEqual([
      { id: String(threadId), label: "Prepare the brief", detail: "Active thread" },
    ]);
    expect(overview.approvals).toEqual([]);
  });

  it("distinguishes a thread backed by a real active workflow from an ordinary thread", () => {
    const workflowThreadId = decodeWorkThreadId("88888888-8888-4888-8888-888888888888");
    const ordinaryThreadId = decodeWorkThreadId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const workflowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const threads = [
      decodeWorkThread({
        id: workflowThreadId,
        projectId: decodeWorkProjectId(String(ids.project)),
        title: "Prepare the brief",
        lifecycle: "active",
        providerInstanceId: "99999999-9999-4999-8999-999999999999",
        modelId: "model-a",
        version: 1,
        createdAt: occurredAt,
        updatedAt: "2026-07-23T12:02:00.000Z",
      }),
      decodeWorkThread({
        id: ordinaryThreadId,
        projectId: decodeWorkProjectId(String(ids.project)),
        title: "Ask a quick question",
        lifecycle: "active",
        providerInstanceId: "99999999-9999-4999-8999-999999999999",
        modelId: "model-a",
        version: 1,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }),
    ];
    const workflows = [
      decodeWorkflow({
        workflowId,
        projectId: ids.project,
        relatedThreadId: workflowThreadId,
        label: "Prepare the brief",
        lifecycle: "active" as const,
        startedAt: occurredAt,
        updatedAt: occurredAt,
        version: 1,
      }),
    ];

    const overview = composeWorkOverviewProjection(
      new WorkArtifactProjection(),
      ids.project,
      threads,
      workflows,
    );

    expect(overview.workflowsAndThreads).toEqual([
      { id: String(workflowThreadId), label: "Prepare the brief", detail: "Active workflow" },
      { id: String(ordinaryThreadId), label: "Ask a quick question", detail: "Active thread" },
    ]);
  });

  it("does not surface a completed workflow's thread as a workflow item once its lifecycle-driving thread is no longer active", () => {
    const threadId = decodeWorkThreadId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const thread = decodeWorkThread({
      id: threadId,
      projectId: decodeWorkProjectId(String(ids.project)),
      title: "Prepare the brief",
      lifecycle: "archived",
      providerInstanceId: "99999999-9999-4999-8999-999999999999",
      modelId: "model-a",
      version: 2,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    const workflows = [
      decodeWorkflow({
        workflowId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        projectId: ids.project,
        relatedThreadId: threadId,
        label: "Prepare the brief",
        lifecycle: "completed" as const,
        startedAt: occurredAt,
        updatedAt: occurredAt,
        version: 2,
      }),
    ];

    const overview = composeWorkOverviewProjection(
      new WorkArtifactProjection(),
      ids.project,
      [thread],
      workflows,
    );

    expect(overview.workflowsAndThreads).toEqual([]);
  });

  it("does not surface an active thread after the user confirmed its workflow complete", () => {
    const threadId = decodeWorkThreadId("cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd");
    const thread = decodeWorkThread({
      id: threadId,
      projectId: decodeWorkProjectId(String(ids.project)),
      title: "Completed brief",
      lifecycle: "active",
      completionConfirmed: true,
      providerInstanceId: "99999999-9999-4999-8999-999999999999",
      modelId: "model-a",
      version: 2,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    const workflow = decodeWorkflow({
      workflowId: "dededede-dede-4ede-8ede-dededededede",
      projectId: ids.project,
      relatedThreadId: threadId,
      label: "Completed brief",
      lifecycle: "completed" as const,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      version: 2,
    });

    const overview = composeWorkOverviewProjection(
      new WorkArtifactProjection(),
      ids.project,
      [thread],
      [workflow],
    );

    expect(overview.workflowsAndThreads).toEqual([]);
  });

  it("retains an archived thread when it still owns an active workflow", () => {
    const threadId = decodeWorkThreadId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const thread = decodeWorkThread({
      id: threadId,
      projectId: decodeWorkProjectId(String(ids.project)),
      title: "Paused brief",
      lifecycle: "archived",
      providerInstanceId: "99999999-9999-4999-8999-999999999999",
      modelId: "model-a",
      version: 2,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    const workflow = decodeWorkflow({
      workflowId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      projectId: ids.project,
      relatedThreadId: threadId,
      label: "Paused brief",
      lifecycle: "active" as const,
      startedAt: occurredAt,
      updatedAt: occurredAt,
      version: 1,
    });

    const overview = composeWorkOverviewProjection(
      new WorkArtifactProjection(),
      ids.project,
      [thread],
      [workflow],
    );

    expect(overview.workflowsAndThreads).toEqual([
      { id: String(threadId), label: "Paused brief", detail: "Active workflow" },
    ]);
  });

  it("preserves workflow membership supplied outside the bounded workflow slice", () => {
    const threadId = decodeWorkThreadId("12121212-1212-4121-8121-121212121212");
    const thread = decodeWorkThread({
      id: threadId,
      projectId: decodeWorkProjectId(String(ids.project)),
      title: "Older workflow",
      lifecycle: "active",
      providerInstanceId: "99999999-9999-4999-8999-999999999999",
      modelId: "model-a",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });

    const overview = composeWorkOverviewProjection(
      new WorkArtifactProjection(),
      ids.project,
      [thread],
      [],
      (id) => id === String(threadId),
    );

    expect(overview.workflowsAndThreads).toEqual([
      { id: String(threadId), label: "Older workflow", detail: "Active workflow" },
    ]);
  });

  it("uses unbounded workflow membership for archived threads before filtering them", () => {
    const threadId = decodeWorkThreadId("13131313-1313-4131-8131-131313131313");
    const thread = decodeWorkThread({
      id: threadId,
      projectId: decodeWorkProjectId(String(ids.project)),
      title: "Older paused workflow",
      lifecycle: "archived",
      providerInstanceId: "99999999-9999-4999-8999-999999999999",
      modelId: "model-a",
      version: 2,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });

    const overview = composeWorkOverviewProjection(
      new WorkArtifactProjection(),
      ids.project,
      [thread],
      [],
      () => true,
    );

    expect(overview.workflowsAndThreads).toEqual([
      { id: String(threadId), label: "Older paused workflow", detail: "Active workflow" },
    ]);
  });

  it("composes pending Work requests into approvals without leaking provider payloads", () => {
    const approvalRequest = decodeWorkRequest({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: ids.project,
      threadId: "88888888-8888-4888-8888-888888888888",
      providerInstanceId: "99999999-9999-4999-8999-999999999999",
      providerSessionId: "99999999-9999-4999-8999-999999999998",
      providerRequestId: "provider-req-1",
      detail: {
        kind: "approval",
        action: "Run shell command",
        description: "Approve running the build script",
      },
      status: "pending",
      requestedAt: occurredAt,
      version: 1,
    });
    const inputRequest = decodeWorkRequest({
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      projectId: ids.other,
      threadId: "88888888-8888-4888-8888-888888888888",
      providerInstanceId: "99999999-9999-4999-8999-999999999999",
      providerSessionId: "99999999-9999-4999-8999-999999999997",
      providerRequestId: "provider-req-2",
      detail: {
        kind: "user-input",
        prompt: "What is the target branch name?",
        options: [],
      },
      status: "pending",
      requestedAt: occurredAt,
      version: 1,
    });

    const overview = composeWorkOverviewProjection(
      new WorkArtifactProjection(),
      ids.project,
      [],
      [],
      undefined,
      [approvalRequest, inputRequest],
    );

    expect(overview.approvals).toEqual([
      {
        id: String(approvalRequest.requestId),
        label: "Run shell command",
        detail: "Approval requested",
      },
    ]);
    expect(JSON.stringify(overview)).not.toMatch(/provider-req|9999-4999-8999|file:|https?:/i);
  });

  it("composes exports from recorded handoff provenance instead of the artifact's latest mutation", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(ids.project, "Brief.docx", "docx"));
    projection.apply(
      decodeWorkArtifactMutationFrame({
        requestId: decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333334"),
        projectId: ids.project,
        sequence: 2,
        occurredAt: "2026-07-23T12:01:00.000Z",
        outcome: {
          kind: "exported",
          handoff: {
            requestId: decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333334"),
            artifactId: ids.artifact,
            exportFormat: "pdf",
            handoffKind: "external-handoff",
            exportRef: "opaque-export-ref",
            producedAt: "2026-07-23T12:01:00.000Z",
          },
        },
      }),
    );

    const overview = composeWorkOverviewProjection(projection, ids.project);

    expect(overview.exports).toEqual([
      {
        id: `${String(ids.artifact)}:export:2`,
        label: "Brief.docx",
        detail: "PDF · External app handoff",
      },
    ]);
  });
});

function createdFrame(
  projectId: typeof ids.project,
  displayName: string,
  format: "docx" | "markdown",
): WorkArtifactMutationFrame {
  const sourceVersion = {
    contentSha256: decodeContentSha256(
      createHash("sha256").update(new Uint8Array(12)).digest("hex"),
    ),
    byteSize: 12,
    observedAt: occurredAt,
  };
  return decodeWorkArtifactMutationFrame({
    requestId: ids.request,
    projectId,
    sequence: 1,
    occurredAt,
    outcome: {
      kind: "created",
      artifact: {
        artifactId: ids.artifact,
        projectId,
        format,
        artifactRef: "opaque-token-1",
        displayName,
        createdAt: occurredAt,
      },
      version: {
        versionId: ids.version,
        artifactId: ids.artifact,
        projectId,
        format,
        sourceVersion,
        createdBy: actor,
        createdAt: occurredAt,
        sequence: 1,
      },
      previewTarget: {
        targetId: "77777777-7777-4777-8777-777777777777",
        projectId,
        hostId: "88888888-8888-4888-8888-888888888888",
        kind: "artifact-version",
        opaqueRef: "opaque-token-1",
        displayName,
      },
    },
  });
}
