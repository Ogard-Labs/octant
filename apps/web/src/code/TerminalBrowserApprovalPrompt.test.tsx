import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import { describe, expect, it, vi } from "vitest";
import { TerminalBrowserApprovalPrompt } from "./TerminalBrowserApprovalPrompt";

const threadId = "11111111-1111-4111-8111-111111111111";

function approval(overrides: Partial<Record<keyof BrowserToolApproval, string>> = {}) {
  return {
    approvalId: "22222222-2222-4222-8222-222222222222",
    threadId,
    mode: "code",
    origin: "https://example.com",
    requestedAt: "2026-10-14T09:00:00.000Z",
    ...overrides,
  } as unknown as BrowserToolApproval;
}

function client(listed: ReadonlyArray<BrowserToolApproval>, settled = true) {
  return {
    listApprovals: vi.fn(async () => listed),
    decideApproval: vi.fn(async () => settled),
  };
}

describe("TerminalBrowserApprovalPrompt", () => {
  it("shows the Code agent's sign-in request as its own question, with Continue and no remembering", async () => {
    const browser = client([
      {
        ...approval(),
        signIn: { reason: "The dashboard needs your account." },
      } as BrowserToolApproval,
    ]);
    render(
      <TerminalBrowserApprovalPrompt
        client={browser}
        threadId={threadId}
        threadTitle="Fix the login page"
      />,
    );

    const card = await screen.findByRole("group", { name: "Browser sign-in" });
    expect(card).toHaveTextContent("The agent asks you to sign in on https://example.com");
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(browser.decideApproval).toHaveBeenCalledWith({
        approvalId: "22222222-2222-4222-8222-222222222222",
        decision: "approved",
      }),
    );
  });

  it("names the thread and the site, and says the terminal asked rather than the thread's agent", async () => {
    const browser = client([approval()]);
    render(
      <TerminalBrowserApprovalPrompt
        client={browser}
        threadId={threadId}
        threadTitle="Fix the login page"
      />,
    );

    const card = await screen.findByRole("group", { name: "Browser request from a terminal" });
    expect(card).toHaveTextContent("Let the terminal open https://example.com in the Browser?");
    expect(card).toHaveTextContent(
      "Asked by a program in a terminal of “Fix the login page”, not by this thread's agent",
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    await waitFor(() =>
      expect(browser.decideApproval).toHaveBeenCalledWith({
        approvalId: "22222222-2222-4222-8222-222222222222",
        decision: "approved",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("group", { name: "Browser request from a terminal" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows only this Code thread's requests, not another thread's or a Work thread's", async () => {
    const browser = client([
      approval({ threadId: "33333333-3333-4333-8333-333333333333" }),
      approval({ mode: "work" }),
    ]);
    render(
      <TerminalBrowserApprovalPrompt client={browser} threadId={threadId} threadTitle="Thread" />,
    );

    await waitFor(() => expect(browser.listApprovals).toHaveBeenCalled());
    expect(
      screen.queryByRole("group", { name: "Browser request from a terminal" }),
    ).not.toBeInTheDocument();
  });

  it("says so when the request had already ended by the time the person answered", async () => {
    const browser = client([approval()], false);
    render(
      <TerminalBrowserApprovalPrompt client={browser} threadId={threadId} threadTitle="Thread" />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(browser.decideApproval).toHaveBeenCalledWith({
        approvalId: "22222222-2222-4222-8222-222222222222",
        decision: "denied",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The terminal's request to open https://example.com had already ended",
    );
  });
});
