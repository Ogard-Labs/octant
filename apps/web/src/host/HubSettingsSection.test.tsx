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
    expect(screen.queryByRole("button", { name: "Remove Mac mini" })).toBeNull();
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
    expect(await screen.findAllByText("Join code")).toHaveLength(1);
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

  it("makes the Mac's unlock key when joining and presents only its public half", async () => {
    const user = userEvent.setup();
    const fixture = harness({
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
      "join-finish": { status: 200, body: { status: "awaiting-approval" } },
    });
    const ownerUnlock = {
      ownerUnlockMakeKey: vi.fn(async () => ({ status: "done" as const, publicKey: "cHVibGlj" })),
      ownerUnlockForgetKey: vi.fn(async () => ({ status: "done" as const })),
    };
    render(
      <HubSettingsSection
        hub={fixture.hub}
        now={() => NOW}
        ownerUnlock={ownerUnlock}
        pairing={fixture.pairing}
      />,
    );
    await user.type(await screen.findByLabelText("Join code"), "octant-join-abc123");
    await user.click(screen.getByRole("button", { name: "Join the hub" }));
    expect(await screen.findByText("719203")).toBeVisible();

    await waitFor(() =>
      expect(fixture.calls.find((call) => call.operation === "join-finish")?.body).toEqual({
        unlockPublicKey: "cHVibGlj",
      }),
    );
    expect(ownerUnlock.ownerUnlockMakeKey).toHaveBeenCalledOnce();
  });

  it("joins without a key and says so when this Mac cannot make one", async () => {
    const user = userEvent.setup();
    const fixture = harness({
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
      "join-finish": { status: 200, body: { status: "awaiting-approval" } },
    });
    const ownerUnlock = {
      ownerUnlockMakeKey: vi.fn(async () => ({ status: "refused" as const, kind: "unavailable" })),
      ownerUnlockForgetKey: vi.fn(async () => ({ status: "done" as const })),
    };
    render(
      <HubSettingsSection
        hub={fixture.hub}
        now={() => NOW}
        ownerUnlock={ownerUnlock}
        pairing={fixture.pairing}
      />,
    );
    await user.type(await screen.findByLabelText("Join code"), "octant-join-abc123");
    await user.click(screen.getByRole("button", { name: "Join the hub" }));

    expect(await screen.findByText(/could not make an unlock key/)).toBeVisible();
    await waitFor(() =>
      expect(fixture.calls.some((call) => call.operation === "join-finish")).toBe(true),
    );
    expect(fixture.calls.find((call) => call.operation === "join-finish")?.body).toBeUndefined();
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

  it("lists every member of the hub it joined with its role and whether this computer accepted it", async () => {
    renderHub({
      status: {
        status: 200,
        body: statusBody({
          spoke: {
            membership: "member",
            hub: { memberId: "m-1", name: "Mac mini" },
            grant: { items: ["roster"], actProjects: [] },
            acceptedMemberIds: ["m-3"],
            roster: {
              roster: {
                members: [
                  { memberId: "m-1", name: "Mac mini", role: "hub", owner: true },
                  { memberId: "m-3", name: "Henrik's iPhone", role: "guest", owner: false },
                  { memberId: "m-4", name: "Old iPad", role: "guest", owner: false },
                ],
              },
            },
          },
        }),
      },
    });

    const members = await screen.findByRole("list", { name: "Members of this hub" });
    expect(within(members).getByText(/Henrik's iPhone/)).toBeVisible();
    const phone = within(members).getByText("Henrik's iPhone").closest("li");
    const tablet = within(members).getByText("Old iPad").closest("li");
    expect(phone).toHaveTextContent("guest · accepted here");
    expect(tablet).toHaveTextContent("guest · not accepted here");
    expect(within(members).queryByRole("button")).toBeNull();
  });

  it("keeps the Tailscale certificate off until the person reads the transparency note", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: { status: 200, body: statusBody({}) },
      "certificate-status": {
        status: 200,
        body: { enabled: false, domain: "mini.tail1234.ts.net" },
      },
      certificate: { status: 200, body: { status: "enabled" } },
    });

    const toggle = await screen.findByRole("switch", { name: "Use a Tailscale certificate" });
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/certificate-transparency logs/i)).toBeVisible();

    await user.click(screen.getByRole("checkbox"));
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    await user.click(toggle);

    await waitFor(() =>
      expect(calls.filter((call) => call.operation === "certificate").map((c) => c.body)).toEqual([
        { action: "enable", acknowledgedCertificateTransparency: true },
        { action: "renew" },
      ]),
    );
  });

  it("says why the host could not get the certificate", async () => {
    const user = userEvent.setup();
    renderHub({
      status: { status: 200, body: statusBody({}) },
      "certificate-status": { status: 200, body: { enabled: false } },
      certificate: { status: 409, body: { status: "refused", kind: "https-not-enabled" } },
    });

    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("switch", { name: "Use a Tailscale certificate" }));

    expect(await screen.findByText(/HTTPS certificates are not turned on/i)).toBeVisible();
  });

  it.each([
    ["invalid-certificate", /did not check out/i],
    ["could-not-apply", /could not restart with that certificate/i],
  ])("says why the certificate was not installed (%s)", async (kind, sentence) => {
    const user = userEvent.setup();
    renderHub({
      status: { status: 200, body: statusBody({}) },
      "certificate-status": { status: 200, body: { enabled: false } },
      certificate: { status: 409, body: { status: "refused", kind } },
    });

    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("switch", { name: "Use a Tailscale certificate" }));

    expect(await screen.findByText(sentence)).toBeVisible();
  });
});

