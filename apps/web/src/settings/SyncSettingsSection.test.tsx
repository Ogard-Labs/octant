import type { ReplicaStoreSettingsClient } from "@octant/client-runtime/replica-store-settings-client";
import { decodeFolderBrowseResult } from "@octant/contracts/folder-browse";
import {
  decodeReplicaStoreSettingsView,
  type ReplicaStoreSettingsResult,
  type ReplicaStoreSettingsView,
} from "@octant/contracts/replica-store-settings";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  REPLICA_MEMBER_LOCK,
  SYNC_PROVIDER_FACT,
  SyncSettingsSection,
} from "./SyncSettingsSection";

const candidateId = "88888888-8888-4888-8888-888888888888";
const savedBucket = {
  endpoint: "https://s3.example.test",
  region: "eu-north-1",
  bucket: "octant-sync",
  addressing: "path",
} as const;
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function view(overrides: Partial<Record<keyof ReplicaStoreSettingsView, unknown>> = {}) {
  return decodeReplicaStoreSettingsView({
    kind: "replica-store-settings-view",
    store: { kind: "none" },
    syncOn: false,
    version: 0,
    hostId: "local",
    mode: "work",
    credentialStore: "available",
    replicaMember: false,
    ...overrides,
  });
}

function client(
  initial: ReplicaStoreSettingsView,
  answer: (command: unknown) => ReplicaStoreSettingsResult = () => initial,
) {
  const execute = vi.fn(async (command: unknown) => answer(command));
  const fake: ReplicaStoreSettingsClient = {
    read: vi.fn(async () => initial),
    execute: execute as ReplicaStoreSettingsClient["execute"],
  };
  return { fake, execute };
}

const folderBrowse = {
  browse: async () =>
    decodeFolderBrowseResult({
      candidates: [
        { candidateId, displayName: "Dropbox", isGitRepository: false, isSelectable: true },
      ],
      breadcrumbs: [{ label: "henrik" }],
      hasMore: false,
      browsedAt: "2026-10-07T12:00:00.000Z",
    }),
};

