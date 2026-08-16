import { describe, expect, it } from "vitest";
import {
  createNavigatorAssistantClient,
  NavigatorAssistantClientFailure,
} from "./navigatorAssistantClient";

const windowCapability = "C".repeat(43);

const snapshot = {
  status: "ready",
  settingsTarget: { section: "navigator-assistant", setting: "default-model" },
  threadId: "9e000000-0000-4000-8000-0000000000cc",
  transcript: [
    { role: "user", text: "Which model do I run on?", createdAt: "2026-08-15T09:00:00.000Z" },
  ],
  defaultProvider: {
    providerInstanceId: "9e000000-0000-4000-8000-0000000000b1",
    modelId: "model-a",
  },
  imageInput: "unknown",
  visionReviewer: null,
} as const;

function client(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    client: createNavigatorAssistantClient({
      baseUrl: "http://127.0.0.1:4000",
      fetch,
      windowCapability,
    }),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("navigatorAssistantClient", () => {
  it("carries the window capability and decodes the host snapshot", async () => {
    const { client: navigatorAssistant, calls } = client(() => json(snapshot));
    const result = await navigatorAssistant.snapshot();

    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/api/navigator-assistant/snapshot");
    expect((calls[0]?.init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(
      windowCapability,
    );
    expect(result.status).toBe("ready");
    expect(result.defaultProvider?.modelId).toBe("model-a");
  });

  it("posts one command and decodes the host's result", async () => {
    const { client: navigatorAssistant, calls } = client(() =>
      json({ kind: "message-sent", snapshot }),
    );
    const result = await navigatorAssistant.execute({ kind: "send-message", prompt: "Hello" });

    expect(calls[0]?.url).toBe("http://127.0.0.1:4000/api/navigator-assistant/commands");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ kind: "send-message", prompt: "Hello" }));
    expect(result.kind).toBe("message-sent");
  });

  it("keeps the host's category and settings deep link on a refusal", async () => {
    const { client: navigatorAssistant } = client(() =>
      json(
        {
          error: "Navigator has no default model.",
          category: "unconfigured",
          settingsTarget: { section: "navigator-assistant", setting: "default-model" },
        },
        409,
      ),
    );

    const failure = await navigatorAssistant
      .execute({ kind: "send-message", prompt: "Hello" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NavigatorAssistantClientFailure);
    const typed = failure as NavigatorAssistantClientFailure;
    expect(typed.status).toBe(409);
    expect(typed.category).toBe("unconfigured");
    // Without the deep link the renderer could only say "unavailable"; with it
    // the surface can offer the exact fix.
    expect(typed.settingsTarget).toEqual({
      section: "navigator-assistant",
      setting: "default-model",
    });
  });

  it("refuses a non-loopback base URL", () => {
    expect(() =>
      createNavigatorAssistantClient({
        baseUrl: "https://example.test",
        fetch: globalThis.fetch,
        windowCapability,
      }),
    ).toThrow(NavigatorAssistantClientFailure);
  });

  it("rejects a host answer that is not a Navigator snapshot", async () => {
    const { client: navigatorAssistant } = client(() => json({ status: "definitely-ready" }));
    await expect(navigatorAssistant.snapshot()).rejects.toThrow();
  });
});