const ALERT = "99999999-9999-4999-8999-999999999999";

const PHONE_CANDIDATE = {
  memberId: "m-2",
  name: "Henrik's iPhone",
  identityKeyFingerprint: "2".repeat(64),
  unlockKeyFingerprint: "4".repeat(64),
};

const STUDIO_HELD = {
  memberId: "m-3",
  name: "Studio",
  role: "spoke",
  identityKeyFingerprint: "3".repeat(64),
};

function linkedStatus(
  overrides: {
    readonly items?: ReadonlyArray<string>;
    readonly owners?: ReadonlyArray<Record<string, unknown>>;
    readonly ownerCandidates?: ReadonlyArray<Record<string, unknown>>;
    readonly ownerKeyMismatches?: ReadonlyArray<Record<string, unknown>>;
    readonly confirmNewMembers?: boolean;
    readonly heldMembers?: ReadonlyArray<Record<string, unknown>>;
    readonly alerts?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) {
  return statusBody({
    spoke: {
      membership: "member",
      hub: { memberId: "m-1", name: "Mac mini" },
      grant: { items: overrides.items ?? ["roster", "owners"], actProjects: [] },
      acceptedMemberIds: [],
      roster: {
        roster: {
          members: [
            {
              memberId: "m-1",
              name: "Mac mini",
              role: "hub",
              owner: false,
              identityKeyFingerprint: "1".repeat(64),
            },
            {
              memberId: "m-2",
              name: "Henrik's iPhone",
              role: "guest",
              owner: true,
              identityKeyFingerprint: "2".repeat(64),
            },
            {
              memberId: "m-3",
              name: "Studio",
              role: "spoke",
              owner: false,
              identityKeyFingerprint: "3".repeat(64),
            },
          ],
        },
      },
      owners: overrides.owners ?? [],
      ownerCandidates: overrides.ownerCandidates ?? [],
      ownerKeyMismatches: overrides.ownerKeyMismatches ?? [],
      confirmNewMembers: overrides.confirmNewMembers ?? false,
      heldMembers: overrides.heldMembers ?? [],
      alerts: overrides.alerts ?? [],
    },
  });
}

describe("HubSettingsSection owner devices", () => {
  it("lists the owners this computer keeps by name and fingerprints, never keys", async () => {
    renderHub({
      status: {
        status: 200,
        body: linkedStatus({
          owners: [
            {
              memberId: "m-2",
              name: "Henrik's iPhone",
              identityKeyFingerprint: "2".repeat(64),
              unlockKeyFingerprint: "4".repeat(64),
            },
          ],
        }),
      },
    });

    const owners = await screen.findByRole("list", { name: "Owner devices" });
    expect(within(owners).getByText("Henrik's iPhone")).toBeVisible();
    expect(owners).toHaveTextContent("2".repeat(64));
    expect(owners).toHaveTextContent("4".repeat(64));
  });

  it("adds an owner device the roster lists a key for only after the person confirms its name and both fingerprints, with no key to paste", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: { status: 200, body: linkedStatus({ ownerCandidates: [PHONE_CANDIDATE] }) },
      "owners-add": { status: 200, body: { status: "changed", owners: [] } },
    });

    const add = await screen.findByRole("button", { name: "Add Henrik's iPhone as an owner" });
    expect(screen.queryByLabelText("Unlock key from the device")).toBeNull();
    await user.click(add);
    const dialog = await screen.findByRole("dialog", {
      name: "Add Henrik's iPhone as an owner of this computer?",
    });
    expect(dialog).toHaveTextContent("Henrik's iPhone");
    expect(dialog).toHaveTextContent("2".repeat(64));
    expect(dialog).toHaveTextContent("4".repeat(64));
    expect(calls.some((call) => call.operation === "owners-add")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Add Henrik's iPhone" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "owners-add")?.body).toEqual({
        owners: [
          {
            memberId: "m-2",
            identityKeyFingerprint: "2".repeat(64),
            unlockKeyFingerprint: "4".repeat(64),
          },
        ],
      }),
    );
  });

  it("lists a roster member that carries no unlock key nowhere an owner could be added", async () => {
    renderHub({ status: { status: 200, body: linkedStatus() } });

    await screen.findByRole("switch", { name: "Confirm new members" });

    expect(screen.queryByRole("button", { name: /as an owner/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Devices that could be owners" })).toBeNull();
  });

  it("says plainly that an owner's unlock key changed in the roster and that the key confirmed here is kept", async () => {
    renderHub({
      status: {
        status: 200,
        body: linkedStatus({
          owners: [
            {
              memberId: "m-2",
              name: "Henrik's iPhone",
              identityKeyFingerprint: "2".repeat(64),
              unlockKeyFingerprint: "4".repeat(64),
            },
          ],
          ownerKeyMismatches: [
            {
              memberId: "m-2",
              name: "Henrik's iPhone",
              heldUnlockKeyFingerprint: "4".repeat(64),
              rosterUnlockKeyFingerprint: "6".repeat(64),
            },
          ],
        }),
      },
    });

    const warning = await screen.findByRole("list", { name: "Owners whose unlock key changed" });

    expect(warning).toHaveTextContent("Henrik's iPhone's unlock key changed");
    expect(warning).toHaveTextContent("6".repeat(64));
    expect(warning).toHaveTextContent("keeps the key you confirmed");
  });

  it("says the roster lists a different device key when the host refuses a fingerprint mismatch", async () => {
    const user = userEvent.setup();
    renderHub({
      status: { status: 200, body: linkedStatus({ ownerCandidates: [PHONE_CANDIDATE] }) },
      "owners-add": { status: 409, body: { status: "refused", kind: "identity-mismatch" } },
    });

    await user.click(
      await screen.findByRole("button", { name: "Add Henrik's iPhone as an owner" }),
    );
    await user.click(await screen.findByRole("button", { name: "Add Henrik's iPhone" }));

    expect(await screen.findByText(/roster lists a different device key/i)).toBeVisible();
  });

  it("asks before removing an owner and removes only after the person confirms", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: linkedStatus({
          owners: [
            {
              memberId: "m-2",
              name: "Henrik's iPhone",
              identityKeyFingerprint: "2".repeat(64),
              unlockKeyFingerprint: "4".repeat(64),
            },
          ],
        }),
      },
      "owners-remove": { status: 200, body: { status: "changed", owners: [] } },
    });

    await user.click(
      await screen.findByRole("button", { name: "Remove Henrik's iPhone as an owner" }),
    );
    expect(calls.some((call) => call.operation === "owners-remove")).toBe(false);
    await user.click(await screen.findByRole("button", { name: "Remove Henrik's iPhone" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "owners-remove")?.body).toEqual({
        memberId: "m-2",
      }),
    );
  });

  it("offers no owner list when the hub grant leaves Owners off", async () => {
    renderHub({
      status: {
        status: 200,
        body: linkedStatus({ items: ["roster"], ownerCandidates: [PHONE_CANDIDATE] }),
      },
    });

    expect(await screen.findByText(/Owners item is off in the hub grant/i)).toBeVisible();
    expect(screen.queryByRole("list", { name: "Devices that could be owners" })).toBeNull();
  });

  it("lists the hub's own owners on the hub and offers the members its roster lists a key for", async () => {
    renderHub({
      status: {
        status: 200,
        body: {
          hub: {
            enabled: true,
            roster: {
              roster: {
                members: [
                  {
                    memberId: "m-1",
                    name: "Mac mini",
                    role: "hub",
                    owner: false,
                    identityKeyFingerprint: "1".repeat(64),
                  },
                  {
                    memberId: "m-3",
                    name: "Studio",
                    role: "spoke",
                    owner: false,
                    identityKeyFingerprint: "3".repeat(64),
                  },
                ],
              },
            },
            owners: [
              {
                memberId: "m-9",
                name: "Phone",
                identityKeyFingerprint: "9".repeat(64),
                unlockKeyFingerprint: "8".repeat(64),
              },
            ],
            ownerCandidates: [
              {
                memberId: "m-3",
                name: "Studio",
                identityKeyFingerprint: "3".repeat(64),
                unlockKeyFingerprint: "7".repeat(64),
              },
            ],
          },
          spoke: { membership: "none" },
        },
      },
    });

    const owners = await screen.findByRole("list", { name: "Owner devices" });
    expect(within(owners).getByText("Phone")).toBeVisible();
    const candidates = screen.getByRole("list", { name: "Devices that could be owners" });
    expect(within(candidates).getByText("Studio")).toBeVisible();
    expect(within(candidates).queryByText("Mac mini")).toBeNull();
  });
});

