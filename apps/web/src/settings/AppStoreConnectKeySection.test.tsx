import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppStoreConnectKeyBridge } from "../shell/hostBridge";
import { AppStoreConnectKeySection } from "./AppStoreConnectKeySection";

function bridge(
  answer: (operation: string, body: unknown) => { readonly status: number; readonly body: unknown },
): AppStoreConnectKeyBridge {
  return {
    appStoreConnectKeyRequest: vi.fn(async (operation, body) => answer(operation, body)),
  };
}

describe("AppStoreConnectKeySection", () => {
  it("stays hidden when the host does not take an App Store Connect key", async () => {
    const host = bridge(() => ({
      status: 409,
      body: { category: "distribution-not-enabled", message: "Not available." },
    }));
    const { container } = render(<AppStoreConnectKeySection bridge={host} />);
    await waitFor(() => expect(host.appStoreConnectKeyRequest).toHaveBeenCalledWith("status", {}));
    expect(container).toBeEmptyDOMElement();
  });

  it("sends a key once, clears it from the form, and says it is saved", async () => {
    const sent: unknown[] = [];
    const host = bridge((operation, body) => {
      if (operation === "status") return { status: 200, body: { outcome: "missing" } };
      sent.push(body);
      return { status: 200, body: { outcome: "stored" } };
    });
    render(<AppStoreConnectKeySection bridge={host} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Issuer ID"), "issuer");
    await user.type(screen.getByLabelText("Key ID"), "ABCDEFGHIJ");
    await user.type(screen.getByLabelText("Private key"), "pem-text");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("Key saved.")).toBeInTheDocument();
    expect(sent).toEqual([
      { issuerId: "issuer", keyId: "ABCDEFGHIJ", privateKey: "pem-text", replace: false },
    ]);
    expect(screen.getByLabelText("Private key")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Replace key" })).toBeInTheDocument();
  });

  it("saves a 1Password reference in the key's place when the person keeps the key there", async () => {
    const sent: unknown[] = [];
    const host = bridge((operation, body) => {
      if (operation === "status") return { status: 200, body: { outcome: "missing" } };
      sent.push(body);
      return { status: 200, body: { outcome: "stored" } };
    });
    render(<AppStoreConnectKeySection bridge={host} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Issuer ID"), "issuer");
    await user.type(screen.getByLabelText("Key ID"), "ABCDEFGHIJ");
    await user.click(screen.getByRole("button", { name: "1Password" }));
    expect(screen.queryByLabelText("Private key")).toBeNull();
    await user.type(screen.getByLabelText("1Password reference"), "op://Dev/ASC/key");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByText("Key saved.")).toBeInTheDocument();
    expect(sent).toEqual([
      {
        issuerId: "issuer",
        keyId: "ABCDEFGHIJ",
        onePasswordReference: "op://Dev/ASC/key",
        replace: false,
      },
    ]);
    expect(screen.getByLabelText("1Password reference")).toHaveValue("");
  });

  it("shows the host's refusal and keeps nothing it was given", async () => {
    const host = bridge((operation) =>
      operation === "status"
        ? { status: 200, body: { outcome: "missing" } }
        : { status: 400, body: { category: "invalid-key", message: "That is not a key." } },
    );
    render(<AppStoreConnectKeySection bridge={host} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Issuer ID"), "issuer");
    await user.type(screen.getByLabelText("Key ID"), "short");
    await user.type(screen.getByLabelText("Private key"), "pem-text");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That is not a key.");
    expect(screen.getByLabelText("Private key")).toHaveValue("");
  });

  it("asks the host for the key's status once when Settings renders it again", async () => {
    const host = bridge(() => ({ status: 200, body: { outcome: "missing" } }));
    const request = host.appStoreConnectKeyRequest;
    const { rerender } = render(
      <AppStoreConnectKeySection bridge={{ appStoreConnectKeyRequest: request }} />,
    );
    await screen.findByLabelText("Issuer ID");
    rerender(<AppStoreConnectKeySection bridge={{ appStoreConnectKeyRequest: request }} />);
    rerender(<AppStoreConnectKeySection bridge={{ appStoreConnectKeyRequest: request }} />);
    await screen.findByLabelText("Issuer ID");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("removes a saved key", async () => {
    const host = bridge((operation) =>
      operation === "status"
        ? { status: 200, body: { outcome: "stored" } }
        : { status: 200, body: { outcome: "removed" } },
    );
    render(<AppStoreConnectKeySection bridge={host} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Remove key" }));
    expect(await screen.findByText("Key removed.")).toBeInTheDocument();
    expect(host.appStoreConnectKeyRequest).toHaveBeenCalledWith("remove", {});
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });
});
