import {
  decodeProtectedFilesSettings,
  type ProtectedFilesResult,
  type ProtectedFilesSettings as ProtectedFilesSnapshot,
} from "@octant/contracts/protected-files";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    const user = userEvent.setup();
    render(<ProtectedFilesSettings client={fake} />);
    expect(await screen.findByText("SSH private keys")).toBeVisible();
    // A closed row already says it is protected and which paths it guards.
    expect(screen.getAllByText(/^Protected ·/).length).toBeGreaterThan(0);
    expect(screen.getByText(/~\/\.ssh\/id_\* \(not \.pub\)/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "SSH private keys" }));
    expect(screen.getByRole("button", { name: "SSH private keys" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The detail holds the full list again, beside the closed row's cut line.
    expect(screen.getAllByText(/~\/\.ssh\/id_\* \(not \.pub\)/)).toHaveLength(2);
    expect(screen.getByText(PROTECTED_FILES_FACT)).toBeVisible();
  });

  it("shows a long added path in full, since the row has no detail to open", async () => {
    const first =
      "~/Library/Application Support/Some Vendor/Some Product/profiles/work/tokens.json";
    const second =
      "~/Library/Application Support/Some Vendor/Some Product/profiles/home/tokens.json";
    const { fake } = client(snapshot({ added: [first, second] }));
    render(<ProtectedFilesSettings client={fake} />);

    const row = (await screen.findByText(first)).closest(".crow");
    expect(screen.getByText(second)).toBeVisible();
    // The name wraps: cut with an ellipsis, these two could not be told apart.
    expect(row).toHaveAttribute("data-label", "wrap");
    const css = readFileSync(resolve(process.cwd(), "src/styles/settings.css"), "utf8");
    expect(css).toMatch(
      /\.crow\[data-label="wrap"\] \.crow__name \{[^}]*white-space: normal;[^}]*\}/,
    );
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
