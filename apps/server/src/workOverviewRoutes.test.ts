import {
  decodeWorkRequest,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeWorkflow,
  decodeProjectId,
  decodeWindowId,
  type WorkRequest,
  type Workflow,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { decodeContentSha256 } from "@octant/contracts/previews";
import {
  decodeWorkArtifactId,
  decodeWorkArtifactMutationFrame,
  decodeWorkArtifactVersionId,
  decodeWorkMutationRequestId,
} from "@octant/contracts/work-artifacts";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createWorkOverviewRouteHandler } from "./workOverviewRoutes";
import { WorkArtifactProjection } from "./work/workArtifactProjection";
import "./work/workFormatAdapters";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000802");

describe("Work overview routes", () => {
  it("returns a composed overview projection for an accessible Work Project", async () => {
    const artifacts = new WorkArtifactProjection();
    artifacts.apply(createdFrame());
    const route = createRoute(artifacts, {
      threads: [
        decodeWorkThread({
          id: decodeWorkThreadId("11111111-1111-4111-8111-111111111119"),
          projectId,
          title: "Prepare the brief",
          lifecycle: "active",
          providerInstanceId: "11111111-1111-4111-8111-111111111120",
          modelId: "model-a",
          version: 1,
          createdAt: "2026-07-23T12:00:00.000Z",
          updatedAt: "2026-07-23T12:05:00.000Z",
        }),
      ],
    });

    const response = await route(
      new Request(`http://127.0.0.1/api/work/overview?projectId=${projectId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.projectId).toBe(projectId);
    expect(body.filesAndArtifacts).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", label: "Brief.docx", detail: "DOCX" },
    ]);
    expect(body.workflowsAndThreads).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111119",
        label: "Prepare the brief",
        detail: "Active thread",
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/[/\\]|file:/i);
  });

  it("distinguishes a thread backed by an active workflow using the workflow projection scoped to the exact Project", async () => {
    const artifacts = new WorkArtifactProjection();
    const threadId = decodeWorkThreadId("11111111-1111-4111-8111-111111111119");
    const route = createRoute(artifacts, {
      threads: [
        decodeWorkThread({
          id: threadId,
          projectId,
          title: "Prepare the brief",
          lifecycle: "active",
          providerInstanceId: "11111111-1111-4111-8111-111111111120",
          modelId: "model-a",
          version: 1,
          createdAt: "2026-07-23T12:00:00.000Z",
          updatedAt: "2026-07-23T12:05:00.000Z",
        }),
      ],
      workflows: {
        listByProject: vi.fn().mockReturnValue([
          decodeWorkflow({
            workflowId: "22222222-2222-4222-8222-222222222299",
            projectId,
            relatedThreadId: threadId,
            label: "Prepare the brief",
            lifecycle: "active",
            startedAt: "2026-07-23T12:00:00.000Z",
            updatedAt: "2026-07-23T12:05:00.000Z",
            version: 1,
          }),
        ]),
      },
    });

    const response = await route(
      new Request(`http://127.0.0.1/api/work/overview?projectId=${projectId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    const body = await response?.json();
    expect(body.workflowsAndThreads).toEqual([
      { id: String(threadId), label: "Prepare the brief", detail: "Active workflow" },
    ]);
  });

  it("composes pending Work requests into approvals", async () => {
    const artifacts = new WorkArtifactProjection();
    const pending: WorkRequest = decodeWorkRequest({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId,
      threadId: "11111111-1111-4111-8111-111111111119",
      providerInstanceId: "11111111-1111-4111-8111-111111111120",
      providerSessionId: "11111111-1111-4111-8111-111111111121",
      providerRequestId: "provider-req-1",
      detail: {
        kind: "approval",
        action: "Run shell command",
        description: "Approve running the build script",
      },
      status: "pending",
      requestedAt: "2026-07-23T12:00:00.000Z",
      version: 1,
    });
    const route = createRoute(artifacts, { pendingRequests: [pending] });

    const response = await route(
      new Request(`http://127.0.0.1/api/work/overview?projectId=${projectId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.approvals).toEqual([
      { id: String(pending.requestId), label: "Run shell command", detail: "Approval requested" },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/provider-req|1120|file:/i);
  });

  it("rejects missing capability and forged window identity", async () => {
    const route = createRoute(new WorkArtifactProjection());
    expect(
      (await route(new Request(`http://127.0.0.1/api/work/overview?projectId=${projectId}`)))
        ?.status,
    ).toBe(401);
    expect(
      (
        await route(
          new Request(
            `http://127.0.0.1/api/work/overview?projectId=${projectId}&windowId=${windowId}`,
            { headers: { "x-octant-window-capability": capability } },
          ),
        )
      )?.status,
    ).toBe(400);
  });

  it("returns 404 when the Work Project is not accessible to the window", async () => {
    const route = createRoute(new WorkArtifactProjection(), { accessible: false });
    const response = await route(
      new Request(`http://127.0.0.1/api/work/overview?projectId=${projectId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(404);
  });
});

function createRoute(
  artifacts: WorkArtifactProjection,
  options: {
    readonly accessible?: boolean;
    readonly threads?: ReadonlyArray<ReturnType<typeof decodeWorkThread>>;
    readonly workflows?: {
      readonly listByProject: (projectId: unknown) => ReadonlyArray<Workflow>;
    };
    readonly pendingRequests?: ReadonlyArray<WorkRequest>;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createWorkOverviewRouteHandler({
    artifacts,
    threads: {
      bootstrap: vi.fn().mockResolvedValue({
        threads: options.threads ?? [],
      }),
    },
    workflows: options.workflows ?? { listByProject: () => [] },
    projects: {
      bootstrap: vi.fn().mockResolvedValue({
        active:
          options.accessible === false
            ? []
            : [
                {
                  id: projectId,
                  name: "Knowledge",
                  type: "work",
                  lifecycle: "active",
                },
              ],
        archived: [],
      }),
    },
    requests: {
      listPending: vi.fn().mockReturnValue(options.pendingRequests ?? []),
    },
    windowAuthorityStore: store,
    now: () => 1,
  });
}

function createdFrame() {
  const occurredAt = "2026-07-23T12:00:00.000Z";
  const actor = { kind: "local-user" as const, actorId: "66666666-6666-4666-8666-666666666666" };
  const sourceVersion = {
    contentSha256: decodeContentSha256(
      createHash("sha256").update(new Uint8Array(12)).digest("hex"),
    ),
    byteSize: 12,
    observedAt: occurredAt,
  };
  return decodeWorkArtifactMutationFrame({
    requestId: decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333333"),
    projectId,
    sequence: 1,
    occurredAt,
    outcome: {
      kind: "created",
      artifact: {
        artifactId: decodeWorkArtifactId("11111111-1111-4111-8111-111111111111"),
        projectId,
        format: "docx",
        artifactRef: "opaque-token-1",
        displayName: "Brief.docx",
        createdAt: occurredAt,
      },
      version: {
        versionId: decodeWorkArtifactVersionId("22222222-2222-4222-8222-222222222222"),
        artifactId: decodeWorkArtifactId("11111111-1111-4111-8111-111111111111"),
        projectId,
        format: "docx",
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
        displayName: "Brief.docx",
      },
    },
  });
}
