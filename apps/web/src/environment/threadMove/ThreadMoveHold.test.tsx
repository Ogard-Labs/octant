import {
  decodeThreadMoveThreadStatus,
  type MovedThreadReference,
  type ThreadMoveThreadStatus,
} from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadComposer } from "../../composer/ThreadComposer";
import type { ThreadMoveClient } from "./threadMoveClient";
import { ThreadMoveHold } from "./ThreadMoveHold";

const THREAD: MovedThreadReference = {
  mode: "code",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const DESKTOP = "11111111-1111-4111-8111-111111111111";
const MOVE = "66666666-6666-4666-8666-666666666666";
const ARRIVED = "88888888-8888-4888-8888-888888888888";

function fakeClient(initial: unknown) {
  let status: ThreadMoveThreadStatus = decodeThreadMoveThreadStatus(initial);
  const calls: string[] = [];
  const client: ThreadMoveClient = {
    destinations: async () => ({ status: "listed", busy: false, destinations: [] }),
    challenge: async () => ({ status: "refused", kind: "refused" }),
    start: async () => ({ status: "refused", reason: "refused" }),
    askPhone: async () => ({ status: "refused", reason: "refused" }),
    status: async () => status,
    stopWaiting: async () => {
      calls.push("stop-waiting");
      status = decodeThreadMoveThreadStatus({ status: "read" });
    },
    cancel: async (moveId) => {
      calls.push(`cancel ${moveId}`);
      return "destination-unreachable";
    },
    takeBack: async (moveId) => {
      calls.push(`take-back ${moveId}`);
      status = decodeThreadMoveThreadStatus({ status: "read" });
    },
    activate: async () => true,
    dismiss: async () => {},
    removeKeptWorktree: async (moveId) => {
      calls.push(`remove ${moveId}`);
      const departed = status.departed;
      if (departed !== undefined) {
        status = decodeThreadMoveThreadStatus({
          status: "read",
          departed: { ...departed, keptWorktreeRemovedAt: "2026-11-09T10:00:00.000Z" },
        });
      }
      return { status: "removed" };
    },
    sizes: async () => ({
      status: "read",
      rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
      rows: [],
    }),
    shutdownSizes: async () => ({
      status: "read",
      rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
      rows: [],
    }),
    shutdownListing: async () => ({ status: "listed", members: [], rows: [] }),
    shutdownChallenge: async () => ({ status: "refused", kind: "refused" }),
    shutdownStart: async () => ({ status: "refused", reason: "refused" }),
    shutdownAskPhone: async () => ({ status: "refused", reason: "refused" }),
    shutdownHandOver: async () => ({ status: "refused", reason: "refused" }),
    handoverPreview: async () => ({ status: "refused", reason: "refused" }),
    handOver: async () => ({ status: "refused", reason: "refused" }),
    handoverTakeBack: async (handoverId) => {
      calls.push(`handover-take-back ${handoverId}`);
    },
    handoversList: async () => ({ status: "listed", handovers: [] }),
    handoversContinue: async () => ({ status: "refused", reason: "refused" }),
  };
  return { client, calls };
}

function pane(client: ThreadMoveClient | undefined) {
  return render(
    <ThreadMoveHold client={client} hostName="Laptop" thread={THREAD}>
      <p>The transcript</p>
      <ThreadComposer
        input={<textarea aria-label="Message" className="composer-input" />}
        presentation="follow-up"
        row={{ actions: { kind: "send", send: { ariaLabel: "Send", onSend: vi.fn() } } }}
      />
    </ThreadMoveHold>,
  );
}

const sending = {
  moveId: MOVE,
  destinationMemberId: DESKTOP,
  destinationName: "Desktop",
  state: "offered",
  bytesSent: 1_024,
  bytesTotal: 4_096,
  startedAt: "2026-11-09T09:00:00.000Z",
};

describe("a thread pane while a move holds it", () => {
  it("replaces the composer with a bar that says where it is moving, and keeps the transcript", async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeClient({ status: "read", sending });
    pane(client);

    expect(await screen.findByText("Moving to Desktop")).toBeInTheDocument();
    expect(screen.getByText("The transcript")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Moving to Desktop" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(screen.getByText("1 KB of 4 KB")).toBeInTheDocument();

    // The destination cannot be reached to confirm a cancel: Take back here.
    await user.click(screen.getByRole("button", { name: "Cancel move" }));
    await user.click(await screen.findByRole("button", { name: "Take back here" }));
    expect(calls).toEqual([`cancel ${MOVE}`, `take-back ${MOVE}`]);
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it("gives the composer's place to Waiting for your phone, and Don't move brings it back", async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeClient({
      status: "read",
      waitingForPhone: {
        destinationMemberId: DESKTOP,
        destinationName: "Desktop",
        expiresAt: 1_900_000_000_000,
      },
    });
    pane(client);

    expect(await screen.findByText("Waiting for your phone")).toBeInTheDocument();
    expect(screen.getByText(/Confirm on your phone to move this thread to Desktop/)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Don't move" }));
    expect(calls).toEqual(["stop-waiting"]);
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it("names what holds it when it waits for its turn, was handed over, or is arriving", async () => {
    const waiting = fakeClient({
      status: "read",
      waiting: { destinationMemberId: DESKTOP, destinationName: "Desktop" },
    });
    const { unmount } = pane(waiting.client);
    expect(await screen.findByText("Moving to Desktop after this turn")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Don't move" }));
    expect(waiting.calls).toEqual(["stop-waiting"]);
    unmount();

    const handedOver = fakeClient({
      status: "read",
      handedOver: {
        handoverId: MOVE,
        thread: THREAD,
        branch: "feature/dark-mode",
        pushed: false,
        shortfall: "push-failed",
        refusedFiles: [],
        handedOverAt: "2026-11-09T09:00:00.000Z",
      },
    });
    const second = pane(handedOver.client);
    expect(await screen.findByText("feature/dark-mode")).toBeInTheDocument();
    expect(screen.getByText(/Handed over on/)).toBeInTheDocument();
    expect(screen.getByText(/on no other computer yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take back here" })).toBeInTheDocument();
    second.unmount();

    const arriving = fakeClient({
      status: "read",
      arriving: {
        moveId: MOVE,
        originMemberId: DESKTOP,
        originName: "Desktop",
        mayActivateAnyway: true,
      },
    });
    pane(arriving.client);
    expect(await screen.findByText("Arriving from Desktop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate anyway" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
  });

  it("keeps the composer for a thread nothing holds, and for a window without the move routes", async () => {
    const free = fakeClient({ status: "read" });
    const { unmount } = pane(free.client);
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
    unmount();

    pane(undefined);
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });
});

describe("a moved thread's pane on the computer it left", () => {
  const departed = {
    moveId: MOVE,
    thread: THREAD,
    destinationMemberId: DESKTOP,
    destinationThread: { mode: "code", threadId: ARRIVED },
    destinationName: "Desktop",
    changesRemainInCheckout: false,
    movedAt: "2026-11-09T09:30:00.000Z",
  };

  it("shows Moved to with Open there, which copies the thread's link on that computer", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { client } = fakeClient({ status: "read", departed });
    pane(client);

    expect(await screen.findByRole("heading", { name: "Moved to Desktop" })).toBeInTheDocument();
    expect(screen.queryByText("The transcript")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove worktree" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open there" }));
    expect(writeText).toHaveBeenCalledWith(`octant://hosts/${DESKTOP}/threads/code/${ARRIVED}`);
    expect(await screen.findByText(/Link copied/)).toBeInTheDocument();
  });

  it("lists the files a kept worktree holds, and removes it only after the person confirms", async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeClient({
      status: "read",
      departed: {
        ...departed,
        keptWorktree: "/Users/person/.octant/worktrees/dark-mode-moved-out-66666666",
        keptFiles: [".env", "config.ts"],
        keptFileCount: 5,
      },
    });
    pane(client);

    const files = await screen.findByRole("list", { name: "Files that stayed" });
    expect(files).toHaveTextContent(".env");
    expect(files).toHaveTextContent("config.ts");
    expect(screen.getByText("and 3 more")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove worktree" }));
    const confirm = await screen.findByRole("dialog");
    expect(confirm).toHaveTextContent("They have no other copy.");
    expect(calls).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Remove worktree" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove worktree",
      ) ?? dialog,
    );
    expect(calls).toEqual([`remove ${MOVE}`]);
    await waitFor(() =>
      expect(
        screen.getByText("The worktree that stayed on this computer was removed."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Remove worktree" })).not.toBeInTheDocument();
  });
});
