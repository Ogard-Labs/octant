import type { SecretStoresClient } from "@octant/client-runtime/secret-stores-client";
import { decodeSecretStoresResult, type SecretStoresResult } from "@octant/contracts/secret-stores";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoogleCliAccountSettings } from "./GoogleCliAccountSettings";
const selection = {
  store: "onepassword" as const,
  reference: "op://Private/Google/credential",
  serviceAccountEmail: "commands@example.iam.gserviceaccount.com",
  scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
};
const linkedStore = {
  kind: "onepassword" as const,
  label: "1Password",
  linked: true,
  tool: "ready" as const,
};
const snapshot = (reference: typeof selection | null) =>
  decodeSecretStoresResult({ kind: "secret-stores-google-cli-account", reference });
async function confirm() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Service account email"), selection.serviceAccountEmail);
  await user.type(screen.getByLabelText("Service-account JSON item"), selection.reference);
  await user.click(screen.getByRole("button", { name: "Review Google Cloud account" }));
  await user.click(await screen.findByRole("button", { name: "Use this service account" }));
}
describe("Google account consent is bound to its current host", () => {
  it("does not let an older initial account read erase a subsequently confirmed selection", async () => {
    const old = Promise.withResolvers<SecretStoresResult>();
    const client: SecretStoresClient = {
      read: vi.fn(),
      execute: vi.fn(async (command) =>
        command.kind === "read-google-cli-account" ? old.promise : snapshot(selection),
      ),
    };
    render(<GoogleCliAccountSettings client={client} linkedStore={linkedStore} />);
    await confirm();
    await screen.findByRole("button", { name: "Remove Google Cloud account" });
    await act(async () => old.resolve(snapshot(null)));
    expect(screen.getByRole("button", { name: "Remove Google Cloud account" })).toBeVisible();
  });
  it("hides a previous host's delayed account metadata immediately after the client changes", async () => {
    const old = Promise.withResolvers<SecretStoresResult>();
    const client: SecretStoresClient = { read: vi.fn(), execute: vi.fn(async () => old.promise) };
    const current: SecretStoresClient = {
      read: vi.fn(),
      execute: vi.fn(async () => snapshot(null)),
    };
    const mounted = render(<GoogleCliAccountSettings client={client} linkedStore={linkedStore} />);
    mounted.rerender(<GoogleCliAccountSettings client={current} linkedStore={linkedStore} />);
    await act(async () => old.resolve(snapshot(selection)));
    expect(screen.queryByText(new RegExp(selection.serviceAccountEmail))).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Google Cloud account" })).toBeNull();
  });
  it("keeps the draft and reports uncertainty when Save returns another result kind", async () => {
    const client: SecretStoresClient = {
      read: vi.fn(),
      execute: vi.fn(async (command) =>
        command.kind === "read-google-cli-account"
          ? snapshot(null)
          : decodeSecretStoresResult({
              kind: "secret-stores-view",
              brokerAvailable: true,
              stores: [],
            }),
      ),
    };
    render(<GoogleCliAccountSettings client={client} linkedStore={linkedStore} />);
    await confirm();
    expect(await screen.findByText(/The account change was not confirmed/)).toBeVisible();
    expect(screen.getByLabelText("Service account email")).toHaveValue(
      selection.serviceAccountEmail,
    );
    expect(screen.queryByRole("button", { name: "Remove Google Cloud account" })).toBeNull();
  });
});
