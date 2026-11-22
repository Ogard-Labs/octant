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

it.each(["Transcribe", "Don't transcribe"])(
  "discloses the Voice destination on the phone and sends only the confirmed choice: %s",
  async (action) => {
    const threadId = "00000000-0000-4000-8000-000000000020";
    const offerId = "00000000-0000-4000-8000-000000000021";
    const offer = {
      kind: "transcribe",
      threadKind: "work-thread",
      scopeId: threadId,
      offerId,
      requestedAt: "2026-10-15T06:00:00.000Z",
      relativePath: "notes.wav",
      sizeBytes: 123,
      endpointName: "Studio",
      modelId: "meeting",
    };
    const answers: string[] = [];
    const authenticatedFetch: MobileRemoteTransport["authenticatedFetch"] = async (request) => {
      if (request.method === "GET")
        return Response.json({ offers: answers.length === 0 ? [offer] : [] });
      answers.push(String(request.body));
      return Response.json({ kind: "offer-answered" });
    };
    const authenticate = vi.fn().mockResolvedValueOnce("denied").mockResolvedValueOnce("confirmed");
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          createElement(ThemeProvider, {
            preference: "light",
            children: createElement(ServiceOfferCard, {
              transport: { hostId: "studio", authenticatedFetch },
              authenticator: { hasDeviceCredential: async () => true, authenticate },
              threadId,
              threadKind: "work-thread",
              inProject: true,
            }),
          }),
        ),
      );
      expect(node.textContent).toContain("notes.wav");
      expect(node.textContent).toContain("123 bytes · Sent to Studio (meeting)");
      expect(node.textContent).toContain("Don't ask again in this thread");
      const button = node.querySelector<HTMLElement>(`[aria-label="${action}"]`);
      expect(button).not.toBeNull();
      await act(async () => button?.click());
      if (action === "Transcribe") {
        expect(answers).toEqual([]);
        await act(async () => button?.click());
        expect(answers.map((s) => JSON.parse(s))).toEqual([
          { offerId, decision: "transcribe", rememberForThread: false },
        ]);
      } else {
        expect(authenticate).not.toHaveBeenCalled();
        expect(answers.map((s) => JSON.parse(s))).toEqual([{ offerId, decision: "cancel" }]);
      }
    } finally {
      act(() => root.unmount());
      node.remove();
    }
  },
);

it.each(["Narrate", "Don't narrate"])(
  "discloses the narration excerpt, path and Voice destination on the phone and gates approval: %s",
  async (action) => {
    const threadId = "00000000-0000-4000-8000-000000000020";
    const offerId = "00000000-0000-4000-8000-000000000023";
    const offer = {
      kind: "narrate",
      threadKind: "work-thread",
      scopeId: threadId,
      offerId,
      requestedAt: "2026-10-15T06:00:00.000Z",
      excerpt: "Welcome to the release walkthrough",
      characters: 34,
      relativePath: "narration/intro.mp3",
      voice: "alloy",
      endpointName: "Studio",
      modelId: "tts-1",
      format: "mp3",
    };
    const answers: string[] = [];
    const authenticatedFetch: MobileRemoteTransport["authenticatedFetch"] = async (request) => {
      if (request.method === "GET")
        return Response.json({ offers: answers.length === 0 ? [offer] : [] });
      answers.push(String(request.body));
      return Response.json({ kind: "offer-answered" });
    };
    const authenticate = vi.fn().mockResolvedValueOnce("denied").mockResolvedValueOnce("confirmed");
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          createElement(ThemeProvider, {
            preference: "light",
            children: createElement(ServiceOfferCard, {
              transport: { hostId: "studio", authenticatedFetch },
              authenticator: { hasDeviceCredential: async () => true, authenticate },
              threadId,
              threadKind: "work-thread",
              inProject: true,
            }),
          }),
        ),
      );
      expect(node.textContent).toContain("narration/intro.mp3");
      expect(node.textContent).toContain("Welcome to the release walkthrough");
      expect(node.textContent).toContain("Voice alloy on Studio (tts-1)");
      expect(node.textContent).toContain("Don't ask again in this thread");
      const button = node.querySelector<HTMLElement>(`[aria-label="${action}"]`);
      expect(button).not.toBeNull();
      await act(async () => button?.click());
      if (action === "Narrate") {
        expect(answers).toEqual([]);
        await act(async () => button?.click());
        expect(answers.map((s) => JSON.parse(s))).toEqual([
          { offerId, decision: "narrate", rememberForThread: false },
        ]);
      } else {
        expect(authenticate).not.toHaveBeenCalled();
        expect(answers.map((s) => JSON.parse(s))).toEqual([{ offerId, decision: "cancel" }]);
      }
    } finally {
      act(() => root.unmount());
      node.remove();
    }
  },
);

