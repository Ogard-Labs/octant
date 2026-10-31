import type { SecretStoresClient } from "@octant/client-runtime/secret-stores-client";
import { decodeProviderInstanceId } from "@octant/contracts";
import {
  decodeSecretStoresResult,
  type SecretStoresCommand,
  type SecretStoresResult,
} from "@octant/contracts/secret-stores";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderLinkedKeyEditor } from "../providers/ProviderLinkedKeyEditor";
import { SecretStoresClientContext } from "./SecretStoresClientContext";
import { SecretStoresSettingsSection } from "./SecretStoresSettingsSection";

const REFERENCE = "op://Private/Gateway key/credential";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000501");

function viewOf(linked: boolean, tool: "ready" | "locked" = "ready", brokerAvailable = true) {
  return decodeSecretStoresResult({
    kind: "secret-stores-view",
    brokerAvailable,
    stores: brokerAvailable
      ? [
          {
            kind: "onepassword",
            label: "1Password",
            linked,
            ...(linked ? { linkedAt: "2026-10-31T10:00:00.000Z" } : {}),
            tool,
          },
        ]
      : [],
  });
}

function fakeClient(
  initial: SecretStoresResult,
  answer: (command: SecretStoresCommand) => SecretStoresResult = () => initial,
) {
  const commands: SecretStoresCommand[] = [];
  const client: SecretStoresClient = {
    read: vi.fn(async () => initial),
    execute: vi.fn(async (command) => {
      commands.push(command);
      return answer(command);
    }),
  };
  return { client, commands };
}

describe("SecretStoresSettingsSection", () => {
  it("says linking happens on the host when this client is not on it", () => {
    render(<SecretStoresSettingsSection client={undefined} />);
    expect(
      screen.getByText("Linking a secret store happens in the Octant app on the host machine."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says plainly that a host with no credential broker cannot link a store", async () => {
    const { client } = fakeClient(viewOf(false, "ready", false));
    render(<SecretStoresSettingsSection client={client} />);
    expect(await screen.findByText(/no credential broker/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Link/ })).not.toBeInTheDocument();
  });

  it("links the store, and shows why a locked one was not linked", async () => {
    const user = userEvent.setup();
    const { client, commands } = fakeClient(viewOf(false), (command) =>
      command.kind === "link-store"
        ? decodeSecretStoresResult({
            kind: "secret-stores-refused",
            reason: "store-locked",
            message: "The secret store is locked. Unlock it, then try again.",
          })
        : viewOf(false),
    );
    render(<SecretStoresSettingsSection client={client} />);
    await user.click(await screen.findByRole("button", { name: "Link 1Password" }));
    expect(commands).toEqual([{ kind: "link-store", store: "onepassword" }]);
    expect(
      await screen.findByText("The secret store is locked. Unlock it, then try again."),
    ).toBeVisible();
  });

  it("unlinks only after a confirmation that names what stops working", async () => {
    const user = userEvent.setup();
    const { client, commands } = fakeClient(viewOf(true), (command) =>
      command.kind === "unlink-store" ? viewOf(false) : viewOf(true),
    );
    render(<SecretStoresSettingsSection client={client} />);
    await user.click(await screen.findByRole("button", { name: "Unlink" }));
    expect(commands).toEqual([]);
    expect(screen.getByText(/stop getting their key until you link it again/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Unlink 1Password" }));
    await waitFor(() => expect(commands).toEqual([{ kind: "unlink-store", store: "onepassword" }]));
    expect(await screen.findByRole("button", { name: "Link 1Password" })).toBeVisible();
  });

  it("checks an item and reports found or locked without ever showing a value", async () => {
    const user = userEvent.setup();
    let outcome: "found" | "locked" = "found";
    const { client } = fakeClient(viewOf(true), (command) =>
      command.kind === "check-reference"
        ? decodeSecretStoresResult({
            kind: "secret-stores-checked",
            store: "onepassword",
            outcome,
          })
        : viewOf(true),
    );
    render(<SecretStoresSettingsSection client={client} />);
    const input = await screen.findByRole("textbox", { name: "Item reference" });
    await user.type(input, REFERENCE);
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Found. Octant can read this item.")).toBeVisible();
    outcome = "locked";
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(
      await screen.findByText("The store is locked. Unlock it, then check again."),
    ).toBeVisible();
  });
});

describe("ProviderLinkedKeyEditor", () => {
  function renderEditor(client: SecretStoresClient, onChanged = vi.fn()) {
    render(
      <SecretStoresClientContext.Provider value={client}>
        <ProviderLinkedKeyEditor
          displayName="Private gateway"
          instanceId={instanceId}
          onChanged={onChanged}
        />
      </SecretStoresClientContext.Provider>,
    );
    return onChanged;
  }
  const reference = (value: null | { store: "onepassword"; reference: string }) =>
    decodeSecretStoresResult({
      kind: "secret-stores-provider-reference",
      instanceId,
      reference: value,
    });

  it("shows nothing when no store is linked and no item is set", async () => {
    const { client } = fakeClient(viewOf(false), () => reference(null));
    renderEditor(client);
    await waitFor(() => expect(client.read).toHaveBeenCalled());
    expect(screen.queryByText("Key from a secret store")).not.toBeInTheDocument();
  });

  it("points the key at an item, then shows the address and offers to change or remove it", async () => {
    const user = userEvent.setup();
    let current: null | { store: "onepassword"; reference: string } = null;
    const { client, commands } = fakeClient(viewOf(true), (command) => {
      if (command.kind === "point-provider-key") {
        current = { store: command.store, reference: command.reference };
      }
      if (command.kind === "clear-provider-key-reference") current = null;
      return reference(current);
    });
    const onChanged = renderEditor(client);
    await user.type(
      await screen.findByRole("textbox", { name: "Item reference in 1Password" }),
      REFERENCE,
    );
    await user.click(screen.getByRole("button", { name: "Use this item" }));
    expect(await screen.findByText(REFERENCE)).toBeVisible();
    expect(commands.at(-1)).toEqual({
      kind: "point-provider-key",
      instanceId,
      store: "onepassword",
      reference: REFERENCE,
    });
    expect(onChanged).toHaveBeenLastCalledWith("stored");

    await user.click(screen.getByRole("button", { name: "Remove the item for Private gateway" }));
    await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith("missing"));
    expect(commands.at(-1)).toEqual({ kind: "clear-provider-key-reference", instanceId });
  });

  it("shows the host's reason when it refuses the item", async () => {
    const user = userEvent.setup();
    const { client } = fakeClient(viewOf(true), (command) =>
      command.kind === "point-provider-key"
        ? decodeSecretStoresResult({
            kind: "secret-stores-refused",
            reason: "item-missing",
            message: "No item with that reference was found in the secret store.",
          })
        : reference(null),
    );
    renderEditor(client);
    await user.type(
      await screen.findByRole("textbox", { name: "Item reference in 1Password" }),
      REFERENCE,
    );
    await user.click(screen.getByRole("button", { name: "Use this item" }));
    expect(
      await screen.findByText("No item with that reference was found in the secret store."),
    ).toBeVisible();
  });
});
