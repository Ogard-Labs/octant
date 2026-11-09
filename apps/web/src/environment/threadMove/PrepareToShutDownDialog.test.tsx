import type {
  MovedThreadReference,
  ShutdownListing,
  ShutdownStartRequest,
  ThreadMoveSizes,
  ThreadMoveThreadStatus,
} from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PrepareToShutDownDialog } from "./PrepareToShutDownDialog";
import type { ThreadMoveClient } from "./threadMoveClient";

const MINI = "22222222-2222-4222-8222-222222222222";
const DESKTOP = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const TRIP: MovedThreadReference = {
  mode: "chat",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const DARK: MovedThreadReference = {
  mode: "code",
  threadId: "88888888-8888-4888-8888-888888888888",
};
const DIGEST: MovedThreadReference = {
  mode: "work",
  threadId: "99999999-9999-4999-8999-999999999999",
};
const CHALLENGE = {
  challengeId: "55555555-5555-4555-8555-555555555555",
  nonce: "bm9uY2U",
  hostMemberId: MINI,
  ownerMemberId: "33333333-3333-4333-8333-333333333333",
  method: "POST",
  path: "/api/hub/owner/thread-moves/ticket",
  bodyHash: "a".repeat(64),
  expiresAt: 1_900_000_000_000,
} as const;

const ok = (memberId: string, projects: ReadonlyArray<{ id: string; title: string }> = []) => ({
  memberId: memberId as never,
  projects: projects.map((project) => ({ projectId: project.id as never, title: project.title })),
  noProjectAllowed: projects.length === 0,
});

function listing(overrides: Partial<ShutdownListing> = {}): ShutdownListing {
  return {
    status: "listed",
    members: [
      { memberId: MINI as never, name: "Mac mini", role: "hub", reachable: true },
      { memberId: DESKTOP as never, name: "Desktop", role: "spoke", reachable: true },
    ],
    rows: [
      {
        thread: TRIP,
        title: "Plan the trip",
        busy: false,
        older: false,
        placements: [ok(MINI), ok(DESKTOP)],
      },
      {
        thread: DARK,
        title: "Add dark mode",
        projectName: "octant",
        busy: true,
        older: false,
        placements: [
          ok(MINI, [{ id: PROJECT, title: "octant" }]),
          {
            memberId: DESKTOP as never,
            reason: "no-eligible-project",
            projects: [],
            noProjectAllowed: false,
          },
        ],
      },
      {
        thread: DIGEST,
        title: "Weekly digest",
        busy: false,
        older: true,
        placements: [ok(MINI), ok(DESKTOP)],
      },
    ],
    ...overrides,
  };
}

function fakeClient(
  input: {
    readonly listing?: ShutdownListing;
    /** How long the start takes to answer after the first moves began. */
    readonly startAnswersAfterMs?: number;
    /** While false, every started move is still sending. */
    readonly arrives?: () => boolean;
    /** A thread whose move ended with nothing to show: Don't move, or its notice put away. */
    readonly settled?: MovedThreadReference;
    /** The desktop request to start this destination's batch fails outright. */
    readonly startThrowsFor?: string;
    /** Every handover request fails outright. */
    readonly handOverThrows?: boolean;
    readonly sizes?: (
      memberId: string,
      threads: ReadonlyArray<MovedThreadReference>,
    ) => Promise<ThreadMoveSizes>;
  } = {},
) {
  const challenged: Array<{
    readonly memberId: string;
    readonly threads: ReadonlyArray<MovedThreadReference>;
  }> = [];
  const started: ShutdownStartRequest[] = [];
  const handedOver: Array<{ readonly thread: MovedThreadReference; readonly notify?: string }> = [];
  const listingsRead = { count: 0 };
  let moved = false;
  let movedAt = new Date().toISOString();
  const client: ThreadMoveClient = {
    destinations: async () => ({ status: "listed", busy: false, destinations: [] }),
    challenge: async () => ({ status: "refused", kind: "refused" }),
    start: async () => ({ status: "refused", reason: "refused" }),
    status: async (thread): Promise<ThreadMoveThreadStatus> =>
      moved && input.settled !== undefined && input.settled.threadId === thread.threadId
        ? { status: "read", settled: { settledAt: movedAt as never } }
        : moved && input.arrives?.() === false
          ? {
              status: "read",
              sending: {
                moveId: "66666666-6666-4666-8666-666666666666" as never,
                destinationMemberId: MINI as never,
                destinationName: "Mac mini",
                state: "offered",
                bytesSent: 0,
                bytesTotal: 1,
                startedAt: new Date().toISOString() as never,
              },
            }
          : moved
            ? {
                status: "read",
                departed: {
                  moveId: "66666666-6666-4666-8666-666666666666" as never,
                  thread,
                  destinationMemberId: MINI as never,
                  destinationThread: thread,
                  changesRemainInCheckout: false,
                  movedAt: movedAt as never,
                  destinationName: "Mac mini",
                },
              }
            : { status: "read" },
    stopWaiting: async () => {},
    cancel: async () => "cancelled",
    takeBack: async () => {},
    activate: async () => true,
    dismiss: async () => {},
    sizes: async () => ({
      status: "read",
      rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
      rows: [],
    }),
    shutdownSizes:
      input.sizes ??
      (async (_memberId, threads) => ({
        status: "read",
        rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
        rows: threads.map((thread) => ({ thread, size: { status: "unknown" } })),
      })),
    shutdownListing: async () => {
      listingsRead.count += 1;
      return input.listing ?? listing();
    },
    shutdownChallenge: async (memberId, threads) => {
      challenged.push({ memberId, threads });
      return { status: "challenge", challenge: CHALLENGE as never };
    },
    shutdownStart: async (request) => {
      if (String(request.destinationMemberId) === input.startThrowsFor) {
        throw new Error("This computer could not answer.");
      }
      started.push(request);
      // The server starts the first moves before it answers.
      movedAt = new Date().toISOString();
      moved = true;
      if (input.startAnswersAfterMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, input.startAnswersAfterMs));
      }
      return { status: "started" };
    },
    handoverPreview: async () => ({ status: "refused", reason: "refused" }),
    handOver: async () => ({ status: "refused", reason: "refused" }),
    shutdownHandOver: async (thread, notify) => {
      if (input.handOverThrows === true) throw new Error("This computer could not answer.");
      handedOver.push({ thread, ...(notify === undefined ? {} : { notify }) });
      return {
        status: "handed-over",
        handoverId: "12121212-1212-4212-8212-121212121212" as never,
        branch: "add-dark-mode",
        pushed: true,
        refusedFiles: [],
      };
    },
    handoverTakeBack: async () => {},
    handoversList: async () => ({ status: "listed", handovers: [] }),
    handoversContinue: async () => ({ status: "refused", reason: "refused" }),
  };
  return { client, challenged, started, handedOver, listingsRead };
}

