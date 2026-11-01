import type {
  BrowserExtensionSummary,
  BrowserExtensionsResult,
} from "@octant/contracts/browser-extensions";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import { BrowserExtensionsButton } from "./BrowserExtensionsButton";

const projectId = "40000000-0000-4000-8000-000000000001" as never;

function extension(overrides: Partial<BrowserExtensionSummary> = {}): BrowserExtensionSummary {
  return {
    id: "a".repeat(32) as never,
    name: "Reading tool",
    version: "1.0.0",
    contentHash: "b".repeat(64),
    access: { permissions: [], hostPatterns: ["https://example.com/*"] },
    hasPopup: true,
    hasOptionsPage: true,
    enabledIn: [{ kind: "personal" }],
    needsConfirmation: [],
    ...overrides,
  };
}

function client(extensions: ReadonlyArray<BrowserExtensionSummary>) {
  return {
    manageExtensions: vi.fn(
      async () => ({ kind: "browser-extensions", extensions }) as BrowserExtensionsResult,
    ),
  };
}

describe("BrowserExtensionsButton", () => {
  it("is not there for a Private page", async () => {
    const api = client([extension()]);
    render(
      <BrowserExtensionsButton
        agentDriving={false}
        client={api}
        profile={undefined}
        refreshKey="a"
      />,
    );

    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /Extensions/ })).not.toBeInTheDocument();
    expect(api.manageExtensions).not.toHaveBeenCalled();
  });

  it("is not there when nothing is enabled in this page's profile", async () => {
    const api = client([extension({ enabledIn: [{ kind: "project", projectId }] })]);
    render(
      <BrowserExtensionsButton
        agentDriving={false}
        client={api}
        profile={{ kind: "personal" }}
        refreshKey="a"
      />,
    );

    await waitFor(() => expect(api.manageExtensions).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Extensions/ })).not.toBeInTheDocument();
  });

  it("carries a count and says the agent can see them while the agent drives the page", async () => {
    render(
      <BrowserExtensionsButton
        agentDriving
        client={client([extension()])}
        profile={{ kind: "personal" }}
        refreshKey="a"
      />,
    );

    expect(
      await screen.findByRole("button", {
        name: "Extensions: 1 on in this profile and visible to the agent",
      }),
    ).toBeInTheDocument();
  });

  it("opens the chosen extension's popup in its profile, anchored under the button", async () => {
    const user = userEvent.setup();
    const openBrowserExtensionPopup = vi.fn(async () => ({ opened: true }));
    render(
      <BrowserExtensionsButton
        agentDriving={false}
        client={client([extension()])}
        hostBridge={{ openBrowserExtensionPopup } as unknown as OctantHostBridge}
        profile={{ kind: "personal" }}
        refreshKey="a"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Extensions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Reading tool" }));

    await waitFor(() =>
      expect(openBrowserExtensionPopup).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: { kind: "personal" },
          extensionId: "a".repeat(32),
          kind: "popup",
        }),
      ),
    );
  });

  it("lets the person choose an extension that has no popup page, so its toolbar click reaches it", async () => {
    const user = userEvent.setup();
    const openBrowserExtensionPopup = vi.fn(async () => ({ opened: true }));
    render(
      <BrowserExtensionsButton
        agentDriving={false}
        client={client([extension({ name: "Clicker", hasPopup: false })])}
        hostBridge={{ openBrowserExtensionPopup } as unknown as OctantHostBridge}
        profile={{ kind: "personal" }}
        refreshKey="a"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Extensions" }));
    const item = await screen.findByRole("menuitem", { name: "Clicker" });
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    await user.click(item);

    await waitFor(() =>
      expect(openBrowserExtensionPopup).toHaveBeenCalledWith(
        expect.objectContaining({ extensionId: "a".repeat(32), kind: "popup" }),
      ),
    );
  });
});
