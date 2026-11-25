// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { BiometricAuthenticator } from "../security/BiometricGate";
import { ThemeProvider } from "../../design-system/theme";
import { BrowserApprovalCard } from "./BrowserApprovalCard";

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
const approvalId = "00000000-0000-4000-8000-000000000030";
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

const upload = {
  approvalId,
  threadId,
  mode: "work",
  origin: "https://example.com",
  upload: { files: [{ name: "report.pdf", sizeBytes: 12_288 }] },
  requestedAt: "2026-11-25T10:00:00.000Z",
};

function host(decideAnswer: () => Response = () => Response.json({ accepted: true })) {
  const answers: Array<unknown> = [];
  let answered = false;
  const transport: MobileRemoteTransport = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    authenticatedFetch: async ({ body }) => {
      const parsed = JSON.parse(String(body)) as { kind: string };
      if (parsed.kind === "decide") {
        answers.push(parsed);
        answered = true;
        return decideAnswer();
      }
      return Response.json(answered ? [] : [upload]);
    },
  };
  return { transport, answers };
}

function authenticator(result: "confirmed" | "denied" = "confirmed"): BiometricAuthenticator {
  return {
    hasDeviceCredential: vi.fn(async () => true),
    authenticate: vi.fn(async () => result),
  };
}

async function mount(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        surfaceStyle: "flat",
        children: createElement(BrowserApprovalCard, {
          threadId,
          refreshIntervalMs: 60_000,
          ...props,
        } as never),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const press = async (container: ParentNode, label: string) => {
  const node = [...container.querySelectorAll('[role="button"]')].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  ) as HTMLElement | undefined;
  expect(node).toBeDefined();
  await act(async () => {
    node?.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

const choices = (container: ParentNode) =>
  [...container.querySelectorAll('[role="button"]')].map((node) => node.getAttribute("aria-label"));

describe("Browser prompt on the phone", () => {
  it("shows the site, profile, direction and files, and offers every answer to the host's person", async () => {
    const { transport } = host();
    const container = await mount({ transport, actsAsHostPerson: true });
    const facts = container.querySelector('[data-testid="mobile-browser-approval-facts"]');
    expect(facts?.textContent).toBe("Site: https://example.com. Profile: Private. Upload.");
    expect(
      container.querySelector('[data-testid="mobile-browser-approval-file"]')?.textContent,
    ).toBe("report.pdf (12 KB)");
    expect(choices(container)).toEqual(["Upload once", "Always allow", "Deny"]);
  });

  it("offers a restricted session only the one-time answer and Deny", async () => {
    const { transport } = host();
    const container = await mount({ transport });
    expect(choices(container)).toEqual(["Upload once", "Deny"]);
  });

  it("sends Always allow as remembered after the phone confirms, and clears the prompt", async () => {
    const { transport, answers } = host();
    const confirm = authenticator();
    const container = await mount({ transport, actsAsHostPerson: true, authenticator: confirm });
    await press(container, "Always allow");
    expect(confirm.authenticate).toHaveBeenCalledOnce();
    expect(answers).toEqual([{ kind: "decide", approvalId, decision: "approved", remember: true }]);
    expect(container.querySelector('[data-testid="mobile-browser-approval"]')).toBeNull();
  });

  it("sends nothing when the phone's confirmation is denied, and denies without asking", async () => {
    const refusing = host();
    const container = await mount({
      transport: refusing.transport,
      actsAsHostPerson: true,
      authenticator: authenticator("denied"),
    });
    await press(container, "Upload once");
    expect(refusing.answers).toEqual([]);
    const denying = host();
    const second = await mount({
      transport: denying.transport,
      authenticator: authenticator("denied"),
    });
    await press(second, "Deny");
    expect(denying.answers).toEqual([{ kind: "decide", approvalId, decision: "denied" }]);
  });

  it("says another client answered first when the host reports the prompt settled", async () => {
    const { transport } = host(() => Response.json({ accepted: false }, { status: 409 }));
    const container = await mount({ transport, authenticator: authenticator() });
    await press(container, "Upload once");
    expect(
      container.querySelector('[data-testid="mobile-browser-approval-note"]')?.textContent,
    ).toBe(
      "The agent's upload to https://example.com had already been answered or ended, so nothing was sent.",
    );
  });

  it("says the host refused when it refuses the answer", async () => {
    const { transport } = host(() => new Response("no", { status: 403 }));
    const container = await mount({ transport, authenticator: authenticator() });
    await press(container, "Upload once");
    expect(
      container.querySelector('[data-testid="mobile-browser-approval-note"]')?.textContent,
    ).toContain("The host refused that answer.");
  });

  it("never reads the host's prompts for a session that may only watch", async () => {
    const { transport, answers } = host();
    const read = vi.spyOn(transport, "authenticatedFetch");
    const container = await mount({ transport, watchingOnly: true });
    expect(read).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="mobile-browser-approval"]')).toBeNull();
    expect(answers).toEqual([]);
  });

  it("keeps the prompt settled while the reload runs, so a second tap cannot meet its own answer", async () => {
    const answers: unknown[] = [];
    // The host keeps listing the prompt after the answer, as a slow reload would.
    const transport: MobileRemoteTransport = {
      hostId: "00000000-0000-4000-8000-0000000000aa",
      authenticatedFetch: async ({ body }) => {
        const parsed = JSON.parse(String(body)) as { kind: string };
        if (parsed.kind === "decide") {
          answers.push(parsed);
          return answers.length === 1
            ? Response.json({ accepted: true })
            : Response.json({ accepted: false }, { status: 409 });
        }
        return Response.json([upload]);
      },
    };
    const container = await mount({ transport, authenticator: authenticator() });
    await press(container, "Upload once");
    expect(answers).toHaveLength(1);
    expect(container.querySelector('[data-testid="mobile-browser-approval"]')).toBeNull();
    expect(container.querySelector('[data-testid="mobile-browser-approval-note"]')).toBeNull();
  });

  it("shows a script whole, selectable, and scrollable instead of cutting it off", async () => {
    const source = Array.from({ length: 40 }, (_, line) => `step${line}();`).join("\n");
    const transport: MobileRemoteTransport = {
      hostId: "00000000-0000-4000-8000-0000000000aa",
      authenticatedFetch: async () =>
        Response.json([{ ...upload, upload: undefined, script: { source }, mode: "work" }]),
    };
    const container = await mount({ transport });
    const shown = container.querySelector('[data-testid="mobile-browser-approval-context"]');
    expect(shown?.textContent).toBe(source);
    expect(shown?.getAttribute("data-selectable")).not.toBe("false");
    expect(choices(container)).toEqual(["Run once", "Cancel"]);
  });

  it("words and limits a program in a terminal's request as the web does", async () => {
    const transport: MobileRemoteTransport = {
      hostId: "00000000-0000-4000-8000-0000000000aa",
      authenticatedFetch: async () =>
        Response.json([{ ...upload, upload: undefined, mode: "code" }]),
    };
    const container = await mount({
      transport,
      actsAsHostPerson: true,
      threadTitle: "Fix the login page",
    });
    expect(container.textContent).toContain("Browser request from a terminal");
    expect(container.textContent).toContain(
      "Let the terminal open https://example.com in the Browser?",
    );
    expect(container.textContent).toContain(
      "Asked by a program in a terminal of “Fix the login page”, not by this thread's agent",
    );
    expect(choices(container)).toEqual(["Approve once", "Always allow", "Deny"]);
  });
});
