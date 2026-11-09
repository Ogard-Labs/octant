import type {
  MovedThreadReference,
  ThreadMoveDestinations,
  ThreadMoveSizes,
  ThreadMoveStartRequest,
  ThreadMoveThreadStatus,
} from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadMoveComputerCard } from "./ThreadMoveComputerCard";
import type { ThreadMoveClient } from "./threadMoveClient";

const THREAD: MovedThreadReference = {
  mode: "code",
  threadId: "77777777-7777-4777-8777-777777777777",
};
const DESKTOP = "11111111-1111-4111-8111-111111111111";
const MINI = "22222222-2222-4222-8222-222222222222";
const LAPTOP = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const CHALLENGE = {
  challengeId: "55555555-5555-4555-8555-555555555555",
  nonce: "bm9uY2U",
  hostMemberId: DESKTOP,
  ownerMemberId: LAPTOP,
  method: "POST",
  path: "/api/hub/owner/thread-moves/ticket",
  bodyHash: "a".repeat(64),
  expiresAt: 1_900_000_000_000,
} as const;

function listing(overrides: Partial<ThreadMoveDestinations> = {}): ThreadMoveDestinations {
  return {
    status: "listed",
    busy: false,
    destinations: [
      {
        memberId: MINI as never,
        name: "Mac mini",
        role: "hub",
        reachable: true,
        refusal: "refused",
        projects: [],
        noProjectAllowed: false,
      },
      {
        memberId: DESKTOP as never,
        name: "Desktop",
        role: "spoke",
        reachable: true,
        projects: [{ projectId: PROJECT as never, title: "octant" }],
        noProjectAllowed: false,
      },
    ],
    ...overrides,
  };
}

function fakeClient(input: {
  readonly destinations?: ThreadMoveDestinations;
  readonly status?: ThreadMoveThreadStatus;
  readonly sizes?: () => Promise<ThreadMoveSizes>;
}) {
  const started: ThreadMoveStartRequest[] = [];
  const dismissed: string[] = [];
  let status: ThreadMoveThreadStatus = input.status ?? { status: "read" };
  const client: ThreadMoveClient = {
    destinations: async () => input.destinations ?? listing(),
    challenge: async () => ({ status: "challenge", challenge: CHALLENGE as never }),
    start: async (request) => {
      started.push(request);
      status = {
        status: "read",
        sending: {
          moveId: "66666666-6666-4666-8666-666666666666" as never,
          destinationMemberId: DESKTOP as never,
          destinationName: "Desktop",
          state: "offered",
          bytesSent: 512,
          bytesTotal: 2_048,
          startedAt: "2026-11-08T12:00:00.000Z" as never,
        },
      };
      return { status: "started" };
    },
    status: async () => status,
    stopWaiting: async () => {},
    cancel: async () => "cancelled",
    takeBack: async () => {},
    activate: async () => true,
    dismiss: async (thread) => {
      dismissed.push(thread.threadId);
      status = { status: "read" };
    },
    removeKeptWorktree: async () => ({ status: "removed" }),
    sizes:
      input.sizes ??
      (async (_memberId, threads) => ({
        status: "read",
        rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
        rows: threads.map((thread) => ({ thread, size: { status: "unknown" } })),
      })),
    shutdownListing: async () => ({ status: "listed", members: [], rows: [] }),
    shutdownSizes: async () => ({
      status: "read",
      rate: { basis: "assumed", bytesPerSecond: 1_048_576 },
      rows: [],
    }),
    shutdownChallenge: async () => ({ status: "refused", kind: "refused" }),
    shutdownStart: async () => ({ status: "refused", reason: "refused" }),
    shutdownHandOver: async () => ({ status: "refused", reason: "refused" }),
    handoverPreview: async () => ({ status: "refused", reason: "refused" }),
    handOver: async () => ({ status: "refused", reason: "refused" }),
    handoverTakeBack: async () => {},
    handoversList: async () => ({ status: "listed", handovers: [] }),
    handoversContinue: async () => ({ status: "refused", reason: "refused" }),
  };
  return { client, started, dismissed };
}