describe("HubSettingsSection new members", () => {
  it("turns Confirm new members on from the window and reports it", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: { status: 200, body: linkedStatus() },
      "confirm-new-members": { status: 200, body: { status: "changed", enabled: true } },
    });

    const toggle = await screen.findByRole("switch", { name: "Confirm new members" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "confirm-new-members")?.body).toEqual({
        enabled: true,
      }),
    );
    expect(await screen.findByText("Confirm new members is on.")).toBeVisible();
  });

  it("confirms a member this computer holds status-only", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: linkedStatus({ confirmNewMembers: true, heldMembers: [STUDIO_HELD] }),
      },
      "confirm-member": { status: 200, body: { status: "confirmed", memberId: "m-3" } },
    });

    const waiting = await screen.findByRole("list", { name: "Members waiting for confirmation" });
    await user.click(within(waiting).getByRole("button", { name: "Confirm Studio" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "confirm-member")?.body).toEqual({
        memberId: "m-3",
      }),
    );
    expect(await screen.findByText("Confirmed Studio.")).toBeVisible();
  });

  it("shows an alert with Dismiss and Remove, and Confirm only for a member held status-only", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: linkedStatus({
          heldMembers: [STUDIO_HELD],
          alerts: [
            {
              alertId: ALERT,
              memberId: "m-3",
              name: "Studio",
              role: "spoke",
              identityKeyFingerprint: "3".repeat(64),
            },
            {
              alertId: "99999999-9999-4999-8999-999999999998",
              memberId: "m-4",
              name: "Old iPad",
              role: "guest",
              identityKeyFingerprint: "5".repeat(64),
            },
          ],
        }),
      },
      "alert-dismiss": { status: 200, body: { status: "dismissed", alertId: ALERT } },
      "alert-remove": { status: 200, body: { status: "removed", alertId: ALERT } },
    });

    const alerts = await screen.findByRole("list", { name: "New member alerts" });
    expect(
      within(alerts).getByRole("button", { name: "Confirm Studio from the alert" }),
    ).toBeVisible();
    expect(
      within(alerts).queryByRole("button", { name: "Confirm Old iPad from the alert" }),
    ).toBeNull();
    await user.click(
      within(alerts).getByRole("button", { name: "Dismiss the alert about Studio" }),
    );
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "alert-dismiss")?.body).toEqual({
        alertId: ALERT,
      }),
    );
    await user.click(
      within(alerts).getByRole("button", { name: "Remove Studio from this computer" }),
    );
    await waitFor(() =>
      expect(calls.find((call) => call.operation === "alert-remove")?.body).toEqual({
        alertId: ALERT,
      }),
    );
  });

  it("says plainly when the host no longer has the alert", async () => {
    const user = userEvent.setup();
    renderHub({
      status: {
        status: 200,
        body: linkedStatus({
          alerts: [
            {
              alertId: ALERT,
              memberId: "m-3",
              name: "Studio",
              role: "spoke",
              identityKeyFingerprint: "3".repeat(64),
            },
          ],
        }),
      },
      "alert-dismiss": { status: 409, body: { status: "refused", kind: "no-such-alert" } },
    });

    await user.click(await screen.findByRole("button", { name: "Dismiss the alert about Studio" }));

    expect(await screen.findByText("That alert is already gone.")).toBeVisible();
  });
});

