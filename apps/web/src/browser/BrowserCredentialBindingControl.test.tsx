// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeBrowserCredentialGrant,
  decodeBrowserCredentialResult,
  decodeBrowserCredentialTarget,
  type BrowserCredentialCommand,
} from "@octant/contracts/browser-credential-use";
import { BrowserCredentialBindingControl } from "./BrowserCredentialBindingControl";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = {
  store: "onepassword",
  accountId: "a".repeat(26),
  vaultId: "v".repeat(26),
  itemId: "i".repeat(26),
};
const target = decodeBrowserCredentialTarget({
  contextId: id(1),
  threadId: id(2),
  mode: "code",
  projectId: id(3),
  profile: { kind: "project", projectId: id(3) },
  topOrigin: "https://login.example:8443",
  frame: { kind: "top", origin: "https://login.example:8443" },
});
const metadata = {
  item,
  title: "Fixture login",
  version: 1,
  websiteOrigins: [target.topOrigin],
  storeRevision: "fixture-link",
};
const review = decodeBrowserCredentialResult({
  kind: "browser-credential-review",
  reviewId: id(4),
  metadata,
  target,
  expiresAt: "2026-11-03T10:03:00.000Z",
});
const grant = decodeBrowserCredentialGrant({
  kind: "browser-credential-grant",
  grantId: id(5),
  hostSessionId: id(6),
  metadata,
  target,
  scope: { kind: "project", projectId: target.projectId },
  createdAt: "2026-11-03T10:00:00.000Z",
  expiresAt: "2026-11-03T18:00:00.000Z",
});
afterEach(cleanup);

async function enterItem() {
  fireEvent.click(screen.getByRole("button", { name: "Login permission" }));
  await waitFor(() => expect(screen.queryByText("Checking current login permissions…")).toBeNull());
  fireEvent.change(screen.getByLabelText("1Password account ID"), {
    target: { value: item.accountId },
  });
  fireEvent.change(screen.getByLabelText("Vault ID"), { target: { value: item.vaultId } });
  fireEvent.change(screen.getByLabelText("Item ID"), { target: { value: item.itemId } });
}

describe("Browser selected-item consent", () => {
  it("does not keep an earlier permission visible when reopening finds the store unlinked", async () => {
    let reads = 0;
    const manageCredentialUse = vi.fn(async () =>
      decodeBrowserCredentialResult(
        ++reads === 1
          ? { kind: "browser-credential-grants", grants: [grant] }
          : {
              kind: "browser-credential-refused",
              reason: "not-linked",
              message: "Link the secret store again.",
            },
      ),
    );
    render(
      <BrowserCredentialBindingControl
        client={{ manageCredentialUse }}
        context={target}
        profile={target.profile}
        held
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Login permission" }));
    expect(await screen.findByRole("button", { name: "Revoke permission" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Login permission" }));
    expect(await screen.findByText("Link the secret store again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke permission" })).toBeNull();
  });

  it("reviews the account, item, exact port and frame before sending explicit Project consent", async () => {
    const manageCredentialUse = vi.fn(async (command: BrowserCredentialCommand) =>
      command.kind === "review-browser-credential"
        ? review
        : decodeBrowserCredentialResult({
            kind: "browser-credential-grants",
            grants: command.kind === "allow-browser-credential" ? [grant] : [],
          }),
    );
    render(
      <BrowserCredentialBindingControl
        client={{ manageCredentialUse }}
        context={target}
        profile={target.profile}
        held
      />,
    );
    await enterItem();
    fireEvent.click(screen.getByRole("button", { name: "Review item" }));
    expect(await screen.findByText("Selected item: Fixture login")).toBeTruthy();
    expect(screen.getByText(`Exact site: ${target.topOrigin}`)).toBeTruthy();
    expect(screen.getByText("Top frame only. Iframes are not included.")).toBeTruthy();
    expect(
      manageCredentialUse.mock.calls.some(
        ([command]) => command.kind === "allow-browser-credential",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Allow selected item" }));
    expect(
      await screen.findByText(
        "Login permission recorded. It must be checked again before use. Automatic filling is not available yet.",
      ),
    ).toBeTruthy();
    expect(manageCredentialUse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "allow-browser-credential",
        reviewId: id(4),
        scope: "project",
      }),
      expect.any(AbortSignal),
    );
  });

  it("keeps selected IDs after a locked-store refusal and sends no permission", async () => {
    const manageCredentialUse = vi.fn(async (command: BrowserCredentialCommand) =>
      decodeBrowserCredentialResult(
        command.kind === "review-browser-credential"
          ? {
              kind: "browser-credential-refused",
              reason: "locked",
              message: "Unlock the selected account, then retry.",
            }
          : { kind: "browser-credential-grants", grants: [] },
      ),
    );
    render(
      <BrowserCredentialBindingControl
        client={{ manageCredentialUse }}
        context={target}
        profile={target.profile}
        held
      />,
    );
    await enterItem();
    fireEvent.click(screen.getByRole("button", { name: "Review item" }));
    expect(await screen.findByText("Unlock the selected account, then retry.")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("1Password account ID").value).toBe(
      item.accountId,
    );
    expect(
      manageCredentialUse.mock.calls.some(
        ([command]) => command.kind === "allow-browser-credential",
      ),
    ).toBe(false);
  });

  it("lets the person revoke existing permission but holds new consent until the page is theirs", async () => {
    const manageCredentialUse = vi.fn(async (command: BrowserCredentialCommand) =>
      decodeBrowserCredentialResult({
        kind: "browser-credential-grants",
        grants: command.kind === "revoke-browser-credential" ? [] : [grant],
      }),
    );
    render(
      <BrowserCredentialBindingControl
        client={{ manageCredentialUse }}
        context={target}
        profile={target.profile}
        held={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Login permission" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke permission" }));
    expect(await screen.findByText("Login permission revoked.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review item" }).disabled).toBe(
      true,
    );
    expect(manageCredentialUse).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "revoke-browser-credential", grantId: id(5) }),
      expect.any(AbortSignal),
    );
  });
});
