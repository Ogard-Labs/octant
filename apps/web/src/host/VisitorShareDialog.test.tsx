import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HubAdministrationOperation } from "../shell/hostBridge";
import VisitorShareDialog from "./VisitorShareDialog";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const LINK = "L".repeat(22);
const OTHER_LINK = "M".repeat(22);
const COMMENT = "C".repeat(22);

type Answer = { readonly status: number; readonly body: unknown };

function statusWith(spoke: Record<string, unknown>) {
  return {
    status: 200,
    body: {
      hub: { enabled: false },
      visitors: { hub: { enabled: false, grants: 0, streams: 0 }, spoke },
    },
  };
}

const shared = {
  links: [
    {
      linkId: LINK,
      mode: "code",
      threadId: "thread-1",
      scope: "comment",
      expiresAt: NOW + 3_600_000,
      opened: true,
    },
    {
      linkId: OTHER_LINK,
      mode: "chat",
      threadId: "thread-2",
      scope: "read",
      expiresAt: NOW + 3_600_000,
      opened: false,
    },
  ],
  comments: [
    {
      commentId: COMMENT,
      linkId: LINK,
      text: "Could you try the\nother branch?",
      at: NOW - 120_000,
    },
  ],
  published: true,
};

function renderDialog(answers: Partial<Record<HubAdministrationOperation, Answer>>) {
  const calls: Array<{ operation: HubAdministrationOperation; body: unknown }> = [];
  const request = vi.fn(async (operation: HubAdministrationOperation, sent?: unknown) => {
    calls.push({ operation, body: sent });
    return answers[operation] ?? { status: 200, body: {} };
  });
  const onClose = vi.fn();
  render(
    <VisitorShareDialog
      mode="code"
      now={() => NOW}
      onClose={onClose}
      request={request}
      threadId="thread-1"
      title="Fix the login page"
    />,
  );
  return { calls, onClose };
}

describe("VisitorShareDialog", () => {
  it("makes a link for this thread with the chosen scope and expiry, and shows it once", async () => {
    const user = userEvent.setup();
    const { calls } = renderDialog({
      status: statusWith({ links: [], comments: [], published: true }),
      "visitor-share": {
        status: 200,
        body: {
          status: "shared",
          linkId: LINK,
          url: `/v/${LINK}#secret-part`,
          expiresAt: NOW + 3_600_000,
          published: true,
        },
      },
    });
    expect(await screen.findByText("Nothing is shared with a visitor.")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Visitor may" }));
    await user.click(await screen.findByRole("option", { name: "Read and send requests" }));
    await user.click(screen.getByRole("combobox", { name: "Link ends after" }));
    await user.click(await screen.findByRole("option", { name: "1 hour" }));
    await user.click(screen.getByRole("button", { name: "Make link" }));

    const link = await screen.findByRole("group", { name: "New visitor link" });
    expect(within(link).getByText(`/v/${LINK}#secret-part`)).toBeInTheDocument();
    expect(calls).toContainEqual({
      operation: "visitor-share",
      body: { mode: "code", threadId: "thread-1", scope: "comment", lifetimeMs: 3_600_000 },
    });
  });

  it("lists only this thread's links and requests, and stops sharing one", async () => {
    const user = userEvent.setup();
    const { calls } = renderDialog({
      status: statusWith(shared),
      "visitor-stop": { status: 200, body: { status: "stopped" } },
    });
    const links = await screen.findByRole("list", { name: "Visitor links" });
    expect(within(links).getAllByRole("listitem")).toHaveLength(1);
    expect(within(links).getByText(/opened/)).toBeInTheDocument();
    await user.click(within(links).getByRole("button", { name: /^Stop sharing/ }));
    expect(calls).toContainEqual({ operation: "visitor-stop", body: { linkId: LINK } });
    expect(
      await screen.findByText("Stopped sharing. The link's next request is refused."),
    ).toBeInTheDocument();
  });

  it("hands the person a visitor's request to send only after Send, framed as the host framed it", async () => {
    const user = userEvent.setup();
    const { calls } = renderDialog({
      status: statusWith(shared),
      "visitor-comment": {
        status: 200,
        body: {
          status: "sent",
          mode: "code",
          threadId: "thread-1",
          text: "A visitor wrote:\nCould you try the\nother branch?",
        },
      },
    });
    const requests = await screen.findByRole("list", { name: "Visitor requests" });
    expect(within(requests).getByText(/Could you try the/)).toBeInTheDocument();
    await user.click(within(requests).getByRole("button", { name: /^Send the visitor's request/ }));
    expect(calls).toContainEqual({
      operation: "visitor-comment",
      body: { commentId: COMMENT, action: "send" },
    });
    const toSend = await screen.findByRole("group", { name: "Comment to send" });
    expect(within(toSend).getByText(/A visitor wrote:/)).toBeInTheDocument();
  });

  it("dismisses a visitor's request without sending it", async () => {
    const user = userEvent.setup();
    const { calls } = renderDialog({
      status: statusWith(shared),
      "visitor-comment": { status: 200, body: { status: "dismissed" } },
    });
    const requests = await screen.findByRole("list", { name: "Visitor requests" });
    await user.click(
      within(requests).getByRole("button", { name: /^Dismiss the visitor's request/ }),
    );
    expect(calls).toContainEqual({
      operation: "visitor-comment",
      body: { commentId: COMMENT, action: "dismiss" },
    });
    expect(await screen.findByText("Dismissed. The visitor is not told.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Comment to send" })).not.toBeInTheDocument();
  });

  it("says why the host refused to share, and offers nothing to make where visitor links are not set up", async () => {
    const user = userEvent.setup();
    renderDialog({
      status: statusWith({ links: [], comments: [], published: true }),
      "visitor-share": { status: 409, body: { status: "refused", kind: "public-not-granted" } },
    });
    await screen.findByText("Nothing is shared with a visitor.");
    await user.click(screen.getByRole("button", { name: "Make link" }));
    expect(
      await screen.findByText("Tick Public in this computer's hub grant first."),
    ).toBeInTheDocument();
  });

  it("explains a computer that is not in a hub instead of offering a link", async () => {
    renderDialog({ status: { status: 200, body: { hub: { enabled: false } } } });
    expect(
      await screen.findByText(
        "This computer is not set up for visitor links. Join a hub and tick Public first.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Make link" })).toBeDisabled());
  });
});
