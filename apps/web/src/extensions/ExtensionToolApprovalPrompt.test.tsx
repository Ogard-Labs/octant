import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { decodeApprovalOutsideContent } from "@octant/contracts";
import type { ExtensionToolApproval } from "@octant/contracts/extension-rpc";
import { describe, expect, it, vi } from "vitest";
import { ExtensionToolApprovalPrompt } from "./ExtensionToolApprovalPrompt";

const threadId = "44000000-0000-4000-8000-000000000001";
const approvalId = "44000000-0000-4000-8000-000000000010";
const extensionId = "44000000-0000-4000-8000-000000000011";
const packageId = "44000000-0000-4000-8000-000000000012";

function approval(overrides: Partial<ExtensionToolApproval> = {}): ExtensionToolApproval {
  return {
    approvalId,
    threadId,
    extensionId,
    packageId,
    componentId: "files-server",
    serverName: "files",
    providerToolName: "plugin__files__read",
    mcpToolName: "read_file",
    inputJson: '{"path":"README.md"}',
    requestedAt: "2026-10-12T10:00:00.000Z",
    rememberable: true,
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
  it("says why a marked thread's call is approved once and names what marked it", async () => {
    renderPrompt(
      client([
        approval({
          rememberable: false,
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

  it("offers always allow in this Project only when the host says the call can be remembered", async () => {
    const { unmount } = renderPrompt(client([approval({ rememberable: false })]));
    await screen.findByRole("button", { name: "Approve once" });
    expect(
      screen.queryByRole("button", { name: "Always allow in this Project" }),
    ).not.toBeInTheDocument();
    unmount();

    renderPrompt(client([approval({ rememberable: true })]));
    expect(
      await screen.findByRole("button", { name: "Always allow in this Project" }),
    ).toBeEnabled();
    expect(screen.getByRole("group", { name: "Extension tool approval" })).toHaveTextContent(
      "Octant will run this tool in this Project without asking",
    );
  });

  it("sends the decision with remember only when always allow is chosen", async () => {
    const user = userEvent.setup();
    const extensionClient = client([approval()]);
    renderPrompt(extensionClient);

    await user.click(await screen.findByRole("button", { name: "Always allow in this Project" }));

    expect(extensionClient.decideToolApproval).toHaveBeenCalledTimes(1);
    expect(extensionClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId,
      decision: "approved",
      remember: true,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Extension tool approval" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("approves once and denies without asking to remember anything", async () => {
    const user = userEvent.setup();
    const approveClient = client([approval()]);
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

  it("offers no always allow to a client that is not a local window", async () => {
    renderPrompt(client([approval({ rememberable: true })], { toolGrantsAvailable: false }));

    await screen.findByRole("button", { name: "Approve once" });
    expect(
      screen.queryByRole("button", { name: "Always allow in this Project" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Extension tool approval" })).not.toHaveTextContent(
      "without asking",
    );
  });

  it("keeps the request on screen and says so when the answer cannot be sent", async () => {
    const user = userEvent.setup();
    const extensionClient = client([approval()]);
    vi.mocked(extensionClient.decideToolApproval).mockRejectedValue(new Error("down"));
    renderPrompt(extensionClient);

    await user.click(await screen.findByRole("button", { name: "Always allow in this Project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be sent");
    expect(screen.getByRole("button", { name: "Approve once" })).toBeEnabled();
  });
});
