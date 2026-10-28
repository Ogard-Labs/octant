import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  hubAdministrationOf,
  type HubAdministrationOperation,
  type RemotePendingPairingRequest,
} from "../shell/hostBridge";
import { HubSettingsSection, type HubSettingsSectionProps } from "./HubSettingsSection";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const ticketId = "11111111-1111-4111-8111-111111111111";
const pendingRequest: RemotePendingPairingRequest = {
  kind: "pending",
  ticketId,
  hostId: "33333333-3333-4333-8333-333333333333",
  deviceLabel: "Work laptop",
  deviceKeyFingerprint: "a".repeat(64),
  origin: "https://100.64.0.2:13774",
  sourceClass: "tailscale",
  comparisonCode: "482913",
  claimedAt: "2026-10-29T10:00:00.000Z",
  expiresAt: "2026-10-29T10:05:00.000Z",
};

type Answer = { readonly status: number; readonly body: unknown };
type Answers = Partial<Record<HubAdministrationOperation, Answer | (() => Answer)>>;

function statusBody(options: {
  readonly enabled?: boolean;
  readonly members?: ReadonlyArray<Record<string, unknown>>;
  readonly spoke?: unknown;
}) {
  return {
    hub: {
      enabled: options.enabled ?? false,
      ...(options.members === undefined
        ? {}
        : { roster: { roster: { members: options.members } } }),
    },
    spoke: options.spoke ?? { membership: "none" },
  };
}

function harness(answers: Answers) {
  const calls: Array<{ operation: HubAdministrationOperation; body: unknown }> = [];
  const hub = {
    hubAdministrationRequest: vi.fn(
      async (operation: HubAdministrationOperation, body?: unknown) => {
        calls.push({ operation, body });
        const answer = answers[operation];
        const value = typeof answer === "function" ? answer() : answer;
        return value ?? { status: 200, body: {} };
      },
    ),
  };
  const pairing = {
    listRemotePairingRequests: vi.fn(async () => [pendingRequest]),
    approveRemotePairingRequest: vi.fn(async () => {
      throw new Error("not used");
    }),
    denyRemotePairingRequest: vi.fn(async () => ({ decision: "denied" as const })),
  } as unknown as HubSettingsSectionProps["pairing"];
  return { hub, pairing, calls };
}

function renderHub(answers: Answers) {
  const fixture = harness(answers);
  render(<HubSettingsSection hub={fixture.hub} now={() => NOW} pairing={fixture.pairing} />);
  return fixture;
}

describe("hubAdministrationOf", () => {
  it("offers no hub administration to a window without the loopback bridge", () => {
    expect(hubAdministrationOf(undefined)).toBeUndefined();
  });
});

