import { ContextClientFailure, type ContextClient } from "@octant/client-runtime/context-client";
import {
  decodeThreadExternalContentClearOutcome,
  decodeThreadExternalContentState,
  type ThreadExternalContentClearOutcome,
  type ThreadExternalContentState,
} from "@octant/contracts/content-provenance";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import { ComposerOutsideContentNotice, OutsideContentContext } from "./OutsideContentNotice";

const threadId = "40000000-0000-4000-8000-000000000001";
const first = "2026-10-11T08:15:00.000Z";
const last = "2026-10-12T09:30:00.000Z";

function stateOf(
  overrides: Partial<ThreadExternalContentState> | Record<string, unknown> = {},
): ThreadExternalContentState {
  return decodeThreadExternalContentState({
    threadId,
    externalContentIngested: true,
    version: 3,
    ingestionCount: 4,
    sources: [
      { sourceLabel: "web-fetch", ingestionCount: 3, firstIngestedAt: first, lastIngestedAt: last },
      { sourceLabel: "github-issue", ingestionCount: 1, lastIngestedAt: last },
      { sourceLabel: "mcp-tool", ingestionCount: 2 },
    ],
    ...overrides,
  });
}

const unmarked = () => stateOf({ externalContentIngested: false, ingestionCount: 0, sources: [] });

function refused(
  reason: string,
  state?: ThreadExternalContentState,
): ThreadExternalContentClearOutcome {
  return decodeThreadExternalContentClearOutcome({
    kind: "refused",
    reason,
    ...(state === undefined ? {} : { state }),
  });
}

function fakeClient(
  options: {
    readonly read?: () => Promise<ThreadExternalContentState>;
    readonly clear?: () => Promise<ThreadExternalContentClearOutcome>;
    readonly available?: boolean;
  } = {},
) {
  const readExternalContent = vi.fn(options.read ?? (async () => stateOf()));
  const clearExternalContent = vi.fn(
    options.clear ??
      (async () => decodeThreadExternalContentClearOutcome({ kind: "cleared", state: unmarked() })),
  );
  const client = {
    externalContentAvailable: options.available ?? true,
    readExternalContent,
    clearExternalContent,
    inspect: vi.fn(),
    execute: vi.fn(),
  } as unknown as ContextClient;
  return { client, readExternalContent, clearExternalContent };
}

function renderNotice(client: ContextClient, busy = false) {
  const view = (turnBusy: boolean) => (
    <OutsideContentContext value={{ client, mode: "code", threadId }}>
      <ComposerOutsideContentNotice busy={turnBusy} />
    </OutsideContentContext>
  );
  const rendered = render(view(busy));
  return { ...rendered, setBusy: (next: boolean) => rendered.rerender(view(next)) };
}

async function openReview() {
  await userEvent.setup().click(await screen.findByRole("button", { name: "Review" }));
  return screen.findByRole("dialog", { name: "Outside content this thread read" });
}

