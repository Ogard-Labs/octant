import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { decodeApprovalOutsideContent } from "@octant/contracts";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
import { describe, expect, it, vi } from "vitest";
import { ExtensionToolApprovalPrompt } from "./ExtensionToolApprovalPrompt";
import { ThreadActivityRevisionsContext } from "../polling/ThreadActivityRevisions";

const threadId = "44000000-0000-4000-8000-000000000001";
const approvalId = "44000000-0000-4000-8000-000000000010";
const extensionId = "44000000-0000-4000-8000-000000000011";
const packageId = "44000000-0000-4000-8000-000000000012";
const projectId = "44000000-0000-4000-8000-000000000013";

function approval(overrides: Partial<ExtensionToolApproval> = {}): ExtensionToolApproval {
  return {
    approvalId,
    threadId,
    projectId,
    extensionId,
    packageId,
    componentId: "files-server",
    serverName: "files",
    providerToolName: "plugin__files__read",
    mcpToolName: "read_file",
    inputJson: '{"path":"README.md"}',
    requestedAt: "2026-10-12T10:00:00.000Z",
    rememberable: true,
    answerCovers: "server",
    ...overrides,
  } as ExtensionToolApproval;
}

function client(
  approvals: ReadonlyArray<ExtensionToolApproval>,
  overrides: { readonly toolGrantsAvailable?: boolean } = {},
): ExtensionClient {
  return {
    toolGrantsAvailable: overrides.toolGrantsAvailable ?? true,
    snapshot: vi.fn(async () => ({
      packages: [{ extensionId, packageId, displayName: "Project files", components: [] }],
    })) as never,
    listToolApprovals: vi.fn(async () => approvals) as never,
    decideToolApproval: vi.fn(async () => true) as never,
  } as unknown as ExtensionClient;
}

function renderPrompt(extensionClient: ExtensionClient) {
  return render(
    <ExtensionToolApprovalPrompt
      className="thread-column"
      client={extensionClient}
      threadId={threadId}
      turnActive={false}
    />,
  );
}

