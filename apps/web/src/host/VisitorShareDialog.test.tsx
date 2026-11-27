import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubAdministrationOperation } from "../shell/hostBridge";
import VisitorShareDialog from "./VisitorShareDialog";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const LINK = "L".repeat(22);
const OTHER_LINK = "M".repeat(22);
const COMMENT = "C".repeat(22);

type Answer = { readonly status: number; readonly body: unknown };
type Answers = Partial<
  Record<HubAdministrationOperation, Answer | (() => Answer | Promise<Answer>)>
>;

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

function renderDialog(answers: Answers) {
  const calls: Array<{ operation: HubAdministrationOperation; body: unknown }> = [];
  const request = vi.fn(async (operation: HubAdministrationOperation, sent?: unknown) => {
    calls.push({ operation, body: sent });
    const answer = answers[operation];
    return (typeof answer === "function" ? answer() : answer) ?? { status: 200, body: {} };
  });
  const onClose = vi.fn();
  const view = render(
    <VisitorShareDialog
      mode="code"
      now={() => NOW}
      onClose={onClose}
      request={request}
      threadId="thread-1"
      title="Fix the login page"
    />,
  );
  return { calls, onClose, unmount: view.unmount };
}

describe("VisitorShareDialog", () => {
  it("makes a link for this thread with the chosen scope and expiry, and shows it once", async () => {
    const user = userEvent.setup();
    const { calls } = renderDialog({
      "visitor-list": statusWith({ links: [], comments: [], published: true }),
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

  const madeLink = {
    status: 200,
    body: {
      status: "shared",
      linkId: LINK,
      url: `/v/${LINK}#k=secret-part`,
      expiresAt: NOW + 3_600_000,
      published: true,
    },
  };

  it("shows a new link as a path to put the hub's public address in front of, and copies the path", async () => {
    const user = userEvent.setup();
    renderDialog({
      // A hub with its own Funnel on is no exception: the link goes to the hub it joined.
      "visitor-list": {
        status: 200,
        body: {
          spoke: { membership: "none" },
          hub: {
            enabled: true,
            roster: {
              roster: { members: [{ role: "hub", privateNames: ["studio.tail1234.ts.net"] }] },
            },
          },
          publicEntrance: { enabled: true, funnel: { enabled: true, port: 443 } },
          visitors: { spoke: { links: [], comments: [], published: true } },
        },
      },
      "visitor-share": madeLink,
    });
    await screen.findByText("Nothing is shared with a visitor.");
    await user.click(screen.getByRole("button", { name: "Make link" }));
    const link = await screen.findByRole("group", { name: "New visitor link" });
    expect(
      within(link).getByText(/Put your hub's public address in front of it/),
    ).toBeInTheDocument();
    expect(within(link).getByText(`/v/${LINK}#k=secret-part`)).toBeInTheDocument();
    expect(within(link).queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
    await user.click(within(link).getByRole("button", { name: "Copy path" }));
    expect(await navigator.clipboard.readText()).toBe(`/v/${LINK}#k=secret-part`);
  });

  it("keeps a sent request's comment copyable when the links cannot be read again", async () => {
    const user = userEvent.setup();
    let reads = 0;
    renderDialog({
      "visitor-list": () => {
        reads += 1;
        return reads === 1 ? statusWith(shared) : { status: 503, body: {} };
      },
      "visitor-comment": {
        status: 200,
        body: {
          status: "sent",
          mode: "code",
          threadId: "thread-1",
          text: "A visitor wrote: hello",
        },
      },
    });
    const requests = await screen.findByRole("list", { name: "Visitor requests" });
    await user.click(within(requests).getByRole("button", { name: /^Send the visitor's request/ }));
    expect(
      await screen.findByText(/This computer is not set up for visitor links/),
    ).toBeInTheDocument();
    const toSend = screen.getByRole("group", { name: "Comment to send" });
    await user.click(within(toSend).getByRole("button", { name: "Copy comment" }));
    expect(await navigator.clipboard.readText()).toBe("A visitor wrote: hello");
  });

  it("holds back row actions while the links cannot be read again, until a read succeeds", async () => {
    const user = userEvent.setup();
    const second = { commentId: "D".repeat(22), linkId: LINK, text: "And this?", at: NOW };
    const both = statusWith({ ...shared, comments: [...shared.comments, second] });
    let answer: Answer = both;
    renderDialog({
      "visitor-list": () => answer,
      "visitor-comment": () => {
        answer = { status: 503, body: {} };
        return { status: 200, body: { status: "sent", text: "A visitor wrote: hello" } };
      },
    });
    const requests = await screen.findByRole("list", { name: "Visitor requests" });
    await user.click(within(requests).getByRole("button", { name: /^Send .*Could you try/ }));
    await screen.findByText(/This computer is not set up for visitor links/);
    const toSend = screen.getByRole("group", { name: "Comment to send" });
    await user.click(within(toSend).getByRole("button", { name: "Copy comment" }));
    expect(await navigator.clipboard.readText()).toBe("A visitor wrote: hello");
    await user.click(within(toSend).getByRole("button", { name: "Done" }));

    const actions = [
      screen.getByRole("button", { name: /^Send .*And this/ }),
      screen.getByRole("button", { name: /^Dismiss .*And this/ }),
      screen.getByRole("button", { name: /^Stop sharing/ }),
    ];
    for (const button of actions) {
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(/may be out of date/);
    }

    answer = both;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => {
      for (const button of actions) expect(button).toBeEnabled();
    });
    expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument();
  });

  it("lists only this thread's links and requests, and stops sharing one", async () => {
    const user = userEvent.setup();
    const { calls } = renderDialog({
      "visitor-list": statusWith(shared),
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
      "visitor-list": statusWith(shared),
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

  it("dismisses a visitor's request only after the person confirms, without sending it", async () => {
    const user = userEvent.setup();
    const { calls } = renderDialog({
      "visitor-list": statusWith(shared),
      "visitor-comment": { status: 200, body: { status: "dismissed" } },
    });
    const requests = await screen.findByRole("list", { name: "Visitor requests" });
    await user.click(
      within(requests).getByRole("button", { name: /^Dismiss the visitor's request/ }),
    );
    expect(calls.some((call) => call.operation === "visitor-comment")).toBe(false);
    await user.click(await screen.findByRole("button", { name: "Dismiss request" }));
    expect(calls).toContainEqual({
      operation: "visitor-comment",
      body: { commentId: COMMENT, action: "dismiss" },
    });
    expect(await screen.findByText("Dismissed. The visitor is not told.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Comment to send" })).not.toBeInTheDocument();
  });

  it("says a sent request was dismissed because its link no longer exists", async () => {
    const user = userEvent.setup();
    renderDialog({
      "visitor-list": statusWith(shared),
      "visitor-comment": { status: 200, body: { status: "dismissed" } },
    });
    const requests = await screen.findByRole("list", { name: "Visitor requests" });
    await user.click(within(requests).getByRole("button", { name: /^Send the visitor's request/ }));
    expect(
      await screen.findByText(
        "Nothing was sent: the request's link no longer exists, so Octant dismissed it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Octant could not send that comment.")).not.toBeInTheDocument();
  });

  it("keeps a new link until Done, and makes no other link over it", async () => {
    const user = userEvent.setup();
    renderDialog({
      "visitor-list": statusWith({ links: [], comments: [], published: true }),
      "visitor-share": madeLink,
    });
    await screen.findByText("Nothing is shared with a visitor.");
    const make = screen.getByRole("button", { name: "Make link" });
    await user.click(make);
    const link = await screen.findByRole("group", { name: "New visitor link" });
    expect(make).toBeDisabled();
    expect(make).toHaveAccessibleDescription(/press Done/);
    await user.click(within(link).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("group", { name: "New visitor link" })).not.toBeInTheDocument();
    expect(make).toBeEnabled();
    expect(make).toHaveFocus();
  });

  it("keeps a sent request's comment until Done, and sends no other over it", async () => {
    const user = userEvent.setup();
    const second = { commentId: "D".repeat(22), linkId: LINK, text: "And this?", at: NOW };
    renderDialog({
      "visitor-list": statusWith({ ...shared, comments: [...shared.comments, second] }),
      "visitor-comment": {
        status: 200,
        body: { status: "sent", text: "A visitor wrote: hello" },
      },
    });
    const requests = await screen.findByRole("list", { name: "Visitor requests" });
    const send = within(requests).getByRole("button", { name: /^Send .*And this/ });
    await user.click(within(requests).getByRole("button", { name: /^Send .*Could you try/ }));
    const toSend = await screen.findByRole("group", { name: "Comment to send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(/press Done/);
    await user.click(within(toSend).getByRole("button", { name: "Done" }));
    expect(send).toBeEnabled();
  });

  it("moves focus to a new link, and forgets it once that link is stopped", async () => {
    const user = userEvent.setup();
    let reads = 0;
    renderDialog({
      "visitor-list": () => {
        reads += 1;
        return statusWith(
          reads === 1
            ? { links: [], comments: [], published: true }
            : { ...shared, links: shared.links.slice(0, 1), comments: [] },
        );
      },
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
      "visitor-stop": { status: 200, body: { status: "stopped" } },
    });
    await screen.findByText("Nothing is shared with a visitor.");
    await user.click(screen.getByRole("button", { name: "Make link" }));
    const link = await screen.findByRole("group", { name: "New visitor link" });
    await waitFor(() => expect(link).toHaveFocus());
    const links = await screen.findByRole("list", { name: "Visitor links" });
    await user.click(within(links).getByRole("button", { name: /^Stop sharing/ }));
    await screen.findByText("Stopped sharing. The link's next request is refused.");
    expect(screen.queryByRole("group", { name: "New visitor link" })).not.toBeInTheDocument();
  });

  it("says why the host refused to share, and offers nothing to make where visitor links are not set up", async () => {
    const user = userEvent.setup();
    renderDialog({
      "visitor-list": statusWith({ links: [], comments: [], published: true }),
      "visitor-share": { status: 409, body: { status: "refused", kind: "public-not-granted" } },
    });
    await screen.findByText("Nothing is shared with a visitor.");
    await user.click(screen.getByRole("button", { name: "Make link" }));
    expect(
      await screen.findByText("Tick Public in this computer's hub grant first."),
    ).toBeInTheDocument();
  });

  it("explains a computer that is not in a hub instead of offering a link", async () => {
    renderDialog({ "visitor-list": { status: 200, body: { hub: { enabled: false } } } });
    expect(
      await screen.findByText(
        "This computer is not set up for visitor links. Join a hub and tick Public first.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Make link" })).toBeDisabled());
  });
});

describe("VisitorShareDialog while it stays open", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const nothing = statusWith({ links: [], comments: [], published: true });

  it("shows a request a visitor posts, and keeps it when a later read fails", async () => {
    vi.useFakeTimers();
    let answer: Answer = nothing;
    renderDialog({ "visitor-list": () => answer });
    await pass(0);
    expect(screen.queryByRole("list", { name: "Visitor requests" })).not.toBeInTheDocument();

    answer = statusWith(shared);
    await pass(15_000);
    expect(screen.getByRole("list", { name: "Visitor requests" })).toBeInTheDocument();

    answer = { status: 503, body: {} };
    await pass(15_000);
    expect(screen.getByRole("list", { name: "Visitor requests" })).toBeInTheDocument();
    expect(screen.getByText(/This computer is not set up for visitor links/)).toBeInTheDocument();
  });

  it("does not dismiss from a confirmation left open while the links cannot be read", async () => {
    vi.useFakeTimers();
    let answer: Answer = statusWith(shared);
    const { calls } = renderDialog({ "visitor-list": () => answer });
    await pass(0);
    fireEvent.click(screen.getByRole("button", { name: /^Dismiss the visitor's request/ }));

    answer = { status: 503, body: {} };
    await pass(15_000);
    const confirm = screen.getByRole("button", { name: "Dismiss request" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(calls.some((call) => call.operation === "visitor-comment")).toBe(false);
  });

  it("reads only the visitor links each time, never the whole hub status", async () => {
    vi.useFakeTimers();
    const { calls } = renderDialog({ "visitor-list": nothing });
    await pass(0);
    await pass(15_000);
    await pass(15_000);
    expect(calls.map((call) => call.operation)).toEqual([
      "visitor-list",
      "visitor-list",
      "visitor-list",
    ]);
  });

  it("starts no read while one is still unanswered", async () => {
    vi.useFakeTimers();
    let finish: (answer: Answer) => void = () => undefined;
    const { calls } = renderDialog({
      "visitor-list": () =>
        new Promise<Answer>((resolve) => {
          finish = resolve;
        }),
    });
    await pass(60_000);
    expect(calls).toHaveLength(1);
    await act(async () => finish(nothing));
    await pass(15_000);
    expect(calls).toHaveLength(2);
  });

  it("reads nothing while the window is hidden, and at once when it is shown again", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const { calls } = renderDialog({ "visitor-list": nothing });
    await pass(0);

    visibility.mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await pass(60_000);
    expect(calls).toHaveLength(1);

    visibility.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await pass(0);
    expect(calls).toHaveLength(2);
  });

  it("waits to read until the window is shown when it opens hidden", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { calls } = renderDialog({ "visitor-list": nothing });
    await pass(60_000);
    expect(calls).toHaveLength(0);

    visibility.mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await pass(0);
    expect(calls).toHaveLength(1);
    expect(screen.getByText("Nothing is shared with a visitor.")).toBeInTheDocument();
  });

  it("stops reading once it is closed", async () => {
    vi.useFakeTimers();
    const { calls, unmount } = renderDialog({ "visitor-list": nothing });
    await pass(0);
    unmount();
    await pass(60_000);
    expect(calls).toHaveLength(1);
  });
});