describe("SyncSettingsSection", () => {
  it("says store setup happens on the host when this client is not on it", () => {
    render(<SyncSettingsSection client={undefined} folderBrowse={undefined} />);
    expect(
      screen.getByText(
        "Choosing a store and turning sync on happen in the Octant app on the host machine.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("states that the provider can read the files and keeps the switch off until a store is chosen", async () => {
    const { fake } = client(view());
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    const toggle = await screen.findByRole("switch", { name: "Sync artifacts" });
    expect(toggle).not.toBeChecked();
    // The switch recipe marks itself disabled with aria-disabled, not the attribute.
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAttribute("aria-description", "Choose a store first.");
    const fact = screen.getByText(SYNC_PROVIDER_FACT);
    expect(fact).toBeVisible();
    expect(toggle).toHaveAttribute("aria-describedby", fact.id);
    expect(SYNC_PROVIDER_FACT).toBe(
      "Your storage provider can read the synced files: they are signed but not encrypted.",
    );
    // Focusable while off, with its reason announced.
    const test = screen.getByRole("button", { name: "Test connection" });
    expect(test).toHaveAttribute("aria-disabled", "true");
    expect(test).toHaveAccessibleDescription("Turn sync on to test the connection.");
    test.focus();
    expect(test).toHaveFocus();
  });

  it("turns sync on through the host once a folder is chosen", async () => {
    const chosen = view({
      store: { kind: "synced-folder", folder: "/Users/henrik/Dropbox" },
      version: 1,
    });
    const { fake, execute } = client(chosen, () => ({ ...chosen, syncOn: true }));
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    const toggle = await screen.findByRole("switch", { name: "Sync artifacts" });
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("~/Dropbox")).toBeInTheDocument();
    await userEvent.setup().click(toggle);

    expect(execute).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "set-sync",
      syncOn: true,
      expectedVersion: 1,
    });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("chooses a folder through the host's folder browser, sending only the candidate", async () => {
    const user = userEvent.setup();
    const { fake, execute } = client(view());
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await user.click(await screen.findByRole("combobox", { name: "Store" }));
    await user.click(await screen.findByRole("option", { name: "Synced folder" }));
    expect(screen.getByRole("switch", { name: "Sync artifacts" })).toHaveAttribute(
      "aria-description",
      "Choose a folder first.",
    );
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await user.click(await screen.findByRole("button", { name: "Select" }));

    expect(execute).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "choose-synced-folder",
      mode: "work",
      candidateId,
      expectedVersion: 0,
    });
  });

  it("says a bucket cannot be saved on a host with no credential store, and keeps Save off", async () => {
    const user = userEvent.setup();
    const { fake } = client(view({ credentialStore: "unavailable" }));
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await user.click(await screen.findByRole("combobox", { name: "Store" }));
    await user.click(await screen.findByRole("option", { name: "S3-compatible bucket" }));
    const guidance = screen.getByText(/cannot reach a Keychain or Secret Service on this computer/);
    expect(guidance).toBeVisible();
    const endpoint = screen.getByRole("textbox", { name: "Endpoint" });
    // The guidance comes before the fields it explains, and the fields are off.
    expect(
      guidance.compareDocumentPosition(endpoint) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(endpoint).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves a bucket with its key pair and lets go of the secret afterwards", async () => {
    const user = userEvent.setup();
    const saved = view({
      store: {
        kind: "s3",
        settings: {
          endpoint: "https://s3.example.test",
          region: "eu-north-1",
          bucket: "octant-sync",
          addressing: "path",
        },
        credentials: "saved",
      },
      version: 1,
    });
    const { fake, execute } = client(view(), () => saved);
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await user.click(await screen.findByRole("combobox", { name: "Store" }));
    await user.click(await screen.findByRole("option", { name: "S3-compatible bucket" }));
    await user.type(screen.getByRole("textbox", { name: "Endpoint" }), "https://s3.example.test");
    await user.type(screen.getByRole("textbox", { name: "Region" }), "eu-north-1");
    await user.type(screen.getByRole("textbox", { name: "Bucket" }), "octant-sync");
    await user.type(screen.getByRole("textbox", { name: "Access key ID" }), "AKIAEXAMPLE");
    await user.type(screen.getByLabelText("Secret access key"), SECRET);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(execute).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "configure-s3",
      settings: {
        endpoint: "https://s3.example.test",
        region: "eu-north-1",
        bucket: "octant-sync",
        addressing: "path",
      },
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
      expectedVersion: 0,
    });
    await waitFor(() => expect(screen.getByLabelText("Secret access key")).toHaveValue(""));
    expect(screen.getByRole("textbox", { name: "Access key ID" })).toHaveValue("");
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(screen.getByRole("switch", { name: "Sync artifacts" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("refuses a plain http endpoint before anything is sent", async () => {
    const user = userEvent.setup();
    const { fake, execute } = client(view());
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await user.click(await screen.findByRole("combobox", { name: "Store" }));
    await user.click(await screen.findByRole("option", { name: "S3-compatible bucket" }));
    await user.type(screen.getByRole("textbox", { name: "Endpoint" }), "http://s3.example.test");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The endpoint must be an https address with no path.",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows the host's Test connection answer once sync is on", async () => {
    const on = view({
      store: { kind: "synced-folder", folder: "/Users/henrik/Dropbox" },
      syncOn: true,
      version: 2,
    });
    const { fake, execute } = client(on, () => ({
      kind: "replica-store-connection-tested",
      outcome: "reachable",
      message: "Octant wrote a probe file in the folder.",
    }));
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Test connection" }));

    expect(execute).toHaveBeenCalledWith({ schemaVersion: 1, kind: "test-connection" });
    expect(await screen.findByText("Octant wrote a probe file in the folder.")).toBeVisible();
  });

  it("asks before choosing no store, and Cancel leaves the bucket in place", async () => {
    const user = userEvent.setup();
    const bucketView = view({
      store: {
        kind: "s3",
        settings: savedBucket,
        credentials: "saved",
      },
      syncOn: true,
      version: 3,
    });
    const { fake, execute } = client(bucketView, () => view({ version: 4 }));
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await user.click(await screen.findByRole("combobox", { name: "Store" }));
    await user.click(await screen.findByRole("option", { name: "None" }));

    const dialog = await screen.findByRole("dialog", { name: "Choose no store?" });
    expect(dialog).toHaveTextContent(
      "Sync stops, and this bucket's saved access key and secret are removed from this computer.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Store" })).toHaveTextContent(
      "S3-compatible bucket",
    );
    expect(screen.getByRole("switch", { name: "Sync artifacts" })).toBeChecked();

    await user.click(screen.getByRole("combobox", { name: "Store" }));
    await user.click(await screen.findByRole("option", { name: "None" }));
    await user.click(await screen.findByRole("button", { name: "Stop syncing" }));

    expect(execute).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "clear-store",
      expectedVersion: 3,
    });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Sync artifacts" })).not.toBeChecked(),
    );
  });

  it("locks the store on a computer that belongs to a replica, but keeps the switch", async () => {
    const user = userEvent.setup();
    const member = view({
      store: { kind: "s3", settings: savedBucket, credentials: "saved" },
      syncOn: true,
      version: 5,
      replicaMember: true,
    });
    const { fake, execute } = client(member, () => view({ ...member, syncOn: false, version: 6 }));
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    expect(await screen.findByText(REPLICA_MEMBER_LOCK)).toBeVisible();
    expect(REPLICA_MEMBER_LOCK).toBe(
      "This computer belongs to a replica in this store. The store can't be changed until leaving a replica is supported.",
    );
    expect(screen.getByRole("combobox", { name: "Store" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("textbox", { name: "Endpoint" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Bucket" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Prefix" })).toBeDisabled();
    // A new key pair for the same bucket is still allowed.
    expect(screen.getByRole("textbox", { name: "Access key ID" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    const toggle = screen.getByRole("switch", { name: "Sync artifacts" });
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    await user.click(toggle);
    expect(execute).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "set-sync",
      syncOn: false,
      expectedVersion: 5,
    });
  });

  it("asks for a new key pair when the bucket moves, and says saving turns sync off", async () => {
    const user = userEvent.setup();
    const on = view({
      store: { kind: "s3", settings: savedBucket, credentials: "saved" },
      syncOn: true,
      version: 2,
    });
    const { fake, execute } = client(on);
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    const keyField = await screen.findByRole("textbox", { name: "Access key ID" });
    expect(keyField).toHaveAttribute("placeholder", "Saved — leave blank to keep");
    expect(screen.queryByText("Saving turns sync off.")).not.toBeInTheDocument();

    const bucketField = screen.getByRole("textbox", { name: "Bucket" });
    await user.clear(bucketField);
    await user.type(bucketField, "other-bucket");
    expect(keyField).not.toHaveAttribute("placeholder");
    expect(screen.getByText("Saving turns sync off.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "A different endpoint, bucket, or addressing needs its own access key and secret.",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows the host's refusal at the bucket form and moves focus to it", async () => {
    const user = userEvent.setup();
    const saved = view({
      store: { kind: "s3", settings: savedBucket, credentials: "saved" },
      version: 2,
    });
    const { fake } = client(saved, () => ({
      kind: "replica-store-refused",
      reason: "credential-store-unavailable",
      message: "The access key could not be saved in this computer's credential store.",
    }));
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await user.type(await screen.findByRole("textbox", { name: "Access key ID" }), "AKIANEW");
    await user.type(screen.getByLabelText("Secret access key"), SECRET);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The access key could not be saved in this computer's credential store.",
    );
    expect(screen.getByRole("form", { name: "Bucket connection" })).toContainElement(alert);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("rebuilds the bucket form from the host's settings after a stale refusal", async () => {
    const user = userEvent.setup();
    const first = view({
      store: { kind: "s3", settings: savedBucket, credentials: "saved" },
      version: 2,
    });
    const moved = view({
      store: { kind: "s3", settings: { ...savedBucket, prefix: "laptop" }, credentials: "saved" },
      version: 3,
    });
    const { fake } = client(first, () => ({
      kind: "replica-store-refused",
      reason: "stale-version",
      message: "The sync settings changed since you read them.",
    }));
    vi.mocked(fake.read).mockResolvedValueOnce(first).mockResolvedValue(moved);
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    const regionField = await screen.findByRole("textbox", { name: "Region" });
    await user.clear(regionField);
    await user.type(regionField, "us-east-1");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Prefix" })).toHaveValue("laptop"),
    );
    expect(screen.getByRole("textbox", { name: "Region" })).toHaveValue("eu-north-1");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The sync settings changed since you read them.",
    );
  });

  it("does not label the sync folder picker as a Work folder", async () => {
    const user = userEvent.setup();
    const { fake } = client(view());
    render(<SyncSettingsSection client={fake} folderBrowse={folderBrowse} />);

    await user.click(await screen.findByRole("combobox", { name: "Store" }));
    await user.click(await screen.findByRole("option", { name: "Synced folder" }));
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));

    const dialog = await screen.findByRole("dialog", { name: "Sync folder" });
    expect(dialog).not.toHaveTextContent(/^Work/);
    expect(within(dialog).queryByText("Work", { exact: true })).not.toBeInTheDocument();
  });
});
