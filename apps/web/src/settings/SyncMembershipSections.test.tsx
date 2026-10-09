import type { ReplicaMembershipClient } from "@octant/client-runtime/replica-membership-client";
import type { ReplicaSyncStatusClient } from "@octant/client-runtime/replica-sync-status-client";
import {
  decodeReplicaMembershipResult,
  decodeReplicaMembershipView,
  decodeReplicaSyncStatusView,
  type ReplicaMembershipView,
} from "@octant/contracts/replica-entry";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  SYNC_STATUS_NOT_AVAILABLE,
  SYNC_STORE_NOT_READY,
  SyncMembershipSections,
} from "./SyncMembershipSections";
import { SyncSettingsSection } from "./SyncSettingsSection";

const studio = "11111111-1111-4111-8111-111111111111";
const laptop = "22222222-2222-4222-8222-222222222222";
const phone = "33333333-3333-4333-8333-333333333333";
const key = `${"A".repeat(59)}=`;
const status = {
  lastPublish: { kind: "not-available" },
  lastPull: { kind: "not-available" },
  queued: { kind: "not-available" },
};

function view(overrides: Record<string, unknown> = {}): ReplicaMembershipView {
  return decodeReplicaMembershipView({
    kind: "replica-membership-view",
    computerName: "Studio Mac",
    thisComputer: { kind: "none" },
    members: [],
    joinRequests: [],
    status,
    ...overrides,
  });
}

const founderMembers = [
  {
    instanceId: studio,
    displayName: "Studio Mac",
    role: { kind: "founder" },
    revoked: false,
    thisComputer: true,
    revocable: false,
  },
  {
    instanceId: laptop,
    displayName: "Laptop",
    role: { kind: "approved", approver: studio, approverName: "Studio Mac" },
    revoked: false,
    thisComputer: false,
    revocable: true,
  },
];

function client(
  initial: ReplicaMembershipView,
  answer: (command: { readonly kind: string }) => unknown = () => ({
    kind: "pulled",
    applied: 0,
    refused: [],
    artifacts: [],
    joinRequests: [],
  }),
) {
  let current = initial;
  const execute = vi.fn(async (command: { readonly kind: string }) =>
    decodeReplicaMembershipResult(answer(command)),
  );
  const fake: ReplicaMembershipClient = {
    read: vi.fn(async () => current),
    execute: execute as unknown as ReplicaMembershipClient["execute"],
  };
  return {
    fake,
    execute,
    setView: (next: ReplicaMembershipView) => {
      current = next;
    },
  };
}

function renderSections(fake: ReplicaMembershipClient, storeReady = true) {
  const onMembershipChange = vi.fn();
  render(
    <SyncMembershipSections
      client={fake}
      onMembershipChange={onMembershipChange}
      storeReady={storeReady}
    />,
  );
  return { onMembershipChange };
}