describe("HubSettingsSection failover", () => {
  const hubBody = (standbyOrder: ReadonlyArray<string>) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder,
          members: [
            { memberId: "m-1", name: "Mac mini", role: "hub", owner: false },
            {
              memberId: "m-2",
              name: "Laptop",
              role: standbyOrder.includes("m-2") ? "standby-hub" : "spoke",
              owner: false,
            },
            { memberId: "m-3", name: "Studio", role: "spoke", owner: false },
          ],
        },
      },
    },
    spoke: { membership: "none" },
  });

  const standbySpoke = (extra: Record<string, unknown>) => ({
    hub: { enabled: false },
    spoke: {
      membership: "member",
      hub: { memberId: "m-1", name: "Mac mini" },
      grant: { items: ["roster", "standby"], actProjects: [] },
      acceptedMemberIds: [],
      roster: { roster: { members: [] } },
      namedStandby: true,
      rosterSignedBy: "hub",
      ...extra,
    },
  });

  it("lists the standby order and lets the window reorder, add, and save it", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: { status: 200, body: hubBody(["m-2"]) },
      "standby-order": { status: 200, body: { status: "ordered" } },
    });

    const order = await screen.findByRole("list", { name: "Standby order" });
    expect(within(order).getByText("1. Laptop")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save the standby order" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Name Laptop a standby" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Name Studio a standby" }));
    await user.click(screen.getByRole("button", { name: "Move Studio up" }));
    expect(within(order).getByText("1. Studio")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save the standby order" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "standby-order")?.body).toEqual({
        memberIds: ["m-3", "m-2"],
      }),
    );
    expect(await screen.findByText("Standby order saved.")).toBeVisible();
  });

  it("says plainly when a named computer's person has not ticked Standby", async () => {
    const user = userEvent.setup();
    renderHub({
      status: { status: 200, body: hubBody([]) },
      "standby-order": { status: 409, body: { status: "refused", kind: "standby-not-granted" } },
    });

    await user.click(await screen.findByRole("button", { name: "Name Laptop a standby" }));
    await user.click(screen.getByRole("button", { name: "Save the standby order" }));

    expect(await screen.findByText(/has not ticked Standby/)).toBeVisible();
  });

  it("shows a standby that is standing in and what it changed", async () => {
    renderHub({
      status: {
        status: 200,
        body: standbySpoke({ standIn: { startedAt: NOW, baseSequence: 3, added: 1, removed: 2 } }),
      },
    });

    expect(await screen.findByText("Standing in for the hub")).toBeVisible();
    expect(screen.getByText(/added 1 and removed 2/)).toBeVisible();
  });

  it("makes a named standby the hub only after the person confirms in its own window", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: { status: 200, body: standbySpoke({}) },
      promote: { status: 200, body: { status: "promoted" } },
    });

    await user.click(await screen.findByRole("button", { name: "Make this computer the hub…" }));
    expect(calls.some((call) => call.operation === "promote")).toBe(false);
    await user.click(await screen.findByRole("button", { name: "Make this the hub" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "promote")?.body).toEqual({
        confirmed: true,
      }),
    );
  });

  it("offers no promotion to a computer the hub did not name a standby", async () => {
    renderHub({ status: { status: 200, body: standbySpoke({ namedStandby: false }) } });

    await screen.findByText("Joined");
    expect(
      screen.queryByRole("button", { name: "Make this computer the hub…" }),
    ).not.toBeInTheDocument();
  });
});

