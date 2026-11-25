// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { BiometricAuthenticator } from "../security/BiometricGate";
import { ThemeProvider } from "../../design-system/theme";
import { ThreadSecretCards } from "./ThreadSecretCard";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-local-authentication", () => ({}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassChip")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const threadId = "00000000-0000-4000-8000-000000000020";
const ID = "00000000-0000-4000-8000-000000000030";
const REMEMBERED = "00000000-0000-4000-8000-000000000031";
const card = {
  id: ID,
  threadId,
  name: "DEPLOY_TOKEN",
  label: "Deploy token",
  kind: "token",
  reason: "Publish the preview build.",
  delivery: "file",
  fields: [{ name: "DEPLOY_TOKEN", label: "Deploy token", secret: true }],
  lifetimes: ["this-turn", "24-hours", "remember"],
  defaultLifetime: "24-hours",
  sources: ["pasted"],
  remembered: [],
  state: "pending",
};
const roots: Root[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => root?.unmount());
  }
  document.body.replaceChildren();
});

async function show(
  over: Record<string, unknown> = {},
  reply: () => Response = () => Response.json({ status: "accepted" }),
  confirmed: "confirmed" | "denied" = "confirmed",
) {
  const answers: unknown[] = [];
  const transport: MobileRemoteTransport = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    authenticatedFetch: async ({ body }) => {
      const sent = JSON.parse(String(body)) as { kind: string; answer?: unknown };
      if (sent.kind === "answer") {
        answers.push(sent.answer);
        return reply();
      }
      return Response.json({ requests: [{ ...card, ...over }], active: [] });
    },
  };
  const authenticator: BiometricAuthenticator = {
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => confirmed),
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        surfaceStyle: "flat",
        children: createElement(ThreadSecretCards, {
          transport,
          authenticator,
          threadId,
          refreshIntervalMs: 60_000,
        }),
      }),
    );
  });
  const input = (label = "Deploy token") =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  return {
    container,
    answers,
    authenticator,
    input,
    type: async (value: string, label?: string) =>
      act(async () => {
        const target = input(label);
        if (target === null) throw new Error("No such field.");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          target,
          value,
        );
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    press: async (label: string) =>
      act(async () => {
        const target = [
          ...container.querySelectorAll<HTMLElement>('[role="button"], [role="radio"]'),
        ].find((node) => node.textContent?.trim() === label);
        if (target === undefined) throw new Error(`No ${label}.`);
        target.click();
      }),
  };
}

describe("a secret's card on the phone", () => {
  it.each([
    ["saved", "Deploy token · Saved securely"],
    ["declined", "Deploy token · Declined"],
  ])("keeps a quiet row for a card that was %s, with nothing to answer", async (state, text) => {
    const view = await show({ state });
    expect(view.container.textContent).toBe(text);
    expect(view.input()).toBeNull();
  });

  it("masks the value, sends it exactly as typed after the phone's own confirmation, and clears it", async () => {
    const view = await show();
    expect(view.container.textContent).toContain("Deploy token");
    expect(view.container.textContent).toContain("Publish the preview build.");
    expect(view.input()?.type).toBe("password");
    await view.type(" private value ");
    await view.press("This turn");
    await view.press("Save securely");
    expect(view.authenticator.authenticate).toHaveBeenCalledOnce();
    expect(view.answers).toEqual([
      {
        id: ID,
        action: "save",
        lifetime: "this-turn",
        fields: [{ name: "DEPLOY_TOKEN", source: "pasted", value: " private value " }],
      },
    ]);
    expect(view.input()?.value).toBe("");
  });

  it("sends nothing without the confirmation, and keeps what was typed", async () => {
    const view = await show({}, undefined, "denied");
    await view.type("private-value");
    await view.press("Save securely");
    expect(view.answers).toEqual([]);
    expect(view.input()?.value).toBe("private-value");
  });

  it("declines without a confirmation", async () => {
    const view = await show();
    await view.press("Decline");
    expect(view.authenticator.authenticate).not.toHaveBeenCalled();
    expect(view.answers).toEqual([{ id: ID, action: "decline" }]);
  });

  it("offers a remembered value and drops what was typed for it", async () => {
    const view = await show({
      sources: ["pasted", "remembered"],
      remembered: [{ id: REMEMBERED, name: "DEPLOY_TOKEN", source: "pasted" }],
    });
    await view.type("discarded");
    await view.press("Remembered DEPLOY_TOKEN");
    await view.press("Save securely");
    expect(view.answers).toMatchObject([
      { fields: [{ name: "DEPLOY_TOKEN", source: "remembered", rememberedId: REMEMBERED }] },
    ]);
    await view.press("Enter it");
    expect(view.input()?.value).toBe("");
  });

  it("collects several fields, showing one that is not secret as it is typed", async () => {
    const view = await show({
      name: "SERVICE",
      fields: [
        { name: "EMAIL", label: "Email", secret: false },
        { name: "PASSWORD", label: "Password", secret: true },
      ],
    });
    expect(view.input("Email")?.type).not.toBe("password");
    await view.type("person@example.com", "Email");
    await view.press("Save securely");
    expect(view.answers).toEqual([]);
    await view.type("private-value", "Password");
    await view.press("Save securely");
    expect(view.answers).toMatchObject([
      { fields: [{ name: "EMAIL" }, { name: "PASSWORD", value: "private-value" }] },
    ]);
  });

  it("warns for an account password, and for a value too short to hide", async () => {
    const view = await show({ kind: "account-password", lifetimes: ["this-turn", "24-hours"] });
    expect(view.container.textContent).toContain("unlocks that whole computer");
    expect(view.container.textContent).not.toContain("Remember");
    await view.type("abc");
    expect(view.container.textContent).toContain("Too short to hide");
  });

  it("keeps a refused value to try again, and clears one whose outcome is not known", async () => {
    let reply = () => Response.json({ status: "refused", failure: "refused-by-strict" });
    const view = await show({}, () => reply());
    await view.type("private-value");
    await view.press("Save securely");
    expect(view.container.textContent).toContain("Choose a shorter time");
    expect(view.input()?.value).toBe("private-value");
    reply = () => Response.json({}, { status: 502 });
    await view.press("Save securely");
    expect(view.container.textContent).toContain("The result is not known");
    expect(view.input()?.value).toBe("");
  });
});