describe("outside content notice", () => {
  it("shows a marked thread a notice with Review, and an unmarked thread nothing", async () => {
    const marked = fakeClient();
    const { unmount } = renderNotice(marked.client);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This thread has read outside content, so some actions will ask each time.",
    );
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(marked.readExternalContent).toHaveBeenCalledWith(
      { mode: "code", threadId },
      expect.any(AbortSignal),
    );
    unmount();

    const clean = fakeClient({ read: async () => unmarked() });
    renderNotice(clean.client);
    await waitFor(() => expect(clean.readExternalContent).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lists each source in plain words with how often and when it was read, and says clearing removes nothing the model read", async () => {
    renderNotice(fakeClient().client);
    const dialog = await openReview();

    const rows = within(
      within(dialog).getByRole("list", { name: "Outside content this thread read" }),
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Web pages");
    expect(rows[0]).toHaveTextContent(
      `Read 3 times, first ${absoluteTimeFormatter.format(new Date(first))}, last ${absoluteTimeFormatter.format(new Date(last))}`,
    );
    expect(rows[1]).toHaveTextContent("A GitHub issue");
    expect(rows[1]).toHaveTextContent(`Read once, ${absoluteTimeFormatter.format(new Date(last))}`);
    // A row from before the host recorded times shows none rather than an invented one.
    expect(rows[2]).toHaveTextContent("Results from connected tools");
    expect(rows[2]?.textContent).toMatch(/Read 2 times$/);

    expect(dialog).toHaveAccessibleDescription(
      /It does not remove anything the model already read, and the next outside content marks the thread again\./,
    );
    expect(within(dialog).getByRole("button", { name: "Clear the mark" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("leaves the mark alone when the person cancels", async () => {
    const { client, clearExternalContent } = fakeClient();
    renderNotice(client);
    const dialog = await openReview();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(clearExternalContent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("clears at the version the person was shown and removes the notice", async () => {
    const { client, clearExternalContent } = fakeClient();
    renderNotice(client);
    const dialog = await openReview();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Clear the mark" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(clearExternalContent).toHaveBeenCalledOnce();
    expect(clearExternalContent).toHaveBeenCalledWith({
      mode: "code",
      threadId,
      expectedVersion: 3,
    });
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("closes without a word when the thread was already clear", async () => {
    const { client } = fakeClient({
      clear: async () =>
        decodeThreadExternalContentClearOutcome({ kind: "already-clear", state: unmarked() }),
    });
    renderNotice(client);
    const dialog = await openReview();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Clear the mark" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });

  it("reloads the list and says so when new outside content arrived, then clears the newer version", async () => {
    const newer = stateOf({
      version: 5,
      ingestionCount: 5,
      sources: [
        {
          sourceLabel: "web-fetch",
          ingestionCount: 3,
          firstIngestedAt: first,
          lastIngestedAt: last,
        },
        { sourceLabel: "linear-issue", ingestionCount: 2, lastIngestedAt: last },
      ],
    });
    const clear = vi
      .fn<() => Promise<ThreadExternalContentClearOutcome>>()
      .mockResolvedValueOnce(refused("stale", newer))
      .mockResolvedValue(
        decodeThreadExternalContentClearOutcome({ kind: "cleared", state: unmarked() }),
      );
    const { client, clearExternalContent } = fakeClient({ clear });
    renderNotice(client);
    const dialog = await openReview();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "Clear the mark" }));

    expect(
      await within(dialog).findByText(/New outside content arrived since you looked/),
    ).toBeVisible();
    expect(within(dialog).getByText("A Linear issue")).toBeVisible();
    expect(within(dialog).queryByText("A GitHub issue")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);

    await user.click(within(dialog).getByRole("button", { name: "Clear the mark" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(clearExternalContent).toHaveBeenLastCalledWith({
      mode: "code",
      threadId,
      expectedVersion: 5,
    });
  });

  it("reads the list again itself when a stale refusal carries none", async () => {
    const newer = stateOf({ version: 6 });
    const read = vi
      .fn<() => Promise<ThreadExternalContentState>>()
      .mockResolvedValueOnce(stateOf())
      .mockResolvedValue(newer);
    const { client, clearExternalContent } = fakeClient({
      read,
      clear: async () => refused("stale"),
    });
    renderNotice(client);
    const dialog = await openReview();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "Clear the mark" }));
    await within(dialog).findByText(/New outside content arrived since you looked/);
    await user.click(within(dialog).getByRole("button", { name: "Clear the mark" }));
    await waitFor(() => expect(clearExternalContent).toHaveBeenCalledTimes(2));
    expect(clearExternalContent).toHaveBeenLastCalledWith({
      mode: "code",
      threadId,
      expectedVersion: 6,
    });
  });

  it.each([
    ["turn-active", /This thread is busy\. Try again once its turn and any queued messages/],
    ["turn-unconfirmed", /last turn did not finish cleanly/],
    ["unauthorized", /cannot be cleared from this window/],
    ["thread-unavailable", /cannot be reached from this window/],
  ])("tells the person why a %s refusal kept the mark", async (reason, sentence) => {
    const { client } = fakeClient({ clear: async () => refused(reason, stateOf()) });
    renderNotice(client);
    const dialog = await openReview();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Clear the mark" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(sentence);
    expect(screen.getByRole("dialog")).toBe(dialog);
    // The page behind a modal dialog is inert, so the notice is found by hidden role.
    expect(screen.getByRole("button", { name: "Review", hidden: true })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Clear the mark" })).toBeEnabled();
  });

  it("says so when the host cannot be reached instead of failing silently", async () => {
    const { client } = fakeClient({
      clear: async () => {
        throw new ContextClientFailure("unavailable", "Octant Context service is unavailable.");
      },
    });
    renderNotice(client);
    const dialog = await openReview();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Clear the mark" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Octant could not reach the host to clear the mark. Try again.",
    );
  });

  it("holds Clear the mark back, with the reason as text, while a turn runs or messages are queued", async () => {
    const { client, clearExternalContent } = fakeClient();
    const { setBusy } = renderNotice(client, true);
    const dialog = await openReview();

    expect(within(dialog).getByRole("button", { name: "Clear the mark" })).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "A turn is running or messages are queued. Clear the mark once the thread is idle.",
    );
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Clear the mark" }));
    expect(clearExternalContent).not.toHaveBeenCalled();

    setBusy(false);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Clear the mark" })).toBeEnabled(),
    );
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the notice gone when a read begun before the clear answers after it", async () => {
    let answerLate: (state: ThreadExternalContentState) => void = () => undefined;
    const late = new Promise<ThreadExternalContentState>((resolve) => {
      answerLate = resolve;
    });
    const read = vi
      .fn<() => Promise<ThreadExternalContentState>>()
      .mockResolvedValueOnce(stateOf())
      .mockResolvedValueOnce(stateOf())
      .mockReturnValue(late);
    const { client, clearExternalContent } = fakeClient({
      read,
      clear: async () =>
        decodeThreadExternalContentClearOutcome({
          kind: "cleared",
          state: stateOf({
            externalContentIngested: false,
            version: 4,
            ingestionCount: 0,
            sources: [],
          }),
        }),
    });
    const { setBusy } = renderNotice(client);
    await screen.findByRole("button", { name: "Review" });
    // A turn starts and settles; the read that settling begins is still in flight.
    setBusy(true);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    setBusy(false);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));

    const dialog = await openReview();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Clear the mark" }));
    await waitFor(() => expect(clearExternalContent).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await act(async () => {
      answerLate(stateOf());
      await late;
    });
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reads the mark again when a turn starts or settles", async () => {
    const { client, readExternalContent } = fakeClient({ read: async () => unmarked() });
    const { setBusy } = renderNotice(client);
    await waitFor(() => expect(readExternalContent).toHaveBeenCalledTimes(1));
    setBusy(true);
    await waitFor(() => expect(readExternalContent).toHaveBeenCalledTimes(2));
    setBusy(false);
    await waitFor(() => expect(readExternalContent).toHaveBeenCalledTimes(3));
  });

  it("draws no notice and sends no request from a client that is not at a local window", async () => {
    const { client, readExternalContent } = fakeClient({ available: false });
    renderNotice(client);
    await Promise.resolve();
    expect(readExternalContent).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("draws nothing where the composer has no thread", () => {
    render(<ComposerOutsideContentNotice busy={false} />);
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });
});