describe("ExtensionToolApprovalPrompt", () => {
  it("says why a marked thread's server is asked about again and names what marked it", async () => {
    renderPrompt(
      client([
        approval({
          rememberable: false,
          answerCovers: "server-on-thread",
          outsideContent: decodeApprovalOutsideContent({
            sources: [
              {
                sourceLabel: "mcp-tool",
                ingestionCount: 1,
                lastIngestedAt: "2026-10-12T09:58:00.000Z",
              },
            ],
            sourceCount: 1,
          }),
        }),
      ]),
    );

    const card = await screen.findByRole("group", { name: "Extension tool approval" });
    expect(card).toHaveTextContent("This thread took in outside content");
    expect(
      within(card).getByRole("list", { name: "Outside content that marked this thread" }),
    ).toHaveTextContent("Results from connected tools");
    // The reason reads before the controls that answer it.
    const note = within(card).getByText(/This thread took in outside content/);
    const approve = within(card).getByRole("button", {
      name: "Allow this server in this thread",
    });
    expect(note.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names no outside content on a clean thread's call", async () => {
    renderPrompt(client([approval()]));
    const card = await screen.findByRole("group", { name: "Extension tool approval" });
    expect(card).not.toHaveTextContent("outside content");
  });

  it("names the plugin, the server and the tool that is waiting", async () => {
    renderPrompt(client([approval()]));

    const card = await screen.findByRole("group", { name: "Extension tool approval" });
    await waitFor(() => expect(card).toHaveTextContent("Project files"));
    expect(card).toHaveTextContent("read_file");
    expect(card).toHaveTextContent("files");
  });

  it("still names the server and tool when the plugin's name cannot be read", async () => {
    const extensionClient = client([approval()]);
    vi.mocked(extensionClient.snapshot).mockRejectedValue(new Error("offline"));
    renderPrompt(extensionClient);

    const card = await screen.findByRole("group", { name: "Extension tool approval" });
    expect(card).toHaveTextContent("read_file");
    expect(card).toHaveTextContent("files");
    expect(card).toHaveTextContent("A plugin");
  });

  it("says a server is asked about once and that allowing covers all its tools in the Project", async () => {
    const { unmount } = renderPrompt(
      client([approval({ rememberable: false, answerCovers: "call" })]),
    );
    await screen.findByRole("button", { name: "Approve once" });
    expect(
      screen.queryByRole("button", { name: "Allow all tools of this server" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow only this tool" })).not.toBeInTheDocument();
    unmount();

    renderPrompt(client([approval()]));
    expect(
      await screen.findByRole("button", { name: "Allow all tools of this server" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Extension tool approval" })).toHaveTextContent(
      "allowing lets every tool of this server run in this Project without asking",
    );
  });

  it("sends a plain approval for the whole server, which the host keeps", async () => {
    const user = userEvent.setup();
    const extensionClient = client([approval()]);
    renderPrompt(extensionClient);

    await user.click(await screen.findByRole("button", { name: "Allow all tools of this server" }));

    expect(extensionClient.decideToolApproval).toHaveBeenCalledTimes(1);
    expect(extensionClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId,
      decision: "approved",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Extension tool approval" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("narrows the answer to one tool when the person asks for that", async () => {
    const user = userEvent.setup();
    const extensionClient = client([approval()]);
    renderPrompt(extensionClient);

    await user.click(await screen.findByRole("button", { name: "Allow only this tool" }));

    expect(extensionClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId,
      decision: "approved",
      remember: true,
    });
  });

  it("says the answer is kept for the account on a thread outside a Project", async () => {
    const { projectId: _projectId, ...outsideProject } = approval();
    renderPrompt(client([outsideProject as ExtensionToolApproval]));

    expect(
      await screen.findByRole("button", { name: "Allow all tools of this server" }),
    ).toBeEnabled();
    expect(screen.getByRole("group", { name: "Extension tool approval" })).toHaveTextContent(
      "in Chat threads outside a Project without asking",
    );
  });

  it("asks once for a network server on a thread that read outside content, for that thread", async () => {
    const user = userEvent.setup();
    const extensionClient = client([
      approval({ rememberable: false, answerCovers: "server-on-thread" }),
    ]);
    renderPrompt(extensionClient);

    const allow = await screen.findByRole("button", { name: "Allow this server in this thread" });
    expect(screen.getByRole("group", { name: "Extension tool approval" })).toHaveTextContent(
      "Allowing lets its tools run for the rest of this thread without asking",
    );
    expect(screen.queryByRole("button", { name: "Allow only this tool" })).not.toBeInTheDocument();
    await user.click(allow);
    expect(extensionClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId,
      decision: "approved",
    });
  });

  it("approves one call and denies without asking to remember anything", async () => {
    const user = userEvent.setup();
    const approveClient = client([approval({ rememberable: false, answerCovers: "call" })]);
    const { unmount } = renderPrompt(approveClient);
    await user.click(await screen.findByRole("button", { name: "Approve once" }));
    expect(approveClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId,
      decision: "approved",
    });
    unmount();

    const denyClient = client([approval()]);
    renderPrompt(denyClient);
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    expect(denyClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId,
      decision: "denied",
    });
  });

  it("offers no one-tool answer to a client that is not a local window", async () => {
    renderPrompt(client([approval()], { toolGrantsAvailable: false }));

    await screen.findByRole("button", { name: "Allow all tools of this server" });
    expect(screen.queryByRole("button", { name: "Allow only this tool" })).not.toBeInTheDocument();
  });

  it("keeps the request on screen and says so when the answer cannot be sent", async () => {
    const user = userEvent.setup();
    const extensionClient = client([approval()]);
    vi.mocked(extensionClient.decideToolApproval).mockRejectedValue(new Error("down"));
    renderPrompt(extensionClient);

    await user.click(await screen.findByRole("button", { name: "Allow only this tool" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be sent");
    expect(screen.getByRole("button", { name: "Allow all tools of this server" })).toBeEnabled();
  });

  it("keeps re-reading a running turn's approvals quickly even when change notices flow", async () => {
    vi.useFakeTimers();
    try {
      const reads = async (turnActive: boolean) => {
        const extensionClient = client([]);
        const view = render(
          <ThreadActivityRevisionsContext.Provider
            value={{
              browserCaptures: 0,
              toolApprovals: 1,
              threadFollowUps: 0,
              threadMessageQueue: 0,
            }}
          >
            <ExtensionToolApprovalPrompt
              className="thread-column"
              client={extensionClient}
              threadId={threadId}
              turnActive={turnActive}
            />
          </ThreadActivityRevisionsContext.Provider>,
        );
        await vi.advanceTimersByTimeAsync(0);
        const before = vi.mocked(extensionClient.listToolApprovals).mock.calls.length;
        await vi.advanceTimersByTimeAsync(2_000);
        const after = vi.mocked(extensionClient.listToolApprovals).mock.calls.length;
        view.unmount();
        return after - before;
      };

      expect(await reads(true)).toBeGreaterThan(0);
      expect(await reads(false)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads on a tool-approval notice without waiting for its idle beat", async () => {
    const extensionClient = client([]);
    const second = approval({ approvalId: "44000000-0000-4000-8000-000000000099" });
    const view = render(
      <ThreadActivityRevisionsContext.Provider
        value={{
          browserCaptures: 0,
          toolApprovals: 1,
          threadFollowUps: 0,
          threadMessageQueue: 0,
        }}
      >
        <ExtensionToolApprovalPrompt
          className="thread-column"
          client={extensionClient}
          threadId={threadId}
          turnActive={false}
        />
      </ThreadActivityRevisionsContext.Provider>,
    );
    await waitFor(() =>
      expect(vi.mocked(extensionClient.listToolApprovals)).toHaveBeenCalledTimes(1),
    );

    vi.mocked(extensionClient.listToolApprovals).mockResolvedValue([second]);
    view.rerender(
      <ThreadActivityRevisionsContext.Provider
        value={{
          browserCaptures: 0,
          toolApprovals: 2,
          threadFollowUps: 0,
          threadMessageQueue: 0,
        }}
      >
        <ExtensionToolApprovalPrompt
          className="thread-column"
          client={extensionClient}
          threadId={threadId}
          turnActive={false}
        />
      </ThreadActivityRevisionsContext.Provider>,
    );

    await waitFor(() =>
      expect(vi.mocked(extensionClient.listToolApprovals)).toHaveBeenCalledTimes(2),
    );
    expect(
      await screen.findByRole("button", { name: "Allow all tools of this server" }),
    ).toBeInTheDocument();
  });
});