describe("HubSettingsSection wake service", () => {
  const hubWithWake = (wake: unknown) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder: [],
          members: [
            { memberId: "m-1", name: "Mac mini", role: "hub", owner: false },
            { memberId: "m-2", name: "Laptop", role: "spoke", owner: false },
          ],
        },
      },
    },
    spoke: { membership: "none" },
    wake,
  });
  const joinedSpoke = (wake: unknown) => ({
    hub: { enabled: false },
    spoke: {
      membership: "member",
      hub: { memberId: "m-1", name: "Mac mini" },
      grant: { items: ["roster", "wake"], actProjects: [] },
      acceptedMemberIds: [],
      roster: { roster: { members: [] } },
      namedStandby: false,
      rosterSignedBy: "hub",
    },
    wake,
  });

  it("is off until the window turns it on, and then says so", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: hubWithWake({
          hub: { enabled: false, spokes: [] },
          spoke: { sharing: false, reported: 0 },
        }),
      },
      wake: { status: 200, body: { status: "changed", enabled: true } },
    });

    const toggle = await screen.findByRole("switch", { name: "Wake service" });
    expect(toggle).not.toBeChecked();
    expect(calls.some((call) => call.operation === "wake")).toBe(false);
    await user.click(toggle);

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "wake")?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByText(/Wake service is on/)).toBeVisible();
  });

  it("shows each spoke's upcoming wakes and how the last one went", async () => {
    renderHub({
      status: {
        status: 200,
        body: hubWithWake({
          hub: {
            enabled: true,
            spokes: [
              { memberId: "m-2", upcoming: 2, lastResult: { at: NOW, result: "unreachable" } },
            ],
          },
          spoke: { sharing: false, reported: 0 },
        }),
      },
    });

    const list = await screen.findByRole("list", { name: "Spokes the hub wakes" });
    expect(within(list).getByText("Laptop")).toBeVisible();
    expect(
      within(list).getByText("2 wakes ahead · last the computer could not be reached"),
    ).toBeVisible();
  });

  it("says plainly when the server refused the switch", async () => {
    const user = userEvent.setup();
    renderHub({
      status: {
        status: 200,
        body: hubWithWake({
          hub: { enabled: false, spokes: [] },
          spoke: { sharing: false, reported: 0 },
        }),
      },
      wake: { status: 409, body: { status: "refused", kind: "hub-role-off" } },
    });

    await user.click(await screen.findByRole("switch", { name: "Wake service" }));

    expect(await screen.findByText("The hub role is off.")).toBeVisible();
  });

  it("lets a spoke's window enter the optional hardware address", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: joinedSpoke({
          hub: { enabled: false, spokes: [] },
          spoke: { sharing: true, reported: 1 },
        }),
      },
      "wake-hardware-address": { status: 200, body: { status: "changed" } },
    });

    const field = await screen.findByRole("textbox", {
      name: "Hardware address for Wake-on-LAN (optional)",
    });
    expect(field).toHaveValue("");
    const save = screen.getByRole("button", { name: "Save the address" });
    expect(save).toBeDisabled();
    await user.type(field, "aa:bb:cc:00:11:22");
    await user.click(save);

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "wake-hardware-address")?.body).toEqual({
        address: "aa:bb:cc:00:11:22",
      }),
    );
    expect(await screen.findByText("Hardware address saved on this computer.")).toBeVisible();
  });

  it("shows the address the spoke holds and says when the server refuses a bad one", async () => {
    const user = userEvent.setup();
    renderHub({
      status: {
        status: 200,
        body: joinedSpoke({
          hub: { enabled: false, spokes: [] },
          spoke: { sharing: true, reported: 0, hardwareAddress: "aa:bb:cc:00:11:22" },
        }),
      },
      "wake-hardware-address": {
        status: 409,
        body: { status: "refused", kind: "invalid-address" },
      },
    });

    const field = await screen.findByRole("textbox", {
      name: "Hardware address for Wake-on-LAN (optional)",
    });
    expect(field).toHaveValue("aa:bb:cc:00:11:22");
    await user.type(field, "x");
    await user.click(screen.getByRole("button", { name: "Save the address" }));

    expect(await screen.findByText(/not a hardware address/)).toBeVisible();
  });
});