describe("the Computer card", () => {
  it("moves a thread to the chosen computer with this Mac's Touch ID", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient({});
    const sign = vi.fn(async () => ({ status: "done" as const, signature: "c2lnbmF0dXJl" }));
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
        unlock={{ ownerUnlockSign: sign }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Laptop/ }));
    const desktop = await screen.findByRole("radio", { name: /Desktop/ });
    // An eligible computer comes first; one that cannot take the thread stays listed, disabled, with why.
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toBe(desktop);
    expect(screen.getByRole("radio", { name: /Mac mini/ })).toBeDisabled();
    expect(screen.getByText("Not accepting moves")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review move" })).toBeDisabled();

    await user.click(desktop);
    // The one Project that fits is chosen for the person.
    expect(screen.getByText("Into octant")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review move" }));

    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("Move to Desktop");
    expect(sheet).toHaveTextContent(
      "This thread is erased from this computer once Desktop has it.",
    );
    expect(sheet).toHaveTextContent(
      "Its attachments, generated images, Browser captures, and Canvases",
    );
    await user.click(screen.getByRole("button", { name: "Move with Touch ID" }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(sign).toHaveBeenCalledWith(CHALLENGE);
    expect(started[0]).toEqual({
      thread: THREAD,
      destinationMemberId: DESKTOP,
      destinationProjectId: PROJECT,
      timing: "now",
      unlock: { challengeId: CHALLENGE.challengeId, signature: "c2lnbmF0dXJl" },
    });
    expect(await screen.findByRole("progressbar", { name: "Moving to Desktop" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(screen.getByText("Moving 25%")).toBeInTheDocument();
  });

  it("names the parts that could not be read here and did not move, on the Moved notice", async () => {
    const { client } = fakeClient({
      status: {
        status: "read",
        departed: {
          moveId: "66666666-6666-4666-8666-666666666666" as never,
          thread: THREAD,
          destinationMemberId: DESKTOP as never,
          destinationThread: { mode: "code", threadId: PROJECT },
          changesRemainInCheckout: false,
          partsLeftBehind: [
            { kind: "attachment", name: "scan.pdf" },
            { kind: "browser-capture", name: "Pricing" },
          ],
          // More were left behind than the receipt names.
          partsLeftBehindCount: 5,
          movedAt: "2026-11-08T12:00:00.000Z" as never,
          destinationName: "Desktop",
        },
      },
    });
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
        unlock={{ ownerUnlockSign: vi.fn() }}
      />,
    );
    expect(
      await screen.findByText(
        /5 parts could not be read here, so they did not move: scan\.pdf, Pricing, and 3 more\./,
      ),
    ).toBeInTheDocument();
  });

  it("shows what the move would send and how long it takes, with what the estimate rests on", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({
      sizes: async () => ({
        status: "read",
        rate: { basis: "measured", bytesPerSecond: 100_000 },
        rows: [
          {
            thread: THREAD,
            size: {
              status: "measured",
              bytes: 12_582_912,
              parts: [
                { kind: "thread-bundle", bytes: 40_960 },
                { kind: "git-bundle", bytes: 12_541_952 },
              ],
            },
          },
        ],
      }),
    });
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Laptop/ }));
    await user.click(await screen.findByRole("radio", { name: /Desktop/ }));
    await user.click(screen.getByRole("button", { name: "Review move" }));

    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(sheet).toHaveTextContent("12.0 MB, about 3 min"));
    expect(within(sheet).getByText("40 KB")).toBeInTheDocument();
    expect(within(sheet).getByText("12.0 MB")).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Estimated from the speed earlier moves to Desktop reached.");
  });

  it("says the size is unknown when the thread could not be measured, and still moves it", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient({
      sizes: async () => {
        throw new Error("This computer could not answer.");
      },
    });
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Laptop/ }));
    await user.click(await screen.findByRole("radio", { name: /Desktop/ }));
    await user.click(screen.getByRole("button", { name: "Review move" }));

    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("Size unknown")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Move with Touch ID" }));
    await waitFor(() => expect(started).toHaveLength(1));
  });

  it("offers to move a busy thread after its turn", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient({ destinations: listing({ busy: true }) });
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Laptop/ }));
    await user.click(await screen.findByRole("radio", { name: /Desktop/ }));
    await user.click(screen.getByRole("button", { name: "Review move" }));
    await user.click(
      await screen.findByRole("button", { name: "Move after this turn with Touch ID" }),
    );
    await waitFor(() => expect(started[0]?.timing).toBe("after-turn"));
  });

  it("stops a busy thread's turn and moves it only when the person picks Stop and move", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient({ destinations: listing({ busy: true }) });
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Laptop/ }));
    await user.click(await screen.findByRole("radio", { name: /Desktop/ }));
    await user.click(screen.getByRole("button", { name: "Review move" }));

    // Move after this turn is the sheet's starting choice; stopping work is never preselected.
    expect(await screen.findByRole("radio", { name: "Move after this turn" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: "Stop and move" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "The running turn stops now, and its pending approvals and questions are cancelled.",
    );
    await user.click(screen.getByRole("button", { name: "Stop and move with Touch ID" }));

    await waitFor(() => expect(started[0]?.timing).toBe("stop-and-move"));
  });

  it("says the turn is stopping while Stop and move waits for it", async () => {
    const { client } = fakeClient({
      status: {
        status: "read",
        waiting: {
          destinationMemberId: DESKTOP as never,
          destinationName: "Desktop",
          stopping: true,
        },
      },
    });
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
      />,
    );
    expect(await screen.findByText("Stopping")).toBeInTheDocument();
  });

  it("says plainly when this Mac is not an owner on the chosen computer, and moves nothing", async () => {
    const user = userEvent.setup();
    const { client, started } = fakeClient({});
    const refusing: ThreadMoveClient = {
      ...client,
      challenge: async () => ({ status: "refused", kind: "unlock-required" }),
    };
    render(
      <ThreadMoveComputerCard
        client={refusing}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
        unlock={{ ownerUnlockSign: async () => ({ status: "done", signature: "c2ln" }) }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Laptop/ }));
    await user.click(await screen.findByRole("radio", { name: /Desktop/ }));
    await user.click(screen.getByRole("button", { name: "Review move" }));
    await user.click(await screen.findByRole("button", { name: "Move with Touch ID" }));
    expect(await screen.findByText(/This Mac isn't an owner on Desktop/)).toBeInTheDocument();
    expect(started).toEqual([]);
  });

  it("keeps This thread can't move on the thread until the person dismisses it", async () => {
    const user = userEvent.setup();
    const { client, dismissed } = fakeClient({
      status: {
        status: "read",
        failure: {
          moveId: "66666666-6666-4666-8666-666666666666" as never,
          reason: "no-matching-provider",
          failedAt: "2026-11-08T12:00:00.000Z" as never,
        },
      },
    });
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
      />,
    );
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("This thread can't move");
    expect(notice).toHaveTextContent("no provider of the kind this thread runs on");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(dismissed).toEqual([THREAD.threadId]));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("asks a computer that is in no hub to join one", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({ destinations: listing({ destinations: [] }) });
    const openHub = vi.fn();
    render(
      <ThreadMoveComputerCard
        client={client}
        hostName="Laptop"
        isThisComputer
        onOpenHubSettings={openHub}
        thread={THREAD}
        threadTitle="Add dark mode"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Laptop/ }));
    expect(
      await screen.findByText("Join a hub to move threads between your computers."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set up" }));
    expect(openHub).toHaveBeenCalledOnce();
  });

  it("shows only where the thread runs when the window cannot move it", () => {
    render(
      <ThreadMoveComputerCard
        hostName="Mac mini"
        isThisComputer={false}
        thread={THREAD}
        threadTitle="Add dark mode"
      />,
    );
    expect(screen.getAllByText("Mac mini")).toHaveLength(2);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("hands a Code thread that can't move over through its branch, and takes it back", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient({
      status: {
        status: "read",
        failure: {
          moveId: "66666666-6666-4666-8666-666666666666" as never,
          reason: "no-eligible-project",
          failedAt: "2026-11-08T12:00:00.000Z" as never,
        },
      },
    });
    const handedOver: string[] = [];
    const takenBack: string[] = [];
    let status: ThreadMoveThreadStatus = {
      status: "read",
      failure: {
        moveId: "66666666-6666-4666-8666-666666666666" as never,
        reason: "no-eligible-project",
        failedAt: "2026-11-08T12:00:00.000Z" as never,
      },
    };
    const handing: ThreadMoveClient = {
      ...client,
      status: async () => status,
      handoverPreview: async () => ({
        status: "preview",
        branch: "feature/dark-mode",
        newBranch: false,
        remote: "origin",
        note: "Hand over: Add dark mode",
      }),
      handOver: async (thread, _destination, choices) => {
        handedOver.push(`${thread.threadId}:${String(choices.summarize)}`);
        status = {
          status: "read",
          handedOver: {
            handoverId: "12345678-1234-4234-8234-123456789012" as never,
            thread,
            branch: "feature/dark-mode",
            pushed: true,
            refusedFiles: [],
            handedOverAt: "2026-11-08T12:00:00.000Z" as never,
          },
        };
        return {
          status: "handed-over",
          handoverId: "12345678-1234-4234-8234-123456789012" as never,
          branch: "feature/dark-mode",
          pushed: true,
          refusedFiles: [],
        };
      },
      handoverTakeBack: async (handoverId) => {
        takenBack.push(handoverId);
        status = { status: "read" };
      },
    };
    render(
      <ThreadMoveComputerCard
        client={handing}
        hostName="Laptop"
        isThisComputer
        thread={THREAD}
        threadTitle="Add dark mode"
      />,
    );

    // The picker is open when the person hands over instead.
    await user.click(await screen.findByRole("button", { name: "Choose another computer" }));
    expect(await screen.findByRole("radio", { name: /Desktop/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hand over instead" }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("feature/dark-mode");
    expect(sheet).toHaveTextContent("Then pushes it to origin, never forced.");
    // The agent's summary is asked for unless the person turns it off.
    expect(await screen.findByRole("switch", { name: "Ask the agent to summarize" })).toBeChecked();
    await user.click(await screen.findByRole("button", { name: "Commit and push" }));

    await waitFor(() => expect(handedOver).toEqual([`${THREAD.threadId}:true`]));
    expect(
      await screen.findByText(/committed and pushed on feature\/dark-mode/),
    ).toBeInTheDocument();
    // A handed-over thread is held, so it offers no other move.
    expect(screen.queryByRole("radio", { name: /Desktop/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Take back here" }));
    await waitFor(() => expect(takenBack).toEqual(["12345678-1234-4234-8234-123456789012"]));
  });
});
