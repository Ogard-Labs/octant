import {
  decodeProtectedFilesSettings,
  type ProtectedFilesResult,
  type ProtectedFilesSettings as ProtectedFilesSnapshot,
} from "@octant/contracts/protected-files";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PROTECTED_FILES_FACT, ProtectedFilesSettings } from "./ProtectedFilesSettings";

function snapshot(overrides: Readonly<Record<string, unknown>> = {}): ProtectedFilesSnapshot {
  return decodeProtectedFilesSettings({
    kind: "protected-files-settings",
    builtIns: [
      {
        id: "ssh-private-keys",
        label: "SSH private keys",
        paths: ["~/.ssh/id_* (not .pub)"],
        channel: "ssh-agent",
        removed: false,
      },
      {
        id: "cluster-configuration",
        label: "Cluster configuration",
        paths: ["~/.kube/config"],
        channel: "credential-broker",
        removed: false,
      },
    ],
    added: [],
    version: 2,
    ...overrides,
  });
}

function client(initial: ProtectedFilesSnapshot, answer?: () => ProtectedFilesResult) {
  const change = vi.fn(
    async (): Promise<ProtectedFilesResult> =>
      answer?.() ?? { kind: "protected-files-settings", settings: initial },
  );
  return { change, fake: { settings: vi.fn(async () => initial), change } };
}

describe("ProtectedFilesSettings", () => {
  it("lists the protected groups and says no agent reaches them at any level", async () => {
    const { fake } = client(snapshot());
    render(<ProtectedFilesSettings client={fake} />);
    expect(await screen.findByText("SSH private keys")).toBeVisible();
    expect(screen.getByText("~/.ssh/id_* (not .pub)")).toBeVisible();
    expect(screen.getByText(PROTECTED_FILES_FACT)).toBeVisible();
  });

  it("asks before removing a built-in group and sends the confirmation", async () => {
    const user = userEvent.setup();
    const { fake, change } = client(snapshot());
    render(<ProtectedFilesSettings client={fake} />);
    const row = (await screen.findByText("Cluster configuration")).closest("[data-setting-id]");
    if (!(row instanceof HTMLElement)) throw new Error("expected the group's row");
    await user.click(within(row).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Every agent on this computer/u)).toBeVisible();
    expect(change).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove protection" }));

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith({
        kind: "remove-built-in-protected-files",
        id: "cluster-configuration",
        confirmed: true,
        expectedVersion: 2,
      }),
    );
  });

  it("removes nothing when the person cancels", async () => {
    const user = userEvent.setup();
    const { fake, change } = client(snapshot());
    render(<ProtectedFilesSettings client={fake} />);
    const row = (await screen.findByText("SSH private keys")).closest("[data-setting-id]");
    if (!(row instanceof HTMLElement)) throw new Error("expected the group's row");
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(change).not.toHaveBeenCalled();
  });

  it("adds a path from the version the person read and refuses a relative one", async () => {
    const user = userEvent.setup();
    const { fake, change } = client(snapshot(), () => ({
      kind: "protected-files-settings",
      settings: snapshot({ added: ["~/secrets"], version: 3 }),
    }));
    render(<ProtectedFilesSettings client={fake} />);
    const input = await screen.findByRole("textbox", { name: "Path to protect" });

    await user.type(input, "secrets");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(change).not.toHaveBeenCalled();
    expect(await screen.findByText(/starts with ~\//u)).toBeVisible();

    await user.clear(input);
    await user.type(input, "~/secrets");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith({
        kind: "add-protected-path",
        path: "~/secrets",
        expectedVersion: 2,
      }),
    );
    expect(await screen.findByText("~/secrets")).toBeVisible();
    expect(input).toHaveValue("");
  });

  it("offers to protect a removed group again", async () => {
    const user = userEvent.setup();
    const removed = snapshot({
      builtIns: [
        {
          id: "cluster-configuration",
          label: "Cluster configuration",
          paths: ["~/.kube/config"],
          channel: "credential-broker",
          removed: true,
        },
      ],
    });
    const { fake, change } = client(removed);
    render(<ProtectedFilesSettings client={fake} />);
    await user.click(await screen.findByRole("button", { name: "Protect again" }));
    expect(change).toHaveBeenCalledWith({
      kind: "restore-built-in-protected-files",
      id: "cluster-configuration",
      expectedVersion: 2,
    });
  });
});
