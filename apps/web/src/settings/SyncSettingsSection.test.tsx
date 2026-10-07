import type { ReplicaStoreSettingsClient } from "@octant/client-runtime/replica-store-settings-client";
import { decodeFolderBrowseResult } from "@octant/contracts/folder-browse";
import {
  decodeReplicaStoreSettingsView,
  type ReplicaStoreSettingsResult,
  type ReplicaStoreSettingsView,
} from "@octant/contracts/replica-store-settings";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SYNC_PROVIDER_FACT, SyncSettingsSection } from "./SyncSettingsSection";

const candidateId = "88888888-8888-4888-8888-888888888888";
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
    const fact = screen.getByText(SYNC_PROVIDER_FACT);
    expect(fact).toBeVisible();
    expect(toggle).toHaveAttribute("aria-describedby", fact.id);
    expect(SYNC_PROVIDER_FACT).toBe(
      "Your storage provider can read the synced files: they are signed but not encrypted.",
    );
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
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
    expect(
      screen.getByText(/cannot reach a Keychain or Secret Service on this computer/),
    ).toBeVisible();
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
});
