import {
  decodeBlockedToolsSettings,
  type BlockedToolsResult,
  type BlockedToolsSettings as BlockedToolsSnapshot,
} from "@octant/contracts/blocked-tools";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BLOCKED_TOOLS_FACT, BlockedToolsSettings } from "./BlockedToolsSettings";

function snapshot(tools: ReadonlyArray<unknown> = [], version = 0): BlockedToolsSnapshot {
  return decodeBlockedToolsSettings({ kind: "blocked-tools-settings", tools, version });
}

function client(initial: BlockedToolsSnapshot, answer?: () => BlockedToolsResult) {
  const change = vi.fn(
    async (): Promise<BlockedToolsResult> =>
      answer?.() ?? { kind: "blocked-tools-settings", settings: initial },
  );
  return { change, fake: { settings: vi.fn(async () => initial), change } };
}

describe("BlockedToolsSettings", () => {
  it("starts with nothing blocked and says what a block does", async () => {
    const { fake } = client(snapshot());
    render(<BlockedToolsSettings client={fake} />);
    expect(
      await screen.findByText("No tool is blocked. Each provider runs its own."),
    ).toBeVisible();
    expect(screen.getByText(BLOCKED_TOOLS_FACT)).toBeVisible();
  });

  it("blocks a tool for the chosen provider from the version it read, and lists it with its provider", async () => {
    const blocked = snapshot([{ provider: "claude", tool: "WebFetch" }], 1);
    const { fake, change } = client(snapshot(), () => ({
      kind: "blocked-tools-settings",
      settings: blocked,
    }));
    const user = userEvent.setup();
    render(<BlockedToolsSettings client={fake} />);
    await user.type(await screen.findByLabelText("Tool to block"), "WebFetch");
    await user.click(screen.getByRole("button", { name: "Block" }));
    expect(change).toHaveBeenCalledWith({
      kind: "set-provider-tool-blocked",
      provider: "claude",
      tool: "WebFetch",
      blocked: true,
      expectedVersion: 0,
    });
    expect(await screen.findByText("WebFetch")).toBeVisible();
    expect(screen.getByText("Claude Code · Blocked")).toBeVisible();
    expect(screen.getByLabelText("Tool to block")).toHaveValue("");
  });

  it("shows the host's refusal and keeps the draft when a provider cannot block the tool", async () => {
    const { fake } = client(snapshot(), () => ({
      kind: "blocked-tools-refused",
      reason: "unsupported",
      message:
        "Codex can block shell, view_image, web_search, or an MCP server's tool as server__tool.",
    }));
    const user = userEvent.setup();
    render(<BlockedToolsSettings client={fake} />);
    await user.type(await screen.findByLabelText("Tool to block"), "apply_patch");
    await user.click(screen.getByRole("button", { name: "Block" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/as server__tool\.$/);
    expect(screen.getByLabelText("Tool to block")).toHaveValue("apply_patch");
  });

  it("unblocks a listed tool", async () => {
    const { fake, change } = client(snapshot([{ provider: "pi", tool: "bash" }], 3), () => ({
      kind: "blocked-tools-settings",
      settings: snapshot([], 4),
    }));
    const user = userEvent.setup();
    render(<BlockedToolsSettings client={fake} />);
    await user.click(await screen.findByRole("button", { name: "Unblock bash for Pi" }));
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "pi", tool: "bash", blocked: false, expectedVersion: 3 }),
    );
    await waitFor(() =>
      expect(screen.getByText("No tool is blocked. Each provider runs its own.")).toBeVisible(),
    );
  });

  it("says the list is set on the host where the window has no client for it", () => {
    render(<BlockedToolsSettings client={undefined} />);
    expect(screen.getByText("Blocked tools are set on the host machine.")).toBeVisible();
  });
});