describe("SyncMembershipSections", () => {
  it("keeps Set up sync and Ask to join off until the store is ready, and says why", async () => {
    const { fake, execute } = client(view());
    renderSections(fake, false);
    const create = await screen.findByRole("button", { name: "Set up sync" });
    expect(create).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask to join" })).toBeDisabled();
    expect(screen.getAllByText(SYNC_STORE_NOT_READY).length).toBeGreaterThan(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("creates a replica under the name the person gave this computer", async () => {
    const created = view({
      thisComputer: { kind: "founder", instanceId: studio, displayName: "Desk" },
      members: [{ ...founderMembers[0], displayName: "Desk" }],
    });
    const { fake, execute, setView } = client(view(), (command) => {
      setView(created);
      return command.kind === "create-replica"
        ? {
            kind: "replica-created",
            instanceId: studio,
            entry: {
              format: "octant.replica-entry/2",
              kind: "replica-founded",
              origin: { instanceId: studio, displayName: "Desk", sequence: 1, publicKey: key },
            },
          }
        : {};
    });
    const { onMembershipChange } = renderSections(fake);
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "Computer name" });
    expect(name).toHaveValue("Studio Mac");
    await user.clear(name);
    await user.type(name, "Desk");
    await user.click(screen.getByRole("button", { name: "Set up sync" }));

    expect(execute).toHaveBeenCalledWith({ kind: "create-replica", displayName: "Desk" });
    expect(await screen.findByText("This computer set up a replica in the store.")).toBeVisible();
    expect(onMembershipChange).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Join requests" })).toBeVisible();
  });

  it("shows the joining computer each approver's code and confirms only an approved join", async () => {
    const joining = (approved: boolean) =>
      view({
        thisComputer: {
          kind: "joining",
          instanceId: laptop,
          displayName: "Laptop",
          fresh: true,
          approvers: [
            {
              instanceId: studio,
              displayName: "Studio Mac",
              matchingCode: "482913",
              approvedThisComputer: approved,
            },
          ],
        },
      });
    const { fake, execute, setView } = client(joining(false), (command) => {
      if (command.kind === "pull") {
        setView(joining(true));
        return { kind: "pulled", applied: 1, refused: [], artifacts: [], joinRequests: [] };
      }
      return { kind: "join-confirmed", approver: studio, founder: studio };
    });
    renderSections(fake);
    const user = userEvent.setup();

    expect(await screen.findByText("482 913")).toBeVisible();
    expect(screen.getByText("Shows this code when it approves this computer.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm join" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check the store" }));
    expect(execute).toHaveBeenCalledWith({ kind: "pull" });
    await user.click(await screen.findByRole("button", { name: "Confirm join" }));
    expect(execute).toHaveBeenLastCalledWith({
      kind: "confirm-join",
      approver: studio,
      confirmationCode: "482913",
    });
    expect(
      await screen.findByText("This computer joined. Studio Mac brought it in."),
    ).toBeVisible();
  });

  it("approves a join request only from the dialog where the person confirms the codes match", async () => {
    const request = {
      format: "octant.replica-entry/2",
      kind: "join-request",
      origin: { instanceId: phone, displayName: "Travel Mac", sequence: 1, publicKey: key },
      requestedAt: Date.parse("2026-10-09T08:00:00.000Z"),
    };
    const { fake, execute } = client(
      view({
        thisComputer: { kind: "founder", instanceId: studio, displayName: "Studio Mac" },
        members: [founderMembers[0]],
        joinRequests: [{ request, matchingCode: "120034", approvedByThisComputer: false }],
      }),
      () => ({
        kind: "join-approved",
        subject: phone,
        entry: {
          format: "octant.replica-entry/2",
          kind: "join-approved",
          origin: { instanceId: studio, displayName: "Studio Mac", sequence: 2, publicKey: key },
          subject: phone,
          subjectKey: key,
          subjectName: "Travel Mac",
        },
      }),
    );
    renderSections(fake);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Approve…" }));
    let dialog = await screen.findByRole("dialog", { name: "Approve Travel Mac?" });
    expect(within(dialog).getByText("120 034")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(execute).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Approve…" }));
    dialog = await screen.findByRole("dialog", { name: "Approve Travel Mac?" });
    await user.click(within(dialog).getByRole("button", { name: "Codes match, approve" }));
    expect(execute).toHaveBeenCalledWith({
      kind: "approve-join",
      joinRequest: request,
      confirmationCode: "120034",
    });
    expect(await screen.findByText("Approved Travel Mac. Confirm on that computer.")).toBeVisible();
  });

  it("previews a revoke, offers the computers it brought in and an earlier cut, then revokes", async () => {
    const commands: unknown[] = [];
    const { fake } = client(
      view({
        thisComputer: { kind: "founder", instanceId: studio, displayName: "Studio Mac" },
        members: founderMembers,
      }),
      (command) => {
        commands.push(command);
        if (command.kind === "revoke-preview") {
          return {
            kind: "revoke-preview",
            subject: laptop,
            cut: 6,
            broughtIn: [
              {
                instanceId: phone,
                displayName: "Travel Mac",
                parent: laptop,
                approvalSequence: 3,
              },
            ],
            subjectRevocations: [{ sequence: 5, subject: studio, cut: 0 }],
            readStore: true,
          };
        }
        return {
          kind: "revoked",
          subject: laptop,
          entry: {
            format: "octant.replica-entry/2",
            kind: "revocation",
            origin: { instanceId: studio, displayName: "Studio Mac", sequence: 3, publicKey: key },
            subject: laptop,
            cut: 4,
          },
          alsoRevoked: [
            {
              format: "octant.replica-entry/2",
              kind: "revocation",
              origin: {
                instanceId: studio,
                displayName: "Studio Mac",
                sequence: 4,
                publicKey: key,
              },
              subject: phone,
              cut: 1,
            },
          ],
          readStore: true,
        };
      },
    );
    renderSections(fake);
    const user = userEvent.setup();

    // This computer is listed without a Revoke control; only Laptop has one.
    await user.click(await screen.findByRole("button", { name: "Revoke Laptop" }));
    expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(1);
    const dialog = await screen.findByRole("dialog", { name: "Revoke Laptop?" });
    expect(commands).toEqual([{ kind: "revoke-preview", subject: laptop }]);
    expect(within(dialog).getByText(/entries up to its entry 6 keep counting/)).toBeVisible();
    expect(within(dialog).getByText("It revoked Studio Mac at its entry 5.")).toBeVisible();

    await user.click(within(dialog).getByRole("checkbox", { name: "Also revoke Travel Mac" }));
    await user.click(
      within(dialog).getByRole("checkbox", { name: /Stop counting before its first revocation/ }),
    );
    expect(within(dialog).getByText(/entries up to its entry 4 keep counting/)).toBeVisible();
    // The safe action has focus; the destructive one is the dialog's own.
    const confirm = within(dialog).getByRole("button", { name: "Revoke Laptop" });
    await user.click(confirm);

    expect(commands.at(-1)).toEqual({
      kind: "revoke",
      subject: laptop,
      cut: 4,
      alsoRevoke: [phone],
    });
    expect(await screen.findByText("Revoked Laptop and Travel Mac.")).toBeVisible();
  });

  it("does not offer to approve a request this computer already approved", async () => {
    const { fake } = client(
      view({
        thisComputer: { kind: "founder", instanceId: studio, displayName: "Studio Mac" },
        members: [founderMembers[0]],
        joinRequests: [
          {
            request: {
              format: "octant.replica-entry/2",
              kind: "join-request",
              origin: { instanceId: phone, displayName: "Travel Mac", sequence: 1, publicKey: key },
              requestedAt: 0,
            },
            matchingCode: "120034",
            approvedByThisComputer: true,
          },
        ],
      }),
    );
    renderSections(fake);
    expect(await screen.findByText("Waiting for it to confirm")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve…" })).not.toBeInTheDocument();
  });

  it("says a strict-ancestor refusal in plain words and opens no dialog", async () => {
    const { fake } = client(
      view({
        thisComputer: { kind: "founder", instanceId: studio, displayName: "Studio Mac" },
        members: founderMembers,
      }),
      () => ({
        kind: "refused",
        reason: "not-a-descendant",
        message:
          "Only a computer this one brought in can be revoked from here; revoke it from the computer that approved it.",
      }),
    );
    renderSections(fake);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Revoke Laptop" }));
    expect(
      await screen.findByText(
        "Only a computer this one brought in can be revoked from here; revoke it from the computer that approved it.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says which status lines are not available yet and states the last store error", async () => {
    const { fake } = client(
      view({
        status: {
          ...status,
          lastError: { at: "2026-10-09T08:30:00.000Z", phase: "list", reason: "not-connected" },
        },
      }),
    );
    renderSections(fake);
    const section = await screen.findByRole("region", { name: "Sync status" });
    expect(within(section).getAllByText(SYNC_STATUS_NOT_AVAILABLE)).toHaveLength(3);
    expect(within(section).getByText(/The store could not be reached\.$/)).toBeVisible();
  });
});

describe("Settings › Sync off the host", () => {
  it("shows status and the computers read-only, with nothing to set up, approve, or revoke", async () => {
    const statusClient: ReplicaSyncStatusClient = {
      read: vi.fn(async () => ({
        status: "ready" as const,
        view: decodeReplicaSyncStatusView({
          kind: "replica-sync-status",
          thisComputer: "founder",
          members: [
            {
              displayName: "Studio Mac",
              role: { kind: "founder" },
              revoked: false,
              thisComputer: true,
            },
            {
              displayName: "Laptop",
              role: { kind: "approved", approverName: "Studio Mac" },
              revoked: true,
              thisComputer: false,
            },
          ],
          status,
        }),
      })),
    };
    render(
      <SyncSettingsSection client={undefined} folderBrowse={undefined} status={statusClient} />,
    );

    expect(
      await screen.findByText(
        "Setting up sync, joining, and revoking happen in the Octant app on the host machine.",
      ),
    ).toBeVisible();
    const section = screen.getByRole("region", { name: "Sync status" });
    expect(within(section).getByText("Set up sync")).toBeVisible();
    expect(screen.getByText("Approved by Studio Mac · revoked")).toBeVisible();
    await waitFor(() => expect(statusClient.read).toHaveBeenCalled());
    for (const name of [/Set up sync/, /Ask to join/, /Approve/, /Revoke/, /Check the store/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
