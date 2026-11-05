import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  decodeBrowserPresentationId,
  type HumanBrowserRequest,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import { EmbeddedBrowserSurface } from "./EmbeddedBrowserSurface";
import type { OctantHostBridge } from "../shell/hostBridge";

const contextId = "00000000-0000-4000-8000-000000000701";
const threadId = "00000000-0000-4000-8000-000000000702";
const presentationId = decodeBrowserPresentationId("00000000-0000-4000-8000-000000000703");

describe("embedded Browser pointer ownership", () => {
  it("keeps a completed click attached and releases unexpected pointer cancellation", async () => {
    const calls: HumanBrowserRequest[] = [];
    const bridge: Pick<OctantHostBridge, "presentBrowser"> = {
      presentBrowser: async (request): Promise<HumanBrowserResult> => {
        calls.push(request);
        return request.kind === "attach"
          ? { status: "attached", presentationId }
          : { status: "accepted" };
      },
    };
    const rendered = render(
      <EmbeddedBrowserSurface
        bridge={bridge}
        contextId={contextId}
        threadId={threadId}
        overlaySelector="[data-overlay]"
        onState={vi.fn()}
      />,
    );
    const surface = screen.getByLabelText("Embedded Browser page");
    Object.defineProperty(surface, "setPointerCapture", { value: vi.fn() });
    const pointer = (type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(surface, event);
    };
    try {
      await waitFor(() => expect(calls.some((request) => request.kind === "attach")).toBe(true));
      pointer("pointerdown");
      pointer("pointerup");
      pointer("lostpointercapture");
      expect(calls.filter((request) => request.kind === "detach")).toHaveLength(0);
      pointer("pointerdown");
      pointer("pointercancel");
      await waitFor(() => expect(calls.some((request) => request.kind === "detach")).toBe(true));
    } finally {
      rendered.unmount();
    }
  });
  it("releases the remembered physical key and sends the Enter character after its key down", async () => {
    const calls: HumanBrowserRequest[] = [];
    const bridge: Pick<OctantHostBridge, "presentBrowser"> = {
      presentBrowser: async (request): Promise<HumanBrowserResult> => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId };
        if (request.kind === "frame")
          return {
            status: "frame",
            sequence: 1,
            width: 800,
            height: 600,
            dataUrl: "data:image/jpeg;base64,AA==",
          };
        return { status: "accepted" };
      },
    };
    const rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 800, 600));
    const rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue(Object.assign([new DOMRect(0, 0, 800, 600)], { item: () => null }));
    const rendered = render(
      <EmbeddedBrowserSurface
        bridge={bridge}
        contextId={contextId}
        threadId={threadId}
        overlaySelector="[data-overlay]"
        onState={vi.fn()}
      />,
    );
    try {
      const image = await screen.findByAltText("Browser page image");
      fireEvent.load(image);
      const surface = screen.getByLabelText("Embedded Browser page");
      surface.focus();
      fireEvent.keyDown(surface, { key: "A", code: "KeyA", shiftKey: true });
      fireEvent.keyUp(surface, { key: "a", code: "KeyA" });
      fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });
      fireEvent.keyUp(surface, { key: "Enter", code: "Enter" });
      expect(
        calls.filter((request) => request.kind === "input").map((request) => request.input),
      ).toEqual([
        { type: "keyDown", keyCode: "A", modifiers: ["shift"] },
        { type: "char", keyCode: "A" },
        { type: "keyUp", keyCode: "A", modifiers: [] },
        { type: "keyDown", keyCode: "Enter", modifiers: [] },
        { type: "char", keyCode: "\r" },
        { type: "keyUp", keyCode: "Enter", modifiers: [] },
      ]);
    } finally {
      rendered.unmount();
      rect.mockRestore();
      rects.mockRestore();
    }
  });
});
