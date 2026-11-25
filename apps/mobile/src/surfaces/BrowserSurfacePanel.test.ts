// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { BrowserSurfacePanel, pairedControlEndedMessage } from "./BrowserSurfacePanel";

const { appStateListeners, appState } = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    appStateListeners: listeners,
    appState: {
      currentState: "active",
      addEventListener: (_type: string, listener: (state: string) => void) => {
        listeners.add(listener);
        return {
          remove: () => {
            listeners.delete(listener);
          },
        };
      },
    },
  };
});

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native-web");
  return {
    ...actual,
    AppState: appState,
  };
});
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "00000000-0000-4000-8000-000000000020";
const contextId = "00000000-0000-4000-8000-000000000021";
const actionId = "00000000-0000-4000-8000-000000000022";
const correlationId = "00000000-0000-4000-8000-000000000023";
const leaseId = "00000000-0000-4000-8000-000000000024";
const roots: Root[] = [];

afterEach(() => {
  appState.currentState = "active";
  appStateListeners.clear();
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => {
      root?.unmount();
    });
  }
  document.body.replaceChildren();
});

function createTransport(options?: { readonly waitingForPerson?: "sign-in" | "take-over" }) {
  const sentInputs: Array<unknown> = [];
  let handedBack = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const authority = {
    hostId: "30000000-0000-4000-8000-000000000001",
    mode: "code",
    projectId: "40000000-0000-4000-8000-000000000001",
    rootId: "50000000-0000-4000-8000-000000000001",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  };
  const baseSnapshot = {
    status: "running",
    threadId,
    context: {
      contextId,
      threadId,
      actionId,
      correlationId,
      authority,
      state: "active",
      presentation: "native-live",
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 600_000,
      },
      createdAt: "2026-11-20T10:00:00.000Z",
    },
    observation: {
      contextId,
      actionId,
      correlationId,
      authority,
      revision: 1,
      url: "https://example.com/login",
      title: "Example Login",
      observedAt: "2026-11-20T10:00:00.000Z",
      stale: false,
      screenshotDataUrl: `data:image/png;base64,${"A".repeat(24)}=`,
    },
    evidence: [],
    ...(options?.waitingForPerson === undefined
      ? {}
      : { waitingForPerson: options.waitingForPerson }),
  };

  const transport: MobileRemoteTransport = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    authenticatedFetch: async ({ path, body }) => {
      if (path === "/api/browser/scope") {
        return Response.json({ threadId, authority });
      }
      if (path === "/api/browser/contexts/current") {
        return Response.json(baseSnapshot);
      }
      if (path === "/api/browser/contexts/take-over") {
        return Response.json({
          ...baseSnapshot,
          waitingForPerson: options?.waitingForPerson ?? "take-over",
          remoteHolder: {
            deviceId: "device-phone-1",
            deviceName: "My iPhone",
            leaseId,
            expiresAt: "2026-11-20T10:01:00.000Z",
          },
          pairedLease: {
            leaseId,
            expiresAt: "2026-11-20T10:01:00.000Z",
            target: {
              threadId,
              contextId,
              tabId: "tab-1",
              documentVersion: "a".repeat(64),
              profileKind: "private",
              originPolicyVersion: "v1",
            },
          },
        });
      }
      if (path === "/api/browser/contexts/hand-back") {
        handedBack = true;
        return Response.json({
          ...baseSnapshot,
        });
      }
      if (path === "/api/browser/remote-control/stream") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (path === "/api/browser/remote-control/input") {
        sentInputs.push(JSON.parse(String(body)));
        return Response.json({
          status: "input",
          lastAcceptedSequence: sentInputs.length,
          effect: "completed",
        });
      }
      return Response.json({}, { status: 404 });
    },
  };

  const emitStream = (event: unknown) => {
    streamController?.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
  };

  return {
    transport,
    sentInputs,
    emitStream,
    wasHandedBack: () => handedBack,
  };
}

async function mountPanel(props: {
  readonly transport: MobileRemoteTransport;
  readonly actsAsHostPerson: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(
        ThemeProvider,
        null,
        createElement(BrowserSurfacePanel, {
          actsAsHostPerson: props.actsAsHostPerson,
          mode: "code",
          reach: "interactive",
          threadId,
          transport: props.transport,
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("what the panel says once the phone no longer holds the page", () => {
  it("does not say whether a sign-in was answered, nor tell the person to finish it elsewhere", () => {
    expect(pairedControlEndedMessage("agent-sign-in")).toBe(
      "The sign-in request ended, so this phone no longer holds the page.",
    );
    expect(pairedControlEndedMessage("disconnected")).toContain("take over again");
  });
});

describe("BrowserSurfacePanel paired hold", () => {
  it("hides take-over controls on a restricted device", async () => {
    const { transport } = createTransport({ waitingForPerson: "sign-in" });
    const container = await mountPanel({ transport, actsAsHostPerson: false });
    expect(container.querySelector('[data-testid="mobile-browser-surface-take-over"]')).toBeNull();
  });

  it("lets a person-paired phone take over a sign-in page, send touch/key input, blank on background, and hand back", async () => {
    const { transport, sentInputs, emitStream, wasHandedBack } = createTransport({
      waitingForPerson: "sign-in",
    });
    const container = await mountPanel({ transport, actsAsHostPerson: true });

    const takeOverButton = container.querySelector(
      '[data-testid="mobile-browser-surface-take-over"]',
    );
    expect(takeOverButton?.textContent).toContain("Sign in here");

    await act(async () => {
      takeOverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      emitStream({
        kind: "frame",
        frameId: 3,
        documentVersion: "a".repeat(64),
        viewport: { width: 1200, height: 800 },
        devicePixelRatio: 2,
        jpegBase64: "QkJC",
      });
      await Promise.resolve();
    });

    const enterButton = container.querySelector('[data-testid="mobile-browser-surface-key-enter"]');
    expect(enterButton).not.toBeNull();
    await act(async () => {
      enterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sentInputs).toContainEqual({
      kind: "input",
      leaseId,
      sequence: 1,
      events: [
        { kind: "key", phase: "down", key: "Enter", code: "Enter" },
        { kind: "key", phase: "up", key: "Enter", code: "Enter" },
      ],
    });

    // Backgrounding the app immediately hides the live frame so the OS app switcher
    // does not capture a signed-in page.
    await act(async () => {
      appState.currentState = "background";
      for (const listener of appStateListeners) listener("background");
    });
    expect(container.textContent).toContain("Live frame hidden while app is inactive.");

    const handBackButton = container.querySelector(
      '[data-testid="mobile-browser-surface-hand-back"]',
    );
    await act(async () => {
      handBackButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(wasHandedBack()).toBe(true);
  });
});
