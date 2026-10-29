import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HubMemberId } from "@octant/contracts";
import {
  createGuestSigner,
  createInMemoryDeviceKeyStore,
  type GuestHubRecord,
  type GuestJoinFinish,
  type GuestJoinStart,
  type RemotePairingApproval,
} from "@octant/client-runtime";
import { buildPairingCode } from "@octant/domain";
import { BrowserHubSection } from "./BrowserHubSection";
import type { BrowserGuestState, BrowserGuestStore } from "./browserHubGuest";
import type { PasskeyCredentials } from "./ownerPasskey";

const PAGE = "https://hub.tail1234.ts.net:8443";
const TICKET_ID = "3f6c1d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const HUB_ID = "00000000-0000-4000-8000-000000000001" as HubMemberId;
const bytes = (...values: number[]) => new Uint8Array(values).buffer;

const code = (() => {
  const built = buildPairingCode({
    origin: "https://100.101.102.103:8443",
    ticketId: TICKET_ID,
    ticketProof: Buffer.alloc(32, 7).toString("base64url"),
    pin: `sha256-${Buffer.alloc(32, 9).toString("base64url")}`,
  });
  if (built.status !== "built") throw new Error(built.reason);
  return built.code;
})();

function memoryStore(): BrowserGuestStore & { saved: () => BrowserGuestState | undefined } {
  let held: BrowserGuestState | undefined;
  return {
    load: async () => held,
    save: async (state) => {
      held = state;
    },
    clear: async () => {
      held = undefined;
    },
    saved: () => held,
  };
}

function passkeys(options: { cancel?: boolean } = {}) {
  const creates: CredentialCreationOptions[] = [];
  const credentials: PasskeyCredentials = {
    create: async (request) => {
      creates.push(request);
      if (options.cancel === true) throw new DOMException("declined", "NotAllowedError");
      return {
        rawId: bytes(1, 2, 3),
        response: { getPublicKey: () => bytes(9, 8, 7) },
      } as unknown as Credential;
    },
    get: async () => null,
  };
  return { credentials, creates };
}

async function joinedAfterApproval(): Promise<GuestJoinFinish> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const record: GuestHubRecord = {
    hub: {
      memberId: String(HUB_ID),
      name: "Mac mini",
      origin: PAGE,
      pin: "sha256-AAAA",
      rosterSigningPublicKey: "key",
    },
    selfMemberId: "00000000-0000-4000-8000-000000000009",
    deviceKeyId: "key-1",
    roster: {
      roster: { sequence: 1, members: [], standbyOrder: [], failoverAfterSeconds: 300 },
      signedBy: { kind: "hub", memberId: HUB_ID },
      signature: "signature",
    },
  };
  return {
    status: "joined",
    record,
    signer: await createGuestSigner({ memberId: record.selfMemberId, keyPair }),
    approval: { hostId: String(HUB_ID) } as RemotePairingApproval,
  };
}

function setup(options: { credentials: PasskeyCredentials | null; finish?: GuestJoinFinish }) {
  const store = memoryStore();
  const join = vi.fn(
    async (): Promise<GuestJoinStart> => ({
      status: "awaiting-approval",
      hubName: "Mac mini",
      hubKeyFingerprint: "f".repeat(64),
      comparisonCode: "482913",
      finish: async () => options.finish ?? { status: "awaiting-approval" },
    }),
  );
  render(
    <BrowserHubSection
      credentials={options.credentials}
      deviceKeyStore={createInMemoryDeviceKeyStore()}
      hubAdministration={undefined}
      join={join}
      pageOrigin={PAGE}
      pollMs={5}
      store={store}
    />,
  );
  return { store, join };
}

describe("BrowserHubSection", () => {
  it("shows nothing in a desktop window, which administers its hub directly", () => {
    render(
      <BrowserHubSection
        credentials={null}
        hubAdministration={{ hubAdministrationRequest: vi.fn() }}
        store={memoryStore()}
      />,
    );
    expect(screen.queryByText("Join the hub as a guest")).toBeNull();
  });

  it("joins as a plain guest at the origin that served the page, using only the code's ticket", async () => {
    const user = userEvent.setup();
    const finish = await joinedAfterApproval();
    const { store, join } = setup({ credentials: null, finish });

    await user.type(screen.getByLabelText("Hub join code"), code);
    await user.click(screen.getByRole("button", { name: "Join the hub" }));

    expect(await screen.findByText("Joined Mac mini")).toBeVisible();
    expect(join).toHaveBeenCalledOnce();
    const [options] = join.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(options).toMatchObject({ origin: PAGE, ticket: { ticketId: TICKET_ID } });
    expect(options).not.toHaveProperty("ownerUnlockPublicKey");
    expect(store.saved()?.ownerPasskey).toBeUndefined();
  });

  it("shows the comparison code while the hub has not approved yet", async () => {
    const user = userEvent.setup();
    setup({ credentials: null });

    await user.type(screen.getByLabelText("Hub join code"), code);
    await user.click(screen.getByRole("button", { name: "Join the hub" }));

    expect(await screen.findByText("482913")).toBeVisible();
    expect(screen.getByText(/Approve there only if it shows the same code/)).toBeVisible();
  });

  it("makes a passkey for an owner code, presents only its public key, and keeps the passkey identity", async () => {
    const user = userEvent.setup();
    const { credentials, creates } = passkeys();
    const finish = await joinedAfterApproval();
    const { store, join } = setup({ credentials, finish });

    await user.type(await screen.findByLabelText("Hub join code"), code);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Join the hub" }));

    expect(await screen.findByText("Joined Mac mini")).toBeVisible();
    expect(creates).toHaveLength(1);
    expect(creates[0]?.publicKey?.authenticatorSelection).toMatchObject({
      userVerification: "required",
    });
    const [options] = join.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(options).toMatchObject({ ownerUnlockPublicKey: "CQgH" });
    expect(store.saved()?.ownerPasskey).toEqual({ credentialId: "AQID", publicKey: "CQgH" });
  });

  it("does not contact the hub when the person declines the passkey for an owner code", async () => {
    const user = userEvent.setup();
    const { credentials } = passkeys({ cancel: true });
    const { join } = setup({ credentials });

    await user.type(await screen.findByLabelText("Hub join code"), code);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Join the hub" }));

    expect(
      await screen.findByText("No passkey was made, so nothing was sent to the hub."),
    ).toBeVisible();
    expect(join).not.toHaveBeenCalled();
  });

  it("turns the owner option off and says why when the browser has no passkey support", async () => {
    setup({ credentials: null });

    expect(await screen.findByRole("checkbox")).toBeDisabled();
    expect(screen.getByText(/can join only as a plain guest/)).toBeVisible();
  });

  it("refuses a text that is not a hub code before contacting anything", async () => {
    const user = userEvent.setup();
    const { join } = setup({ credentials: null });

    await user.type(screen.getByLabelText("Hub join code"), "not a code");
    await user.click(screen.getByRole("button", { name: "Join the hub" }));

    await waitFor(() => expect(join).not.toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});