describe("HubSettingsSection offers", () => {
  const OFFER = "55555555-5555-4555-8555-555555555555";
  const hubWithOffers = (provision: unknown) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder: [],
          members: [
            { memberId: "m-1", name: "Mac mini", role: "hub", owner: false },
            { memberId: "m-2", name: "Laptop", role: "spoke", owner: false },
          ],
        },
      },
    },
    spoke: { membership: "none" },
    provision,
  });
  const spokeProvision = (spoke: Record<string, unknown>) => ({
    ...linkedStatus({ items: ["roster", "provision"] }),
    provision: { hub: { enabled: false, offers: [] }, spoke },
  });

  it("is off until the window turns it on, and then says so", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: hubWithOffers({
          hub: { enabled: false, offers: [] },
          spoke: { offering: false, autoApply: [], proposals: [] },
        }),
      },
      provision: { status: 200, body: { status: "changed", enabled: true } },
    });

    const toggle = await screen.findByRole("switch", { name: "Offers" });
    expect(toggle).not.toBeChecked();
    expect(calls.some((call) => call.operation === "provision")).toBe(false);
    await user.click(toggle);

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "provision")?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByText(/Offers are on/)).toBeVisible();
  });

  it("offers a channel, and lists each offer with how each spoke took it", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: hubWithOffers({
          hub: {
            enabled: true,
            offers: [
              {
                offerId: OFFER,
                kind: "plugin",
                deliveries: [{ memberId: "m-2", result: "refused", reason: "kind-unsupported" }],
              },
            ],
          },
          spoke: { offering: false, autoApply: [], proposals: [] },
        }),
      },
      "provision-offer": { status: 200, body: { status: "offered", offerId: OFFER, delivered: 1 } },
    });

    const list = await screen.findByRole("list", { name: "Offers the hub holds" });
    expect(within(list).getByText("plugin")).toBeVisible();
    expect(within(list).getByText("Laptop did not take it")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Offer the preview update channel" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "provision-offer")?.body).toEqual({
        offer: { kind: "update-channel", channel: "preview" },
      }),
    );
  });

  it("shows a spoke its proposals with Apply and Dismiss, and offers no Apply for a routine", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: spokeProvision({
          offering: true,
          autoApply: ["plugin"],
          proposals: [
            {
              offerId: OFFER,
              offer: { kind: "plugin", catalogId: "octant", entryId: "review-helper" },
              expiresAt: "2026-11-05T00:00:00.000Z",
            },
            {
              offerId: "66666666-6666-4666-8666-666666666666",
              offer: { kind: "routine", displayName: "Morning review" },
              expiresAt: "2026-11-05T00:00:00.000Z",
            },
          ],
        }),
      },
      "provision-apply": { status: 200, body: { status: "applied" } },
    });

    const list = await screen.findByRole("list", { name: "Proposals from the hub" });
    expect(
      within(list).getByText(
        "Install review-helper from the octant catalog. It arrives untrusted and switched off.",
      ),
    ).toBeVisible();
    expect(within(list).getAllByRole("button", { name: "Apply" })).toHaveLength(1);
    expect(within(list).getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
    await user.click(within(list).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "provision-apply")?.body).toEqual({
        offerId: OFFER,
      }),
    );
    expect(await screen.findByText("Offer applied.")).toBeVisible();
  });

  it("switches applying on arrival per kind, with none for a routine or an endpoint", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: spokeProvision({ offering: true, autoApply: [], proposals: [] }),
      },
      "provision-auto-apply": { status: 200, body: { status: "changed" } },
    });

    const toggle = await screen.findByRole("switch", {
      name: "Plugin install (untrusted and off)",
    });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getAllByRole("switch").map((entry) => entry.getAttribute("aria-label") ?? ""),
    ).not.toContain("Routine");
    await user.click(toggle);

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "provision-auto-apply")?.body).toEqual({
        kind: "plugin",
        enabled: true,
      }),
    );
  });

  it("shows a spoke that did not tick Provision no proposals at all", async () => {
    renderHub({
      status: {
        status: 200,
        body: spokeProvision({ offering: false, autoApply: [], proposals: [] }),
      },
    });

    await screen.findByText("Hub");
    expect(screen.queryByRole("list", { name: "Proposals from the hub" })).toBeNull();
    expect(screen.queryByText("Offers from the hub")).toBeNull();
  });
});

