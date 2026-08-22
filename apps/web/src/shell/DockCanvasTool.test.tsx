import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DockCanvasTool } from "./DockCanvasTool";

vi.mock("../canvas/CanvasWorkspaceTab", () => ({
  CanvasWorkspaceTab: (props: {
    readonly tab: { readonly canvasId: string; readonly title: string };
  }) => <p>{`canvas:${props.tab.canvasId}:${props.tab.title}`}</p>,
}));

const threadId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const canvasId = "20000000-0000-4000-8000-000000000002";

function card(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    kind: "canvas-reference-card" as const,
    cardId: "20000000-0000-4000-8000-000000000001",
    canvasId,
    versionId: "20000000-0000-4000-8000-000000000003",
    title: "Quarterly summary",
    scope: {
      hostId: "local",
      mode: "chat" as const,
      workspace: { kind: "chat-virtual" as const, projectId },
    },
    originThreadId: threadId,
    status: "ready" as const,
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan" as const,
      permissionPersistence: "current-session" as const,
    },
    actorId: "99999999-9999-4999-8999-999999999999",
    providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelId: "octant-test-model",
    createdAt: "2026-08-01T21:00:00.000Z",
    actionCount: 0,
    ...overrides,
  };
}

describe("the dock Canvas tool", () => {
  it("opens the existing authorized Canvas without a create form", async () => {
    const create = vi.fn();
    render(
      <DockCanvasTool
        client={
          {
            create,
            threadReferenceCards: vi.fn(async () => ({
              mode: "chat",
              threadId,
              projectId,
              cards: [card()],
            })),
          } as never
        }
        mode="chat"
        projectId={projectId as never}
        threadId={threadId}
      />,
    );

    expect(await screen.findByText(`canvas:${canvasId}:Quarterly summary`)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Create Canvas" })).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("lists authorized documents when the thread owns more than one", async () => {
    const user = userEvent.setup();
    const secondId = "20000000-0000-4000-8000-000000000009";
    render(
      <DockCanvasTool
        client={
          {
            threadReferenceCards: vi.fn(async () => ({
              mode: "chat",
              threadId,
              projectId,
              cards: [card(), card({ canvasId: secondId, title: "Roadmap", cardId: secondId })],
            })),
          } as never
        }
        mode="chat"
        projectId={projectId as never}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("button", { name: "Open Quarterly summary" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Roadmap" }));
    expect(screen.getByText(`canvas:${secondId}:Roadmap`)).toBeVisible();
  });

  it("does not copy an unauthorized Canvas into the dock", async () => {
    render(
      <DockCanvasTool
        client={
          {
            threadReferenceCards: vi.fn(async () => ({
              mode: "chat",
              threadId,
              projectId,
              cards: [card({ status: "unauthorized" })],
            })),
          } as never
        }
        mode="chat"
        projectId={projectId as never}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Canvas is unavailable" })).toBeVisible();
    expect(screen.queryByText(/canvas:/)).not.toBeInTheDocument();
  });
});
