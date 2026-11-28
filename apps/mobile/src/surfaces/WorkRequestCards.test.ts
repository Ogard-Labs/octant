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

async function render(
  transport: MobileRemoteTransport,
  auth: BiometricAuthenticator,
  watchingOnly = false,
) {
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
          watchingOnly,
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

function byLabel(container: ParentNode, role: string, label: string): HTMLElement {
  const match = container.querySelector(`[role="${role}"][aria-label="${label}"]`);
  if (!(match instanceof HTMLElement)) throw new Error(`No ${role} is labelled "${label}".`);
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
  it("shows a pending question and its choices without accepting input when watching", async () => {
    const { transport, commands } = hostWith({
      kind: "user-input",
      prompt: "Which venue?",
      options: ["Hall A", "Hall B"],
    });
    const container = await render(transport, authenticator(), true);
    expect(container.textContent).toContain("Which venue?");
    expect(byLabel(container, "radio", "Hall B").getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector('[data-testid="mobile-questionnaire-submit"]')).toBeNull();
    expect(container.querySelector("input, textarea")).toBeNull();
    expect(commands).toEqual([]);
  });

  it("sends the chosen option's words, with no confirmation", async () => {
    const { transport, commands } = hostWith({
      kind: "user-input",
      prompt: "Which venue?",
      options: ["Hall A", "Hall B"],
    });
    const auth = authenticator();
    const container = await render(transport, auth);
    expect(byLabel(container, "button", "Send answer").getAttribute("aria-disabled")).toBe("true");
    await press(byLabel(container, "radio", "Hall B"));
    await press(byLabel(container, "button", "Send answer"));
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

  it("sends the person's own answer from the field that is always under the question", async () => {
    const { transport, commands } = hostWith({
      kind: "user-input",
      prompt: "Which venue?",
      options: ["Hall A"],
    });
    const container = await render(transport, authenticator());
    await type(container, "Your own answer", "The rooftop");
    await press(byLabel(container, "button", "Send answer"));
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

  const several = {
    kind: "user-input",
    prompt: "Venue · Extras",
    options: [],
    questionnaire: {
      allowComment: false,
      questions: [
        {
          id: "q0",
          header: "Venue",
          prompt: "Which venue?",
          selection: "single",
          options: [
            { id: "o0", label: "Hall A", description: "Seats forty" },
            { id: "o1", label: "Hall B", recommended: true },
          ],
        },
        {
          id: "q1",
          header: "Extras",
          prompt: "Which extras?",
          selection: "multiple",
          minSelections: 0,
          options: [
            { id: "o0", label: "Coffee" },
            { id: "o1", label: "Lunch" },
          ],
        },
      ],
    },
  };

  it("sends the whole response once every question is answered", async () => {
    const { transport, commands } = hostWith(detail);
    const container = await render(transport, authenticator());
    expect(byLabel(container, "button", "Send answer").getAttribute("aria-disabled")).toBe("true");
    await press(byLabel(container, "radio", "Hall B, recommended"));
    await type(container, "Anything to add?", "Thanks");
    await press(byLabel(container, "button", "Send answer"));
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

  it("shows every question under its header on one card and answers them all with one Send", async () => {
    const { transport, commands } = hostWith(several);
    const container = await render(transport, authenticator());
    expect(container.querySelectorAll('[data-testid="mobile-work-questionnaire"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="mobile-questionnaire-submit"]')).toHaveLength(
      1,
    );
    expect(container.textContent).toContain("Waiting for 2 answers");
    expect(container.textContent).toContain("Venue");
    expect(container.textContent).toContain("Extras");
    expect(container.textContent).toContain("Seats forty");
    expect(container.textContent).toContain("Recommended");
    // No comment field where the provider cannot take one.
    expect(container.querySelector('[aria-label="Anything to add?"]')).toBeNull();
    await press(byLabel(container, "checkbox", "Lunch"));
    await type(container, "Your own answer for Venue", "The rooftop");
    await press(byLabel(container, "button", "Send answers"));
    expect(commands).toEqual([
      expect.objectContaining({
        resolution: {
          kind: "user-input",
          answer: {
            version: 1,
            answers: [
              { questionId: "q0", selectedOptionIds: [], customAnswer: "The rooftop" },
              { questionId: "q1", selectedOptionIds: ["o1"] },
            ],
          },
        },
      }),
    ]);
  });

  it("keeps the unsent answers after leaving the thread and coming back", async () => {
    const { transport, commands } = hostWith(several);
    const first = await render(transport, authenticator());
    await press(byLabel(first, "radio", "Hall A"));
    await type(first, "Your own answer for Extras", "Cake");
    const root = roots.pop();
    act(() => {
      root?.unmount();
    });

    const again = await render(transport, authenticator());
    expect(byLabel(again, "radio", "Hall A").getAttribute("aria-checked")).toBe("true");
    const field = again.querySelector('[aria-label="Your own answer for Extras"]');
    expect(field instanceof HTMLTextAreaElement ? field.value : undefined).toBe("Cake");
    await press(byLabel(again, "button", "Send answers"));
    expect(commands).toEqual([
      expect.objectContaining({
        resolution: {
          kind: "user-input",
          answer: {
            version: 1,
            answers: [
              { questionId: "q0", selectedOptionIds: ["o0"] },
              { questionId: "q1", selectedOptionIds: [], customAnswer: "Cake" },
            ],
          },
        },
      }),
    ]);
  });

  it("dismisses the questionnaire by cancelling the request", async () => {
    const { transport, commands } = hostWith(detail);
    const container = await render(transport, authenticator());
    await press(byText(container, "button", "Dismiss"));
    expect(commands).toEqual([{ kind: "cancel-work-request", requestId, expectedVersion: 4 }]);
  });
});