it("hides Don't ask again on the phone narration card when the access level always asks", async () => {
  const threadId = "00000000-0000-4000-8000-000000000020";
  const offerId = "00000000-0000-4000-8000-000000000024";
  const offer = {
    kind: "narrate",
    threadKind: "work-thread",
    scopeId: threadId,
    offerId,
    requestedAt: "2026-10-15T06:00:00.000Z",
    excerpt: "Ask first narration",
    characters: 19,
    relativePath: "narration/ask.mp3",
    voice: "alloy",
    endpointName: "Studio",
    modelId: "tts-1",
    format: "mp3",
    canRemember: false,
  };
  const answers: string[] = [];
  const authenticatedFetch: MobileRemoteTransport["authenticatedFetch"] = async (request) => {
    if (request.method === "GET")
      return Response.json({ offers: answers.length === 0 ? [offer] : [] });
    answers.push(String(request.body));
    return Response.json({ kind: "offer-answered" });
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          children: createElement(ServiceOfferCard, {
            transport: { hostId: "studio", authenticatedFetch },
            authenticator: {
              hasDeviceCredential: async () => true,
              authenticate: async () => "confirmed" as const,
            },
            threadId,
            threadKind: "work-thread",
            inProject: true,
          }),
        }),
      ),
    );
    expect(node.textContent).not.toContain("Don't ask again in this thread");
    const button = node.querySelector<HTMLElement>('[aria-label="Narrate"]');
    await act(async () => button?.click());
    expect(answers.map((s) => JSON.parse(s))).toEqual([
      { offerId, decision: "narrate", rememberForThread: false },
    ]);
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});

it.each([false, true])(
  "requires confirmation on the phone, with reference images: %s",
  async (references) => {
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
      ...(references
        ? {
            references: [
              {
                kind: "browser-capture",
                label: "Browser screenshot of example.com",
                signedIn: true,
              },
            ],
          }
        : {}),
    };
    let answered = false;
    const authenticatedFetch = vi.fn<MobileRemoteTransport["authenticatedFetch"]>(
      async (request) => {
        if (request.method === "GET")
          return Response.json({
            offers: answered ? [] : [offer],
            ...(references
              ? {
                  imageProfiles: [
                    {
                      instanceId: profileInstanceId,
                      displayName: "Reference model",
                      driverKind: "openai-image",
                      modelAllowlist: [modelId],
                      defaultModel: modelId,
                    },
                  ],
                }
              : {}),
          });
        answered = true;
        return Response.json({ kind: "offer-answered" });
      },
    );
    const authenticate = vi.fn().mockResolvedValueOnce("denied").mockResolvedValueOnce("confirmed");
    const transport = { hostId: "studio", authenticatedFetch };
    const authenticator = { hasDeviceCredential: async () => true, authenticate };
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    try {
      await act(async () =>
        root.render(
          createElement(ThemeProvider, {
            preference: "light",
            children: createElement(ServiceOfferCard, {
              transport,
              authenticator,
              threadId,
              threadKind: "chat-thread",
              inProject: false,
            }),
          }),
        ),
      );
      expect(authenticatedFetch.mock.calls[0]?.[0]).toMatchObject({
        method: "GET",
        path: "/api/offers",
        query: `?threadKind=chat-thread&scopeId=${threadId}&referenceImages=1&transcription=1&narration=1&iconSets=1&video=1`,
      });
      if (references) {
        expect(node.textContent).toContain(
          "These images will be sent to the selected image provider:",
        );
        expect(node.textContent).toContain("Browser screenshot of example.com (signed-in page)");
        expect(node.textContent).not.toContain("Don't ask again");
      }
      const generate = node.querySelector<HTMLElement>('[aria-label="Generate"]');
      expect(generate).not.toBeNull();
      await act(async () => generate?.click());
      expect(
        authenticatedFetch.mock.calls.filter(([request]) => request.method === "POST"),
      ).toEqual([]);
      await act(async () => generate?.click());
      expect(
        authenticatedFetch.mock.calls.filter(([request]) => request.method === "POST"),
      ).toEqual([
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
              ...(references ? { referenceImagesConfirmed: true } : {}),
            }),
          },
        ],
      ]);
      expect(node.textContent).not.toContain(offer.prompt);
    } finally {
      act(() => root.unmount());
      node.remove();
    }
  },
);
