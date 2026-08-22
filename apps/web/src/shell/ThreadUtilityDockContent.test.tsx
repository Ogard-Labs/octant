import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadUtilityDockContent } from "./ThreadUtilityDockContent";

vi.mock("../code/CodeWorkspaceTab", () => ({
  default: (props: { readonly tab: { readonly kind: string; readonly projectPath?: string } }) => (
    <p>{`${props.tab.kind}:${props.tab.projectPath ?? "none"}`}</p>
  ),
}));

vi.mock("../browser/BrowserWorkspace", () => ({
  BrowserWorkspace: (props: { readonly tab: { readonly threadId?: string } }) => (
    <p>{`browser:${props.tab.threadId ?? "none"}`}</p>
  ),
}));

const threadId = "10000000-0000-4000-8000-000000000001";
const codeController = {
  activeView: {
    thread: { id: threadId },
    checkout: { id: "20000000-0000-4000-8000-000000000002" },
  },
  client: {},
} as never;

function props() {
  return {
    appleProjectPath: "App/App.xcodeproj",
    appleToolchainClient: {} as never,
    chatClient: {} as never,
    chatReadCursorStore: { read: vi.fn(), write: vi.fn() } as never,
    codeController,
    onOpenFile: vi.fn(),
    onSidecarOpened: vi.fn(),
    subject: { mode: "code" as const, threadId },
    surface: "ios-simulator" as const,
  };
}

describe("thread utility dock content", () => {
  it("opens iOS Simulator through the real Apple workbench surface", async () => {
    render(<ThreadUtilityDockContent {...props()} />);
    expect(await screen.findByText("apple-workbench:App/App.xcodeproj")).toBeVisible();
  });

  it("states why iOS Simulator is unavailable when the thread has no Xcode project", () => {
    const { appleProjectPath: _missing, ...withoutProject } = props();
    render(<ThreadUtilityDockContent {...withoutProject} />);
    expect(screen.getByRole("heading", { name: "iOS Simulator is unavailable" })).toBeVisible();
  });

  it("renders the live Browser instance owned by the thread", () => {
    const stop = vi.fn();
    const { unmount } = render(
      <ThreadUtilityDockContent
        {...props()}
        browserAutomationClient={{ stop } as never}
        subject={{ mode: "code", threadId }}
        surface="browser"
      />,
    );
    expect(screen.getByText(`browser:${threadId}`)).toBeVisible();
    unmount();
    expect(stop).not.toHaveBeenCalled();
  });

  it("renders the live Terminal instance owned by the thread", async () => {
    render(<ThreadUtilityDockContent {...props()} surface="terminal" />);
    expect(await screen.findByText("code-terminal:none")).toBeVisible();
  });

  it("does not offer a Propose plan form in the dock", () => {
    render(
      <ThreadUtilityDockContent
        {...props()}
        planClient={
          {
            read: vi.fn(async () => ({ plan: null, history: [] })),
            execute: vi.fn(),
          } as never
        }
        surface="plan"
      />,
    );
    expect(screen.queryByRole("button", { name: "Propose plan" })).not.toBeInTheDocument();
  });
});