describe("HubSettingsSection push sender", () => {
  const hubWithPush = (push: unknown) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder: [],
          members: [
            { memberId: "m-1", name: "Mac mini", role: "hub", owner: false },
            { memberId: "m-2", name: "Laptop", role: "spoke", owner: false },
          ],
        },
      },
    },
    spoke: { membership: "none" },
    push,
  });

  it("is off until the window turns it on, and then says so", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: hubWithPush({ hub: { enabled: false, spokes: [] }, spoke: { handing: false } }),
      },
      push: { status: 200, body: { status: "changed", enabled: true } },
    });

    const toggle = await screen.findByRole("switch", { name: "Push sender" });
    expect(toggle).not.toBeChecked();
    expect(calls.some((call) => call.operation === "push")).toBe(false);
    await user.click(toggle);

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "push")?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByText(/Push sender is on/)).toBeVisible();
  });

  it("shows each spoke's forward counts and how the last one went", async () => {
    renderHub({
      status: {
        status: 200,
        body: hubWithPush({
          hub: {
            enabled: true,
            spokes: [
              {
                memberId: "m-2",
                forwarded: 4,
                refused: 1,
                lastResult: { at: NOW, result: "refused" },
              },
            ],
          },
          spoke: { handing: false },
        }),
      },
    });

    const list = await screen.findByRole("list", { name: "Spokes the hub forwards for" });
    expect(within(list).getByText("Laptop")).toBeVisible();
    expect(
      within(list).getByText("4 forwarded · 1 refused · last the hub refused it"),
    ).toBeVisible();
  });

  it("says plainly when the server refused the switch", async () => {
    const user = userEvent.setup();
    renderHub({
      status: {
        status: 200,
        body: hubWithPush({ hub: { enabled: false, spokes: [] }, spoke: { handing: false } }),
      },
      push: { status: 409, body: { status: "refused", kind: "hub-role-off" } },
    });

    await user.click(await screen.findByRole("switch", { name: "Push sender" }));

    expect(await screen.findByText("The hub role is off.")).toBeVisible();
  });
});

