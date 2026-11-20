// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { BiometricAuthenticator } from "../security/BiometricGate";
import { ThemeProvider } from "../../design-system/theme";
import { WorkRequestCards } from "./WorkRequestCards";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-local-authentication", () => ({}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassChip")),
  ...(await import("../../design-system/tone")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = "20000000-0000-4000-8000-000000000001";
const threadId = "00000000-0000-4000-8000-000000000201";
const requestId = "11111111-1111-4111-8111-111111111111";
const roots: Root[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => {
      root?.unmount();
    });
  }
  document.body.replaceChildren();
});

/**
 * A host with one pending Work request. Commands are recorded; `refuse`
 * answers the first one with the host's own failure.
 */
function hostWith(detail: unknown, options: { readonly refuse?: string } = {}) {
  const commands: Array<unknown> = [];
  let pending = true;
  const transport: MobileRemoteTransport = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    authenticatedFetch: async ({ method, body }) => {
      if (method === "GET") {
        return Response.json({
          requests: pending
            ? [
                {
                  requestId,
                  projectId,
                  threadId,
                  providerInstanceId: "10000000-0000-4000-8000-000000000001",
                  providerSessionId: "55555555-5555-4555-8555-555555555555",
                  providerRequestId: "provider-req",
                  detail,
                  status: "pending",
                  requestedAt: "2026-11-18T10:00:00.000Z",
                  version: 4,
                },
              ]
            : [],
        });
      }
      const command = JSON.parse(String(body)) as {
        kind: string;
        resolution?: unknown;
      };
      commands.push(command);
      if (options.refuse !== undefined) {
        return Response.json({ code: "stale", message: options.refuse }, { status: 409 });
      }
      pending = false;
      const settled = {
        requestId,
        projectId,
        threadId,
        providerInstanceId: "10000000-0000-4000-8000-000000000001",
        providerSessionId: "55555555-5555-4555-8555-555555555555",
        providerRequestId: "provider-req",
        detail,
        requestedAt: "2026-11-18T10:00:00.000Z",
        settledAt: "2026-11-18T10:01:00.000Z",
        version: 5,
      };
      return Response.json(
        command.kind === "cancel-work-request"
          ? { kind: "work-request-cancelled", request: { ...settled, status: "cancelled" } }
          : {
              kind: "work-request-resolved",
              request: { ...settled, status: "resolved", resolution: command.resolution },
            },
      );
    },
  };
  return { transport, commands };
}

function authenticator(outcome: "confirmed" | "denied" = "confirmed") {
  return {
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => outcome),
  } satisfies BiometricAuthenticator;
}

async function render(transport: MobileRemoteTransport, auth: BiometricAuthenticator) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        surfaceStyle: "flat",
        children: createElement(WorkRequestCards, {
          transport,
          authenticator: auth,
          threadId,
          projectId,
          refreshIntervalMs: 60_000,
        }),
      }),
    );
  });
  return container;
}

