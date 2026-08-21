import type { WorkspaceTab } from "@octant/contracts/shell";
import { defaultEnvironmentPresentationState } from "@octant/domain/shell-policy";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../code/CodeWorkspaceTab", () => ({
  default: () => {
    throw new Error("chunk unavailable");
  },
}));

import { WorkspaceView, type WorkspaceViewProps } from "./WorkspaceView";
import { createCodeThreadControllers } from "../code/codeThreadControllers";
import { stubSurfaceDragHandle } from "../App.test-fixtures";

const ids = {
  pane: "20000000-0000-4000-8000-000000000001",
  node: "20000000-0000-4000-8000-000000000002",
  tab: "20000000-0000-4000-8000-000000000003",
  thread: "20000000-0000-4000-8000-000000000004",
  window: "20000000-0000-4000-8000-000000000005",
} as const;

describe("WorkspaceView Code chunk failure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the workspace usable with an actionable unavailable state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<WorkspaceView {...props()} />);

    expect(
      await screen.findByRole("heading", { name: "Code surface unavailable" }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(screen.getByText("Reload Octant to retry this Code surface.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload Octant" })).toBeVisible();
  });
});

function props(): WorkspaceViewProps {
  const codeControllers = createCodeThreadControllers();
  codeControllers.publish(ids.thread as never, {} as never);
  const tab = {
    id: ids.tab,
    kind: "code-overview",
    mode: "code",
    threadId: ids.thread,
    title: "Overview",
  } as WorkspaceTab;
  const layout = {
    kind: "pane",
    nodeId: ids.node,
    paneId: ids.pane,
    surface: tab,
  } as const;
  return {
    availabilityByProject: new Map(),
    chatClient: {} as never,
    chatController: {} as never,
    chatReadCursorStore: {} as never,
    codeController: {} as never,
    codeControllers,
    workPromotionController: {
      pendingProposals: [],
      availableArtifactRefs: [],
      deliveryTargetsByProject: new Map(),
      proposing: false,
      reload: vi.fn(async () => undefined),
      propose: vi.fn(async () => undefined),
      approve: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => false),
    },
    codeProviderChoices: [],
    drag: stubSurfaceDragHandle(),
    layout: layout as never,
    mode: "code",
    onActivatePane: vi.fn(),
    onArchiveProject: vi.fn(),
    onClearFocus: vi.fn(),
    onClosePane: vi.fn(),
    onCreateChat: vi.fn(),
    onCommitResize: vi.fn(),
    onFocus: vi.fn(),
    onOpenCodeThread: vi.fn(),
    onOpenCodeSurface: vi.fn(),
    onPreviewResize: vi.fn(),
    onRelinkProject: vi.fn(),
    onRenameProject: vi.fn(),
    onSplitPane: vi.fn(),
    projects: [],
    providerController: {} as never,
    workspace: {
      windowId: ids.window,
      activeMode: "code",
      layouts: { chat: layout, work: layout, code: layout },
      activePaneIds: { chat: ids.pane, work: ids.pane, code: ids.pane },
      contextByMode: {
        chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
        work: { host: "local", mode: "work", projectId: null, boundRoot: null },
        code: { host: "local", mode: "code", projectId: null, boundRoot: null },
      },
      version: 1,
    } as never,
    environmentPresentation: defaultEnvironmentPresentationState(),
    onSetEnvironmentPresentation: vi.fn(),
    projectServerUrl: "http://localhost:0",
    projectWindowCapability: "test-capability",
  };
}