describe("HubSettingsSection", () => {
  it("says why the server refused to turn the hub role on", async () => {
    const user = userEvent.setup();
    renderHub({
      status: { status: 200, body: statusBody({}) },
      enable: { status: 409, body: { status: "refused", kind: "listener-not-running" } },
    });
    const toggle = await screen.findByRole("switch", { name: "Act as hub" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(await screen.findByText(/remote listener is not running/i)).toBeVisible();
    expect(toggle).not.toBeChecked();
  });

  it("shows nothing about adding devices while the hub role is off", async () => {
    renderHub({ status: { status: 200, body: statusBody({}) } });
    await screen.findByRole("switch", { name: "Act as hub" });
    expect(screen.queryByRole("button", { name: "Make a join code" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join the hub" })).toBeDisabled();
  });

  it("shows a join code as QR and text with its time left and asks for an owner when chosen", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: { status: 200, body: statusBody({ enabled: true, members: [] }) },
      "join-code": {
        status: 200,
        body: {
          status: "minted",
          code: "octant-join-abc123",
          expiresAt: NOW + 272_000,
          owner: true,
        },
      },
    });
    await user.click(await screen.findByRole("checkbox", { name: /owner of this hub/i }));
    await user.click(screen.getByRole("button", { name: "Make a join code" }));
    expect(await screen.findByLabelText("Join code")).toHaveTextContent("octant-join-abc123");
    expect(screen.getByRole("img", { name: "Pairing code QR" })).toBeVisible();
    expect(screen.getByText("4:32")).toBeVisible();
    expect(calls.find((call) => call.operation === "join-code")?.body).toEqual({ owner: true });
  });

  it("lists the joining device's comparison code beside an approve step", async () => {
    const user = userEvent.setup();
    const { pairing } = renderHub({
      status: { status: 200, body: statusBody({ enabled: true, members: [] }) },
      "join-code": {
        status: 200,
        body: {
          status: "minted",
          code: "octant-join-abc123",
          expiresAt: NOW + 60_000,
          owner: false,
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: "Make a join code" }));
    const requests = await screen.findByRole("list", { name: "Join requests" });
    expect(within(requests).getByText("482913")).toBeVisible();
    await user.click(within(requests).getByRole("button", { name: "Deny Work laptop" }));
    expect(pairing.denyRemotePairingRequest).toHaveBeenCalledWith(ticketId, "user-denied");
  });

  it("asks before removing a member and removes only after the person confirms", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: statusBody({
          enabled: true,
          members: [
            { memberId: "m-1", name: "Mac mini", role: "hub", owner: true },
            { memberId: "m-2", name: "Work laptop", role: "spoke", owner: false },
          ],
        }),
      },
      remove: { status: 200, body: { status: "removed", sequence: 3 } },
    });
    await user.click(await screen.findByRole("button", { name: "Remove Work laptop" }));
    expect(calls.some((call) => call.operation === "remove")).toBe(false);
    const dialog = await screen.findByRole("dialog", { name: "Remove Work laptop from this hub?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove Work laptop" }));
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "remove")?.body).toEqual({ memberId: "m-2" }),
    );
  });

  it("shows the default hub grant after joining and sends it only when the person accepts", async () => {
    const user = userEvent.setup();
    // The hub approves only after the comparison code has been on screen once.
    const finishAnswers: Answer[] = [
      { status: 200, body: { status: "awaiting-approval" } },
      {
        status: 200,
        body: {
          status: "joined",
          rosterSequence: 1,
          grant: { items: ["roster", "introduce", "owners"], actProjects: [] },
        },
      },
    ];
    const { calls } = renderHub({
      status: { status: 200, body: statusBody({}) },
      join: {
        status: 200,
        body: {
          status: "awaiting-approval",
          hubName: "Mac mini",
          hubKeyFingerprint: "ab".repeat(32),
          comparisonCode: "719203",
        },
      },
      "join-finish": () =>
        finishAnswers.shift() ?? { status: 200, body: { status: "awaiting-approval" } },
      grant: {
        status: 200,
        body: { status: "changed", grant: { items: ["roster", "introduce"], actProjects: [] } },
      },
    });
    await user.type(await screen.findByLabelText("Join code"), "octant-join-abc123");
    await user.click(screen.getByRole("button", { name: "Join the hub" }));
    expect(await screen.findByText("719203")).toBeVisible();
    const accept = await screen.findByRole("button", { name: "Accept" }, { timeout: 4_000 });
    expect(screen.getByRole("checkbox", { name: /Roster/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Introduce/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Owners/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Status/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Act/ })).not.toBeChecked();
    expect(calls.some((call) => call.operation === "grant")).toBe(false);
    await user.click(screen.getByRole("checkbox", { name: /Owners/ }));
    await user.click(accept);
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "grant")?.body).toEqual({
        items: ["roster", "introduce"],
        actProjects: [],
      }),
    );
  });

  it("asks before leaving a hub and tells the person when the hub could not be told", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: statusBody({
          spoke: {
            membership: "member",
            hub: { memberId: "m-1", name: "Mac mini" },
            grant: { items: ["roster"], actProjects: [] },
          },
        }),
      },
      leave: { status: 200, body: { status: "left", hubNotified: false } },
    });
    expect(await screen.findByText("Mac mini")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Leave the hub…" }));
    expect(calls.some((call) => call.operation === "leave")).toBe(false);
    await user.click(await screen.findByRole("button", { name: "Leave the hub" }));
    expect(await screen.findByText(/could not be reached/i)).toBeVisible();
  });
});