describe("HubSettingsSection sign-in requests", () => {
  const REQUEST = "77777777-7777-4777-8777-777777777777";
  const hubWithSignIn = (hub: unknown) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder: [],
          members: [
            { memberId: "m-1", name: "Mac mini", role: "hub", owner: false },
            { memberId: "m-2", name: "Laptop", role: "spoke", owner: false },
            { memberId: "m-3", name: "Phone", role: "guest", owner: false },
          ],
        },
      },
    },
    spoke: { membership: "none" },
    signIn: { hub, spoke: { accepting: false, requests: [] } },
  });
  const spokeSignIn = (spoke: Record<string, unknown>) => ({
    ...linkedStatus({ items: ["roster", "sign-in"] }),
    signIn: { hub: [], spoke },
  });

  it("asks one spoke to sign in to one account kind, and shows the one word that comes back", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: hubWithSignIn([
          { memberId: "m-2", requestId: REQUEST, kind: "claude-subscription", result: "declined" },
        ]),
      },
      "sign-in-ask": { status: 200, body: { status: "asked", requestId: REQUEST } },
    });

    expect(await screen.findByText(/Claude account: declined/)).toBeVisible();
    // A guest runs no agents and has no account to sign in.
    expect(screen.queryByRole("button", { name: "Ask Phone to sign in" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Ask Laptop to sign in" }));
    await user.click(
      screen.getByRole("button", { name: "Ask Laptop to sign in to its Codex account" }),
    );

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "sign-in-ask")?.body).toEqual({
        memberId: "m-2",
        kind: "codex-subscription",
      }),
    );
    expect(await screen.findByText(/finishes the sign-in on that computer/)).toBeVisible();
  });

  it("says plainly why a spoke did not take the request", async () => {
    const user = userEvent.setup();
    renderHub({
      status: { status: 200, body: hubWithSignIn([]) },
      "sign-in-ask": { status: 409, body: { status: "refused", kind: "sign-in-not-granted" } },
    });

    await user.click(await screen.findByRole("button", { name: "Ask Laptop to sign in" }));
    await user.click(
      screen.getByRole("button", { name: "Ask Laptop to sign in to its Claude account" }),
    );

    expect(await screen.findByText(/did not allow sign-in requests/)).toBeVisible();
  });

  it("shows a spoke the request with Accept and Decline, and no command until it accepts", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: spokeSignIn({
          accepting: true,
          requests: [
            {
              requestId: REQUEST,
              kind: "claude-subscription",
              state: "asked",
              expiresAt: "2026-10-29T10:10:00.000Z",
            },
          ],
        }),
      },
      "sign-in-accept": { status: 200, body: { status: "accepted", guidance: "run it" } },
    });

    const list = await screen.findByRole("list", { name: "Sign-in requests from the hub" });
    expect(within(list).getByText(/sign in to your Claude account on this computer/)).toBeVisible();
    expect(within(list).getByText(/Nothing starts until you accept/)).toBeVisible();
    expect(within(list).queryByText(/auth login/)).toBeNull();
    await user.click(within(list).getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "sign-in-accept")?.body).toEqual({
        requestId: REQUEST,
      }),
    );
  });

  it("shows the provider's own command and a check after accepting, and says when it is not signed in yet", async () => {
    const user = userEvent.setup();
    const { calls } = renderHub({
      status: {
        status: 200,
        body: spokeSignIn({
          accepting: true,
          requests: [
            {
              requestId: REQUEST,
              kind: "codex-subscription",
              state: "accepted",
              expiresAt: "2026-10-29T10:10:00.000Z",
              guidance: "Open a terminal on this computer and run codex login.",
            },
          ],
        }),
      },
      "sign-in-check": { status: 200, body: { status: "pending" } },
    });

    const list = await screen.findByRole("list", { name: "Sign-in requests from the hub" });
    expect(within(list).getByText(/run codex login/)).toBeVisible();
    await user.click(within(list).getByRole("button", { name: "Check sign-in" }));

    await waitFor(() =>
      expect(calls.find((call) => call.operation === "sign-in-check")?.body).toEqual({
        requestId: REQUEST,
      }),
    );
    expect(await screen.findByText(/Not signed in yet/)).toBeVisible();
  });

  it("shows a spoke that did not tick Sign-in no requests at all", async () => {
    renderHub({
      status: {
        status: 200,
        body: {
          ...linkedStatus({ items: ["roster"] }),
          signIn: { hub: [], spoke: { accepting: false, requests: [] } },
        },
      },
    });

    await screen.findByText("Hub");
    expect(screen.queryByText("Sign-in requests from the hub")).toBeNull();
  });
});
