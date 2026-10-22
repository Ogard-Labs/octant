import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServerSignInView } from "@octant/contracts/extension-rpc";
import { describe, expect, it, vi } from "vitest";
import { McpServerSignInControl } from "./McpServerSignInControl";

const extensionId = "44000000-0000-4000-8000-000000000002";
const componentId = "mcp-docs";

describe("Sign in to a hosted server", () => {
  it("starts a sign-in, links to the page, keeps asking until it is done, and offers Sign out", async () => {
    const user = userEvent.setup();
    const views: McpServerSignInView[] = [
      { kind: "signed-out" },
      {
        kind: "awaiting-consent",
        attemptId: "55000000-0000-4000-8000-000000000001",
        authorizationUrl: "https://auth.example/authorize?x=1",
        expiresAt: "2026-10-20T12:10:00.000Z" as never,
      },
      { kind: "signed-in", issuer: "auth.example" },
      { kind: "signed-out" },
    ];
    const mcpServerSignIn = vi.fn(async () => views.shift() ?? { kind: "signed-out" });
    render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: mcpServerSignIn as never }}
        componentId={componentId}
        disabled={false}
        extensionId={extensionId}
        pollIntervalMs={10}
      />,
    );
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("link", { name: "Open the sign-in page" })).toHaveAttribute(
      "href",
      "https://auth.example/authorize?x=1",
    );
    expect(await screen.findByText("Signed in through auth.example")).toBeInTheDocument();
    expect(mcpServerSignIn).toHaveBeenNthCalledWith(3, {
      kind: "poll",
      extensionId,
      componentId,
      attemptId: "55000000-0000-4000-8000-000000000001",
    });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
    expect(mcpServerSignIn).toHaveBeenLastCalledWith({
      kind: "sign-out",
      extensionId,
      componentId,
    });
  });

  it("shows nothing for a command server and the host's refusal for one that cannot register", async () => {
    const { container } = render(
      <McpServerSignInControl
        client={{ mcpServerSignIn: async () => ({ kind: "not-applicable" }) }}
        componentId={componentId}
        disabled={false}
        extensionId={extensionId}
      />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    render(
      <McpServerSignInControl
        client={{
          mcpServerSignIn: async () => ({
            kind: "refused",
            reason: "client-registration-unavailable",
            message: "This server's sign-in needs a client id Octant cannot register for itself.",
          }),
        }}
        componentId={componentId}
        disabled={false}
        extensionId={extensionId}
      />,
    );
    expect(
      await screen.findByText(
        "This server's sign-in needs a client id Octant cannot register for itself.",
      ),
    ).toBeInTheDocument();
  });
});
