import type {
  MovedThreadReference,
  ShutdownListing,
  ShutdownStartRequest,
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

function fakeClient(input: { readonly listing?: ShutdownListing } = {}) {
  const challenged: Array<{
    readonly memberId: string;
    readonly threads: ReadonlyArray<MovedThreadReference>;
  }> = [];
  const started: ShutdownStartRequest[] = [];
  let moved = false;
  const client: ThreadMoveClient = {
    destinations: async () => ({ status: "listed", busy: false, destinations: [] }),
    challenge: async () => ({ status: "refused", kind: "refused" }),
    start: async () => ({ status: "refused", reason: "refused" }),
    status: async (thread): Promise<ThreadMoveThreadStatus> =>
      moved
        ? {
            status: "read",
            departed: {
              moveId: "66666666-6666-4666-8666-666666666666" as never,
              thread,
              destinationMemberId: MINI as never,
              destinationThread: thread,
              changesRemainInCheckout: false,
              movedAt: new Date().toISOString() as never,
              destinationName: "Mac mini",
            },
          }
        : { status: "read" },
    stopWaiting: async () => {},
    cancel: async () => "cancelled",
    takeBack: async () => {},
    activate: async () => true,
    dismiss: async () => {},
    shutdownListing: async () => input.listing ?? listing(),
    shutdownChallenge: async (memberId, threads) => {
      challenged.push({ memberId, threads });
      return { status: "challenge", challenge: CHALLENGE as never };
    },
    shutdownStart: async (request) => {
      started.push(request);
      moved = true;
      return { status: "started" };
    },
  };
  return { client, challenged, started };
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

  it("asks a computer that is in no hub to join one", async () => {
    const { client } = fakeClient({ listing: listing({ members: [], rows: [] }) });
    render(<PrepareToShutDownDialog client={client} onClose={() => {}} open />);
    expect(
      await screen.findByText("Join a hub to move threads between your computers."),
    ).toBeInTheDocument();
  });
});
