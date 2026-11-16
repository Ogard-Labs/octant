// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { decodeCodeThread } from "@octant/contracts";
import { ThemeProvider } from "../../design-system/theme";
import { CoordinatorProposalsPanel } from "./CoordinatorProposalsPanel";
vi.mock("react-native", () => vi.importActual("react-native-web"));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const PROJECT = "20000000-0000-4000-8000-000000000001";
const COORDINATOR = "84000000-0000-4000-8000-000000000009";
const NOW = "2026-11-10T00:00:00.000Z";
const coordinator = decodeCodeThread({
  id: COORDINATOR,
  projectId: PROJECT,
  bindingRevisionId: "70000000-0000-4000-8000-000000000001",
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: "30000000-0000-4000-8000-000000000001",
  title: "Backlog",
  lifecycle: "active",
  coordinator: true,
  providerInstanceId: "60000000-0000-4000-8000-000000000001",
  modelId: "model-a",
  executionPolicy: "auto-accept-edits",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/coordinate",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "local-implementation",
    confirmedAt: NOW,
  },
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});
const PENDING = {
  proposal: {
    id: "70000000-0000-4000-8000-000000000101",
    projectId: PROJECT,
    plannerThreadId: COORDINATOR,
    fromCoordinator: true,
    title: "Fix the flaky test",
    intent: "Find and fix it.",
    status: "pending",
    proposedAt: NOW,
    workerOptions: { executionPolicy: "approval-gated" },
  },
  proposalVersion: 1,
};

async function renderPanel(transport: MobileRemoteTransport, actsAsHostPerson: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(CoordinatorProposalsPanel, {
          transport,
          thread: coordinator,
          actsAsHostPerson,
        }),
      }),
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("a coordinator's proposals on the phone", () => {
  it("shows a session the person did not pair a pending worker with its requested level and no decision", async () => {
    const transport: MobileRemoteTransport = {
      hostId: "host-1",
      authenticatedFetch: (async () =>
        Response.json({
          designation: { kind: "none", projectId: PROJECT, updatedAt: NOW },
          designationVersion: 0,
          proposals: [PENDING],
        })) as MobileRemoteTransport["authenticatedFetch"],
    };
    const container = await renderPanel(transport, false);
    const text = container.textContent ?? "";
    expect(text).toContain("Fix the flaky test");
    expect(text).toContain("Requested level: Ask first or lower");
    expect(text).toContain("Approve at a window on this computer.");
    expect(container.querySelectorAll("[role=button]")).toHaveLength(0);
  });

  it("approves a worker as it was asked for from a phone the person paired, then sends its request", async () => {
    const host = pairedHost("running");
    const container = await renderPanel(host.transport, true);
    expect(container.textContent).not.toContain("Approve at a window on this computer.");
    await approve(container);

    const confirm = host.calls.find((call) => call.path === "/api/code/planner/proposals/commands");
    expect(JSON.parse(String(confirm?.body))).toMatchObject({
      kind: "confirm-planner-work-proposal",
      proposalId: PENDING.proposal.id,
      expectedVersion: 1,
      creation: {
        kind: "create-managed-code-thread",
        projectId: PROJECT,
        providerInstanceId: coordinator.providerInstanceId,
        modelId: "model-a",
        executionPolicy: "approval-gated",
        sourceBranch: "main",
      },
    });
    // The worker's first message is the proposal's request, staged and started.
    const evidence = host.calls.find((call) => call.path === "/api/code/evidence");
    expect(evidence?.body).toBe("Find and fix it.");
    expect(host.startedThreadId()).toBe(host.createdThreadId());
    expect(container.textContent).toContain("Worker approved and started.");
  });

  it("says the worker's first turn did not start when the host answers it failed", async () => {
    const host = pairedHost("failed");
    const container = await renderPanel(host.transport, true);
    await approve(container);

    expect(host.startedThreadId()).toBe(host.createdThreadId());
    expect(container.textContent).not.toContain("Worker approved and started.");
    expect(container.textContent).toContain("Open it to retry.");
  });
});

async function approve(container: HTMLElement) {
  const button = [...container.querySelectorAll<HTMLElement>("[role=button]")].find(
    (candidate) => candidate.textContent === "Approve and start",
  );
  await act(async () => button?.click());
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** A host that creates the worker and answers its first turn's start with `turnState`. */
function pairedHost(turnState: "running" | "failed") {
  const calls: Array<{ readonly method: string; readonly path: string; readonly body?: string }> =
    [];
  let created: Record<string, unknown> | undefined;
  let startedThreadId: string | undefined;
  const checkout = {
    id: coordinator.checkoutId,
    repositoryId: coordinator.repositoryId,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "main", oid: "a".repeat(40) },
    observedAt: NOW,
  };
  const transport: MobileRemoteTransport = {
    hostId: "host-1",
    authenticatedFetch: (async (request: { method: string; path: string; body?: string }) => {
      calls.push(request);
      const body =
        request.body === undefined || request.path === "/api/code/evidence"
          ? undefined
          : JSON.parse(String(request.body));
      if (request.path.startsWith("/api/code/planner/") && request.method === "GET")
        return Response.json({
          designation: { kind: "none", projectId: PROJECT, updatedAt: NOW },
          designationVersion: 0,
          proposals: created === undefined ? [PENDING] : [],
        });
      if (request.path === "/api/code/planner/proposals/commands") {
        created = { ...coordinator, id: body.creation.threadId, coordinator: undefined };
        return Response.json({
          status: "confirmed",
          proposal: {
            ...PENDING.proposal,
            status: "confirmed",
            resolvedAt: NOW,
            createdThreadId: body.creation.threadId,
          },
          creation: { kind: "thread-created", thread: created },
        });
      }
      if (request.path === "/api/code/bootstrap")
        return Response.json({
          settings: {
            defaultExecutionPolicy: "approval-gated",
            defaultPermissionPersistence: "current-session",
            requireGitRepository: true,
            defaultDiffLayout: "unified",
            updatedAt: NOW,
            version: 1,
          },
          threads: created === undefined ? [] : [created],
          checkouts: [checkout],
          activity: [],
        });
      if (request.path === "/api/code/evidence")
        return Response.json({
          contentId: "60000000-0000-4000-8000-000000000001",
          digest: "a".repeat(64),
          byteLength: 16,
        });
      if (request.path === "/api/code/commands" && body.kind === "prepare-code-project-checkout")
        return Response.json({
          kind: "checkout-prepared",
          bindingRevisionId: "70000000-0000-4000-8000-000000000002",
          checkout,
        });
      if (request.path === "/api/code/commands" && body.kind === "start-provider-turn") {
        startedThreadId = body.threadId;
        return Response.json({
          kind: "provider-turn-state",
          operationId: body.operationId,
          state: turnState,
        });
      }
      return Response.json({}, { status: 503 });
    }) as MobileRemoteTransport["authenticatedFetch"],
  };
  return {
    transport,
    calls,
    createdThreadId: () => created?.["id"],
    startedThreadId: () => startedThreadId,
  };
}
