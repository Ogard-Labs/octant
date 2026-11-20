// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { ServiceOfferCard } from "./ServiceOfferCard";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-local-authentication", () => ({}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/GlassSurface")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("opens the phone's own image offer, and sends no paid answer until confirmation", async () => {
  const threadId = "00000000-0000-4000-8000-000000000020";
  const offerId = "00000000-0000-4000-8000-000000000021";
  const profileInstanceId = "00000000-0000-4000-8000-000000000022";
  const modelId = "host-model";
  const suggested = { profileInstanceId, modelId };
  const offer = {
    kind: "generate",
    offerId,
    threadKind: "chat-thread",
    scopeId: threadId,
    prompt: "A blue sailboat",
    revision: false,
    variantCount: 1,
    suggested,
    requestedAt: "2026-10-15T06:00:00.000Z",
  };
  let answered = false;
  const authenticatedFetch = vi.fn<MobileRemoteTransport["authenticatedFetch"]>(async (request) => {
    if (request.method === "GET") return Response.json({ offers: answered ? [] : [offer] });
    answered = true;
    return Response.json({ kind: "offer-answered" });
  });
  const authenticate = vi.fn().mockResolvedValueOnce("denied").mockResolvedValueOnce("confirmed");
  const transport = { hostId: "studio", authenticatedFetch };
  const authenticator = { hasDeviceCredential: async () => true, authenticate };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(
          ThemeProvider,
          {},
          createElement(ServiceOfferCard, {
            transport,
            authenticator,
            threadId,
            threadKind: "chat-thread",
            inProject: false,
          }),
        ),
      ),
    );
    expect(authenticatedFetch.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/api/offers",
      query: `?threadKind=chat-thread&scopeId=${threadId}`,
    });
    const generate = node.querySelector<HTMLElement>('[aria-label="Generate"]');
    expect(generate).not.toBeNull();
    await act(async () => generate?.click());
    expect(authenticatedFetch.mock.calls.filter(([request]) => request.method === "POST")).toEqual(
      [],
    );
    await act(async () => generate?.click());
    expect(authenticatedFetch.mock.calls.filter(([request]) => request.method === "POST")).toEqual([
      [
        {
          method: "POST",
          path: "/api/offers/decide",
          contentType: "application/json",
          body: JSON.stringify({
            offerId,
            decision: "generate",
            profileInstanceId,
            modelId,
            rememberForThread: false,
          }),
        },
      ],
    ]);
    expect(node.textContent).not.toContain(offer.prompt);
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});
