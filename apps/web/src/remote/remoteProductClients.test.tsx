import { createDefaultDeviceKeyStore, createRemoteSessionBridge } from "@octant/client-runtime";
import { describe, expect, it, vi } from "vitest";
import { createRemoteProductClients } from "./remoteProductClients";

describe("remote product clients", () => {
  it("lets a paired browser read a person's saved decision answers and never write them", () => {
    const bridge = createRemoteSessionBridge({
      fetch: vi.fn(),
      deviceKeyStore: createDefaultDeviceKeyStore(),
    });
    const { canvas } = createRemoteProductClients(bridge);
    expect(canvas.choiceAnswers).toBeTypeOf("function");
    expect(canvas).not.toHaveProperty("reviseChoiceAnswers");
    expect(canvas).not.toHaveProperty("comment");
  });
});
