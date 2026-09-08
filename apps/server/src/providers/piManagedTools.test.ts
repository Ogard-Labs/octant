import type { ProviderToolDefinition } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiManagedToolsBridge, type PiManagedToolCall } from "./piManagedTools";

const definition: ProviderToolDefinition = {
  name: "octant_browser",
  description: "Use the Octant Browser session.",
  inputSchema: {
    type: "object",
    properties: { action: { type: "string" } },
    required: ["action"],
  },
};

const bridges: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("Pi app-managed tool bridge", () => {
  it("routes a custom tool call through the per-session loopback endpoint", async () => {
    const calls: PiManagedToolCall[] = [];
    const bridge = await createPiManagedToolsBridge([definition], async (call) => {
      calls.push(call);
      return { resultJson: JSON.stringify({ ok: true }), isError: false };
    });
    bridges.push(bridge);

    const response = await fetch(bridge.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-pi-token": bridge.config.token,
      },
      body: JSON.stringify({
        toolCallId: "pi-call-1",
        name: definition.name,
        input: { action: "navigate" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resultJson: JSON.stringify({ ok: true }),
      isError: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolCallId: "pi-call-1",
      name: definition.name,
      inputJson: JSON.stringify({ action: "navigate" }),
    });
  });

  it("refuses a request with the wrong token without invoking the app tool", async () => {
    let invoked = false;
    const bridge = await createPiManagedToolsBridge([definition], async () => {
      invoked = true;
      return { resultJson: "{}", isError: false };
    });
    bridges.push(bridge);

    const response = await fetch(bridge.config.url, {
      method: "POST",
      headers: { "x-octant-pi-token": "wrong-token" },
      body: JSON.stringify({ toolCallId: "pi-call-1", name: definition.name, input: {} }),
    });

    expect(response.status).toBe(404);
    expect(invoked).toBe(false);
  });

  it("propagates client cancellation to the pending app tool", async () => {
    let received: PiManagedToolCall | undefined;
    const bridge = await createPiManagedToolsBridge([definition], async (call) => {
      received = call;
      return await new Promise((resolve) => {
        call.signal.addEventListener(
          "abort",
          () =>
            resolve({ resultJson: JSON.stringify({ error: "tool-interrupted" }), isError: true }),
          { once: true },
        );
      });
    });
    bridges.push(bridge);
    const controller = new AbortController();
    const request = fetch(bridge.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-pi-token": bridge.config.token,
      },
      body: JSON.stringify({ toolCallId: "pi-call-1", name: definition.name, input: {} }),
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(received).toBeDefined());
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(received?.signal.aborted).toBe(true));
  });
});