function byText(container: ParentNode, role: string, text: string): HTMLElement {
  const match = [...container.querySelectorAll(`[role="${role}"]`)].find(
    (node) => node.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  if (!(match instanceof HTMLElement)) throw new Error(`No ${role} reads "${text}".`);
  return match;
}

async function press(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

async function type(container: ParentNode, label: string, value: string) {
  const field = container.querySelector(`[aria-label="${label}"]`);
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    throw new Error(`No field is labelled "${label}".`);
  }
  const prototype = Object.getPrototypeOf(field) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const toolCall = { kind: "approval", action: "Run command", description: "npm test" };

describe("a Work tool approval on the phone", () => {
  it("shows the desktop's provider approval and approves only after the phone confirms", async () => {
    const { transport, commands } = hostWith(toolCall);
    const auth = authenticator();
    const container = await render(transport, auth);

    expect(container.textContent).toContain("Provider approval");
    expect(container.textContent).toContain("Run command: npm test");
    await press(byText(container, "button", "Approve"));

    expect(auth.authenticate).toHaveBeenCalledTimes(1);
    expect(commands).toEqual([
      {
        kind: "resolve-work-request",
        requestId,
        expectedVersion: 4,
        resolution: { kind: "approval", approved: true },
      },
    ]);
    expect(container.querySelector('[data-testid="mobile-work-tool-approval"]')).toBeNull();
  });

  it("denies without asking for confirmation, and sends nothing when confirmation is refused", async () => {
    const denied = hostWith(toolCall);
    const deniedAuth = authenticator();
    const first = await render(denied.transport, deniedAuth);
    await press(byText(first, "button", "Deny"));
    expect(deniedAuth.authenticate).not.toHaveBeenCalled();
    expect(denied.commands).toEqual([
      expect.objectContaining({ resolution: { kind: "approval", approved: false } }),
    ]);

    const cancelled = hostWith(toolCall);
    const second = await render(cancelled.transport, authenticator("denied"));
    await press(byText(second, "button", "Approve"));
    expect(cancelled.commands).toEqual([]);
    expect(second.textContent).toContain("Allow cancelled.");
  });

  it("shows the host's refusal in its own words and keeps the card", async () => {
    const { transport } = hostWith(toolCall, {
      refuse: "This thread's permissions changed since it asked; it asks again.",
    });
    const container = await render(transport, authenticator());
    await press(byText(container, "button", "Approve"));
    expect(container.querySelector('[data-testid="mobile-work-request-note"]')?.textContent).toBe(
      "This thread's permissions changed since it asked; it asks again.",
    );
    expect(container.querySelector('[data-testid="mobile-work-tool-approval"]')).not.toBeNull();
  });
});

describe("a Work level change on the phone", () => {
  it("switches to Plan without confirmation, since entering Plan is the safe direction", async () => {
    const { transport, commands } = hostWith({
      kind: "approval",
      action: "enter-plan",
      description: "Plan first.",
      levelChange: { to: "plan" },
    });
    const auth = authenticator();
    const container = await render(transport, auth);
    await press(byText(container, "button", "Switch to Plan"));
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(commands).toEqual([
      expect.objectContaining({ resolution: { kind: "approval", approved: true } }),
    ]);
  });
});

describe("a provider question on the phone", () => {
  it("sends the chosen option's words, with no confirmation", async () => {
    const { transport, commands } = hostWith({
      kind: "user-input",
      prompt: "Which venue?",
      options: ["Hall A", "Hall B"],
    });
    const auth = authenticator();
    const container = await render(transport, auth);
    expect(byText(container, "button", "Submit").getAttribute("aria-disabled")).toBe("true");
    await press(byText(container, "radio", "Hall B"));
    await press(byText(container, "button", "Submit"));
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(commands).toEqual([
      {
        kind: "resolve-work-request",
        requestId,
        expectedVersion: 4,
        resolution: { kind: "user-input", answer: "Hall B" },
      },
    ]);
  });

  it("sends the person's own answer when no option fits", async () => {
    const { transport, commands } = hostWith({
      kind: "user-input",
      prompt: "Which venue?",
      options: ["Hall A"],
    });
    const container = await render(transport, authenticator());
    await press(byText(container, "radio", "Type your own answer"));
    await type(container, "Your answer", "The rooftop");
    await press(byText(container, "button", "Submit"));
    expect(commands).toEqual([
      expect.objectContaining({ resolution: { kind: "user-input", answer: "The rooftop" } }),
    ]);
  });
});

describe("a provider questionnaire on the phone", () => {
  const detail = {
    kind: "user-input",
    prompt: "A few choices",
    options: [],
    questionnaire: {
      questions: [
        {
          id: "venue",
          prompt: "Which venue?",
          selection: "single",
          options: [
            { id: "a", label: "Hall A" },
            { id: "b", label: "Hall B", recommended: true },
          ],
        },
      ],
    },
  };

  it("sends the whole response once every question is answered", async () => {
    const { transport, commands } = hostWith(detail);
    const container = await render(transport, authenticator());
    expect(byText(container, "button", "Send answers").getAttribute("aria-disabled")).toBe("true");
    await press(byText(container, "radio", "Hall B (Recommended)"));
    await type(container, "Anything to add?", "Thanks");
    await press(byText(container, "button", "Send answers"));
    expect(commands).toEqual([
      {
        kind: "resolve-work-request",
        requestId,
        expectedVersion: 4,
        resolution: {
          kind: "user-input",
          answer: {
            version: 1,
            answers: [{ questionId: "venue", selectedOptionIds: ["b"] }],
            comment: "Thanks",
          },
        },
      },
    ]);
  });

  it("dismisses the questionnaire by cancelling the request", async () => {
    const { transport, commands } = hostWith(detail);
    const container = await render(transport, authenticator());
    await press(byText(container, "button", "Dismiss"));
    expect(commands).toEqual([{ kind: "cancel-work-request", requestId, expectedVersion: 4 }]);
  });
});