describe("Prepare to shut down", () => {
  it("starts on the hub with each thread on its own choice, and moves them with one Touch ID", async () => {
    const user = userEvent.setup();
    const { client, challenged, started } = fakeClient();
    const sign = vi.fn(async () => ({ status: "done" as const, signature: "c2ln" }));
    const quit = vi.fn();
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        onQuit={quit}
        open
        unlock={{ ownerUnlockSign: sign }}
      />,
    );

    expect(await screen.findByText("Plan the trip")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Move to" })).toHaveTextContent("Mac mini");
    // A busy thread waits for its turn; an older one stays unless the person chooses.
    expect(screen.getByRole("combobox", { name: "Choice for Plan the trip" })).toHaveTextContent(
      "Move",
    );
    expect(screen.getByRole("combobox", { name: "Choice for Add dark mode" })).toHaveTextContent(
      "After this turn",
    );
    expect(screen.getByText("Older threads")).toBeInTheDocument();
    expect(screen.getByText("2 move to Mac mini · 1 stay here")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(challenged).toEqual([{ memberId: MINI, threads: [TRIP, DARK] }]);
    expect(sign).toHaveBeenCalledWith(CHALLENGE);
    expect(started[0]).toEqual({
      destinationMemberId: MINI,
      rows: [
        { thread: TRIP, timing: "now" },
        { thread: DARK, destinationProjectId: PROJECT, timing: "after-turn" },
      ],
      unlock: { challengeId: CHALLENGE.challengeId, signature: "c2ln" },
    });
    expect(await screen.findByRole("heading", { name: /Safe to shut down/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quit Octant" }));
    expect(quit).toHaveBeenCalledOnce();
  });

  it("shows each row's size and what the threads set to move add up to, with the estimate's basis", async () => {
    const asked: Array<{ memberId: string; threads: ReadonlyArray<string> }> = [];
    const { client } = fakeClient({
      sizes: async (memberId, threads) => {
        asked.push({ memberId, threads: threads.map((thread) => thread.threadId) });
        return {
          status: "read",
          rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
          rows: threads.map((thread) => ({
            thread,
            size:
              thread.threadId === DARK.threadId
                ? { status: "unknown" }
                : {
                    status: "measured",
                    bytes: thread.threadId === TRIP.threadId ? 2_048 : 1_000_000,
                    parts: [],
                  },
          })),
        };
      },
    });
    render(<PrepareToShutDownDialog client={client} onClose={() => {}} open />);
    await screen.findByText("Plan the trip");

    await waitFor(() =>
      expect(screen.getByText("· 2 KB, under a minute, 1 size unknown")).toBeInTheDocument(),
    );
    expect(asked).toEqual([
      { memberId: MINI, threads: [TRIP.threadId, DARK.threadId, DIGEST.threadId] },
    ]);
    const trip = screen.getByText("Plan the trip").closest(".shutdown-row");
    const dark = screen.getByText("Add dark mode").closest(".shutdown-row");
    if (!(trip instanceof HTMLElement) || !(dark instanceof HTMLElement))
      throw new Error("No row.");
    expect(within(trip).getByText("2 KB")).toBeInTheDocument();
    expect(within(dark).getByText("Size unknown")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated at 1.0 MB a second, because no move to Mac mini has been timed yet.",
      ),
    ).toBeInTheDocument();
  });

  it("reads a row's size for the computer it moves to, and adds each destination's total at its own rate", async () => {
    const user = userEvent.setup();
    const asked: string[] = [];
    const { client } = fakeClient({
      sizes: async (memberId, threads) => {
        asked.push(memberId);
        return {
          status: "read",
          rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
          rows: threads.map((thread) => ({
            thread,
            size: { status: "measured", bytes: memberId === DESKTOP ? 4_096 : 2_048, parts: [] },
          })),
        };
      },
    });
    render(<PrepareToShutDownDialog client={client} onClose={() => {}} open />);
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("combobox", { name: "Choice for Plan the trip" }));
    await user.click(await screen.findByRole("option", { name: "Move to Desktop" }));

    await waitFor(() => expect(asked).toContain(DESKTOP));
    const trip = screen.getByText("Plan the trip").closest(".shutdown-row");
    if (!(trip instanceof HTMLElement)) throw new Error("No row.");
    await waitFor(() => expect(within(trip).getByText("4 KB")).toBeInTheDocument());
    expect(
      screen.getByText("· 2 KB, under a minute to Mac mini, 4 KB, under a minute to Desktop"),
    ).toBeInTheDocument();
  });

  it("leaves a thread the chosen computer cannot take, with its reason", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient();
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("combobox", { name: "Move to" }));
    await user.click(await screen.findByRole("option", { name: /Desktop/ }));

    const row = screen.getByText("Add dark mode").closest(".shutdown-row");
    if (!(row instanceof HTMLElement)) throw new Error("No row.");
    expect(within(row).getByText("No matching Project")).toBeInTheDocument();
    expect(
      within(row).getByRole("combobox", { name: "Choice for Add dark mode" }),
    ).toHaveTextContent("Leave here");
    expect(screen.getByRole("button", { name: "Move 1 thread with Touch ID" })).toBeEnabled();
  });

  it("counts a move that finished before the start answered as moved", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({ startAnswersAfterMs: 1_500 });
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));

    expect(
      await screen.findByRole("heading", { name: /Safe to shut down/ }, { timeout: 5_000 }),
    ).toBeInTheDocument();
  }, 10_000);

  it("shows the running batch again when the dialog is hidden and opened", async () => {
    const user = userEvent.setup();
    let arrived = false;
    const { client, listingsRead } = fakeClient({ arrives: () => arrived });
    const unlock = {
      ownerUnlockSign: async () => ({ status: "done" as const, signature: "c2ln" }),
    };
    const view = render(
      <PrepareToShutDownDialog client={client} onClose={() => {}} open unlock={unlock} />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));
    expect(await screen.findByRole("button", { name: "Hide" })).toBeInTheDocument();

    view.rerender(
      <PrepareToShutDownDialog client={client} onClose={() => {}} open={false} unlock={unlock} />,
    );
    view.rerender(
      <PrepareToShutDownDialog client={client} onClose={() => {}} open unlock={unlock} />,
    );

    expect(await screen.findByRole("progressbar", { name: "Moving threads" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Move to" })).not.toBeInTheDocument();
    expect(listingsRead.count).toBe(1);
    arrived = true;
    expect(
      await screen.findByRole("heading", { name: /Safe to shut down/ }, { timeout: 5_000 }),
    ).toBeInTheDocument();
  }, 10_000);

  it("moves at most one batch per unlock and offers the rest next, without saying it is safe", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 70 }, (_, index) => ({
      thread: {
        mode: "chat" as const,
        threadId: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
      },
      title: `Thread ${String(index)}`,
      busy: false,
      older: false,
      placements: [ok(MINI), ok(DESKTOP)],
    }));
    const { client, challenged } = fakeClient({ listing: listing({ rows: many }) });
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        onQuit={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Thread 0");
    expect(
      screen.getByText(
        "The first 64 move to Mac mini now; the other 6 can move next, with one more Touch ID.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Move 64 threads with Touch ID" }));

    expect(challenged[0]?.threads).toHaveLength(64);
    expect(
      await screen.findByRole("heading", { name: "6 threads stay on this computer" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quit Octant" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move the other 6" })).toBeInTheDocument();
  });

  it("keeps a Leave here the person chose when the destination changes and changes back", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient();
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Add dark mode");
    await user.click(screen.getByRole("combobox", { name: "Choice for Add dark mode" }));
    await user.click(await screen.findByRole("option", { name: "Leave here" }));
    // The Desktop cannot take it, so Leave here is also that destination's default.
    await user.click(screen.getByRole("combobox", { name: "Move to" }));
    await user.click(await screen.findByRole("option", { name: /Desktop/ }));
    await user.click(screen.getByRole("combobox", { name: "Move to" }));
    await user.click(await screen.findByRole("option", { name: /Mac mini/ }));

    expect(screen.getByRole("combobox", { name: "Choice for Add dark mode" })).toHaveTextContent(
      "Leave here",
    );
    expect(screen.getByRole("button", { name: "Move 1 thread with Touch ID" })).toBeEnabled();
  });

  it("counts a thread whose move ended without moving or a notice as staying, and finishes the batch", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({ settled: DARK });
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));

    expect(
      await screen.findByRole("heading", { name: "1 thread stays on this computer" }),
    ).toBeInTheDocument();
  });

  it("offers Stop and move and Hand over only as the person's own choices, never preselected", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient();
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Add dark mode");
    const choice = () => screen.getByRole("combobox", { name: "Choice for Add dark mode" });
    expect(choice()).toHaveTextContent("After this turn");

    await user.click(choice());
    expect(await screen.findByRole("option", { name: "Stop and move" })).toBeInTheDocument();
    // The hub can take it, so it moves properly: Hand over is for a thread that cannot move.
    expect(screen.queryByRole("option", { name: "Hand over" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Stop and move" }));
    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.rows).toContainEqual({
      thread: DARK,
      destinationProjectId: PROJECT,
      timing: "stop-and-move",
    });
  });

  it("moves a row to another computer through its own choice, unlocking each destination in turn", async () => {
    const user = userEvent.setup();
    const { client, challenged, started } = fakeClient();
    const sign = vi.fn(async () => ({ status: "done" as const, signature: "c2ln" }));
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: sign }}
      />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("combobox", { name: "Choice for Plan the trip" }));
    await user.click(await screen.findByRole("option", { name: "Move to Desktop" }));

    expect(screen.getByRole("combobox", { name: "Choice for Plan the trip" })).toHaveTextContent(
      "Move to Desktop",
    );
    expect(
      screen.getByText("1 move to Mac mini · 1 move to Desktop · 1 stay here"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move 2 threads" }));

    await waitFor(() => expect(started).toHaveLength(2));
    expect(challenged).toEqual([
      { memberId: MINI, threads: [DARK] },
      { memberId: DESKTOP, threads: [TRIP] },
    ]);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(started.map((request) => request.destinationMemberId)).toEqual([MINI, DESKTOP]);
    expect(await screen.findByRole("heading", { name: /Safe to shut down/ })).toBeInTheDocument();
    expect(screen.getByText("1 moved to Mac mini, 1 to Desktop.")).toBeInTheDocument();
  });

  it("still moves to the other computers when one destination's unlock is declined", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient();
    let asked = 0;
    const sign = vi.fn(async () => {
      asked += 1;
      return asked === 1
        ? ({ status: "refused", kind: "cancelled" } as const)
        : ({ status: "done", signature: "c2ln" } as const);
    });
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: sign }}
      />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("combobox", { name: "Choice for Plan the trip" }));
    await user.click(await screen.findByRole("option", { name: "Move to Desktop" }));
    await user.click(screen.getByRole("button", { name: "Move 2 threads" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.destinationMemberId).toBe(DESKTOP);
    expect(
      await screen.findByRole("heading", { name: "1 thread stays on this computer" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The move to Mac mini wasn't unlocked.");
  });

  it("hands a Code thread that cannot move over with the batch, and is safe once it is pushed", async () => {
    const user = userEvent.setup();
    const { client, handedOver } = fakeClient();
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Add dark mode");
    await user.click(screen.getByRole("combobox", { name: "Move to" }));
    await user.click(await screen.findByRole("option", { name: /Desktop/ }));
    // The Desktop has no Project for its repository: it starts on Leave here, never on Hand over.
    const choice = () => screen.getByRole("combobox", { name: "Choice for Add dark mode" });
    expect(choice()).toHaveTextContent("Leave here");
    await user.click(choice());
    await user.click(await screen.findByRole("option", { name: "Hand over" }));
    expect(screen.getByText("1 move to Desktop · 1 hands over · 1 stay here")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));

    await waitFor(() => expect(handedOver).toEqual([{ thread: DARK, notify: DESKTOP }]));
    expect(await screen.findByRole("heading", { name: /Safe to shut down/ })).toBeInTheDocument();
    expect(screen.getByText("1 moved to Desktop, 1 handed over.")).toBeInTheDocument();
  });

  it("keeps the rows of a destination whose start fails here, says why, and never says it is safe", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient({ startThrowsFor: DESKTOP });
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        onQuit={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("combobox", { name: "Choice for Plan the trip" }));
    await user.click(await screen.findByRole("option", { name: "Move to Desktop" }));
    await user.click(screen.getByRole("button", { name: "Move 2 threads" }));

    // The hub's batch started and moved; the Desktop's request failed.
    await waitFor(() =>
      expect(started.map((request) => request.destinationMemberId)).toEqual([MINI]),
    );
    expect(
      await screen.findByRole("heading", { name: "1 thread stays on this computer" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Safe to shut down/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quit Octant" })).not.toBeInTheDocument();
    const trip = screen.getByText("Plan the trip").closest(".shutdown-row");
    if (!(trip instanceof HTMLElement)) throw new Error("No row.");
    expect(within(trip).getByText("Couldn't start")).toBeInTheDocument();
    expect(within(trip).getByText("Stays here")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The moves to Desktop couldn't start.");
    expect(screen.getByRole("button", { name: "Move the last thread" })).toBeInTheDocument();
  });

  it("keeps a thread whose handover request fails here, says so, and never says it is safe", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({ handOverThrows: true });
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Add dark mode");
    await user.click(screen.getByRole("combobox", { name: "Move to" }));
    await user.click(await screen.findByRole("option", { name: /Desktop/ }));
    await user.click(screen.getByRole("combobox", { name: "Choice for Add dark mode" }));
    await user.click(await screen.findByRole("option", { name: "Hand over" }));
    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));

    expect(
      await screen.findByRole("heading", { name: "1 thread stays on this computer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Can't hand over")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Add dark mode couldn't be handed over.");
  });

  it("tells the menu bar how far the batch has come while it runs, and nothing once it ends", async () => {
    const user = userEvent.setup();
    let arrived = false;
    const { client } = fakeClient({ arrives: () => arrived });
    const progress = vi.fn();
    render(
      <PrepareToShutDownDialog
        client={client}
        onClose={() => {}}
        onProgress={progress}
        open
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await screen.findByText("Plan the trip");
    await user.click(screen.getByRole("button", { name: "Move 2 threads with Touch ID" }));

    await waitFor(() => expect(progress).toHaveBeenLastCalledWith({ ended: 0, total: 2 }));
    arrived = true;
    await waitFor(() => expect(progress).toHaveBeenLastCalledWith(undefined), { timeout: 5_000 });
  }, 10_000);

  it("asks a computer that is in no hub to join one", async () => {
    const { client } = fakeClient({ listing: listing({ members: [], rows: [] }) });
    render(<PrepareToShutDownDialog client={client} onClose={() => {}} open />);
    expect(
      await screen.findByText("Join a hub to move threads between your computers."),
    ).toBeInTheDocument();
  });
});
