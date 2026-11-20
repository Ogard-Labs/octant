// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { ConnectorSignInPanel } from "./ConnectorSignInPanel";

vi.mock("react-native", () => vi.importActual("react-native-web"));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const EXTENSION = "44000000-0000-4000-8000-000000000002";
const PACKAGE = "44000000-0000-4000-8000-000000000003";
const ATTEMPT = "55000000-0000-4000-8000-000000000010";

const HOSTED_CONNECTOR = {
  extensionId: EXTENSION,
  packageId: PACKAGE,
  componentId: "mcp-docs",
  packageName: "Docs",
  serverName: "Docs MCP",
  transport: "streamable-http",
  state: "needs-sign-in",
  reason: "Not signed in.",
} as const;

async function mount(props: {
  readonly transport: MobileRemoteTransport;
  readonly actsAsHostPerson: boolean;
  readonly openExternalUrl?: (url: string) => Promise<unknown>;
  readonly pollIntervalMs?: number;
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        children: createElement(ConnectorSignInPanel, props),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

describe("connector sign-in from the phone", () => {
  it("hides connector sign-ins for a device that does not act as the host's person", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ servers: [HOSTED_CONNECTOR] }));
    const container = await mount({
      transport: {
        hostId: "host-1",
        authenticatedFetch: fetchSpy as MobileRemoteTransport["authenticatedFetch"],
      },
      actsAsHostPerson: false,
    });
    expect(container.querySelector('[data-testid="mobile-connector-sign-in-panel"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the issuer host and user code for device authorization and opens the verification page externally", async () => {
    const opened: string[] = [];
    const transport: MobileRemoteTransport = {
      hostId: "host-1",
      authenticatedFetch: (async (input) => {
        if (input.path === "/api/extensions/connections") {
          return Response.json({ servers: [HOSTED_CONNECTOR] });
        }
        const body = typeof input.body === "string" ? JSON.parse(input.body) : {};
        if (body.kind === "status") return Response.json({ kind: "signed-out" });
        if (body.kind === "begin") {
          return Response.json({
            kind: "awaiting-device-code",
            attemptId: ATTEMPT,
            issuerHost: "auth.example",
            verificationUri: "https://auth.example/device",
            verificationUriComplete: "https://auth.example/device?user_code=ABCD-5678",
            userCode: "ABCD-5678",
            expiresAt: "2026-11-20T12:10:00.000Z",
          });
        }
        return Response.json({ kind: "signed-in", issuer: "auth.example" });
      }) as MobileRemoteTransport["authenticatedFetch"],
    };
    const container = await mount({
      transport,
      actsAsHostPerson: true,
      openExternalUrl: async (url) => {
        opened.push(url);
      },
      pollIntervalMs: 60_000,
    });
    const signInButton = container.querySelector<HTMLElement>(
      '[data-testid="mobile-connector-sign-in-mcp-docs"]',
    );
    expect(signInButton).not.toBeNull();
    await act(async () => {
      signInButton?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("auth.example");
    expect(container.textContent).toContain("ABCD-5678");
    const verifyButton = container.querySelector<HTMLElement>(
      '[data-testid="mobile-connector-open-verify"]',
    );
    await act(async () => {
      verifyButton?.click();
      await Promise.resolve();
    });
    expect(opened).toEqual(["https://auth.example/device?user_code=ABCD-5678"]);
  });

  it("relays a pasted loopback callback address once over the signed session and shows retry feedback", async () => {
    const relayCalls: unknown[] = [];
    const relayAnswers = [
      {
        kind: "retry",
        remainingAttempts: 2,
        message: "That callback address did not match this sign-in attempt.",
      },
      { kind: "signed-in", issuer: "auth.example" },
    ];
    const transport: MobileRemoteTransport = {
      hostId: "host-1",
      authenticatedFetch: (async (input) => {
        if (input.path === "/api/extensions/connections") {
          return Response.json({ servers: [HOSTED_CONNECTOR] });
        }
        const body = typeof input.body === "string" ? JSON.parse(input.body) : {};
        if (input.path === "/api/extensions/mcp-sign-in/relay") {
          relayCalls.push(body);
          return Response.json(
            relayAnswers.shift() ?? { kind: "signed-in", issuer: "auth.example" },
          );
        }
        if (body.kind === "status") return Response.json({ kind: "signed-out" });
        return Response.json({
          kind: "awaiting-consent",
          attemptId: ATTEMPT,
          flow: "relay",
          relayable: true,
          authorizationUrl: "https://auth.example/authorize?state=abc",
          expiresAt: "2026-11-20T12:10:00.000Z",
        });
      }) as MobileRemoteTransport["authenticatedFetch"],
    };

    const container = await mount({
      transport,
      actsAsHostPerson: true,
      openExternalUrl: async () => undefined,
      pollIntervalMs: 60_000,
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="mobile-connector-sign-in-mcp-docs"]')
        ?.click();
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="mobile-connector-relay-input"]',
    );
    expect(input).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

    await act(async () => {
      setValue?.call(input, "http://127.0.0.1:43125/oauth/callback?code=bad&state=wrong");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="mobile-connector-relay-submit"]')
        ?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "That callback address did not match this sign-in attempt.",
    );

    await act(async () => {
      setValue?.call(input, "http://127.0.0.1:43125/oauth/callback?code=good&state=abc");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-testid="mobile-connector-relay-submit"]')
        ?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Signed in through auth.example");
    expect(relayCalls).toEqual([
      {
        attemptId: ATTEMPT,
        callbackUrl: "http://127.0.0.1:43125/oauth/callback?code=bad&state=wrong",
      },
      {
        attemptId: ATTEMPT,
        callbackUrl: "http://127.0.0.1:43125/oauth/callback?code=good&state=abc",
      },
    ]);
  });

  it("offers Check sign-in and Cancel sign-in recovery when status becomes unavailable", async () => {
    const unavailable = {
      kind: "status-unavailable",
      message:
        "Sign-in status is unavailable. Restore the credential broker, then check sign-in or cancel this attempt.",
    };
    const makeTransport = (onCheck: "signed-in" | "cancel"): MobileRemoteTransport => {
      let statusCalls = 0;
      return {
        hostId: "host-1",
        authenticatedFetch: (async (input) => {
          if (input.path === "/api/extensions/connections") {
            return Response.json({ servers: [HOSTED_CONNECTOR] });
          }
          const body = typeof input.body === "string" ? JSON.parse(input.body) : {};
          if (body.kind === "status") {
            statusCalls += 1;
            return Response.json(
              statusCalls === 1
                ? unavailable
                : onCheck === "signed-in"
                  ? { kind: "signed-in", issuer: "auth.example" }
                  : unavailable,
            );
          }
          if (body.kind === "sign-out") return Response.json({ kind: "signed-out" });
          return Response.json(unavailable);
        }) as MobileRemoteTransport["authenticatedFetch"],
      };
    };

    // Check sign-in recovers to signed-in.
    const recoverContainer = await mount({
      transport: makeTransport("signed-in"),
      actsAsHostPerson: true,
      pollIntervalMs: 60_000,
    });
    expect(recoverContainer.textContent).toContain(unavailable.message);
    expect(recoverContainer.textContent).not.toContain("Not signed in");
    const checkButton = recoverContainer.querySelector<HTMLElement>(
      '[data-testid="mobile-connector-check-status"]',
    );
    expect(checkButton).not.toBeNull();
    expect(
      recoverContainer.querySelector('[data-testid="mobile-connector-cancel"]'),
    ).not.toBeNull();
    await act(async () => {
      checkButton?.click();
      await Promise.resolve();
    });
    expect(recoverContainer.textContent).toContain("Signed in through auth.example");

    // Cancel sign-in cancels cleanly back to signed-out.
    const cancelContainer = await mount({
      transport: makeTransport("cancel"),
      actsAsHostPerson: true,
      pollIntervalMs: 60_000,
    });
    const cancelButton = cancelContainer.querySelector<HTMLElement>(
      '[data-testid="mobile-connector-cancel"]',
    );
    expect(cancelButton).not.toBeNull();
    await act(async () => {
      cancelButton?.click();
      await Promise.resolve();
    });
    expect(cancelContainer.textContent).toContain("Not signed in");
  });

  it("reschedules automatic polling after a transient transport error and discovers completion", async () => {
    vi.useFakeTimers();
    try {
      let pollAttempts = 0;
      const transport: MobileRemoteTransport = {
        hostId: "host-1",
        authenticatedFetch: (async (input) => {
          if (input.path === "/api/extensions/connections") {
            return Response.json({ servers: [HOSTED_CONNECTOR] });
          }
          const body = typeof input.body === "string" ? JSON.parse(input.body) : {};
          if (body.kind === "status") {
            return Response.json({
              kind: "awaiting-device-code",
              attemptId: ATTEMPT,
              issuerHost: "auth.example",
              verificationUri: "https://auth.example/device",
              userCode: "ABCD-5678",
              expiresAt: "2026-11-20T12:10:00.000Z",
            });
          }
          if (body.kind === "poll") {
            pollAttempts += 1;
            if (pollAttempts === 1) throw new Error("temporary network drop");
            return Response.json({ kind: "signed-in", issuer: "auth.example" });
          }
          return Response.json({ kind: "signed-out" });
        }) as MobileRemoteTransport["authenticatedFetch"],
      };

      const container = await mount({
        transport,
        actsAsHostPerson: true,
        pollIntervalMs: 1_000,
      });
      expect(container.textContent).toContain("ABCD-5678");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(pollAttempts).toBe(1);
      expect(container.textContent).toContain("ABCD-5678");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(pollAttempts).toBe(2);
      expect(container.textContent).toContain("Signed in through auth.example");
    } finally {
      vi.useRealTimers();
    }
  });
});
