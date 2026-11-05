import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  decodeBrowserPresentationId,
  decodeBrowserEditorId,
  type HumanBrowserRequest,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import { EmbeddedBrowserSurface } from "./EmbeddedBrowserSurface";
import type { OctantHostBridge } from "../shell/hostBridge";

const contextId = "00000000-0000-4000-8000-000000000701";
const threadId = "00000000-0000-4000-8000-000000000702";
const presentationId = decodeBrowserPresentationId("00000000-0000-4000-8000-000000000703");

describe("embedded Browser pointer ownership", () => {
  it("retires the native input context when a deferred frame refuses without enlarging its caret", async () => {
    const calls: HumanBrowserRequest[] = [];
    let endFrame: ((value: HumanBrowserResult) => void) | undefined;
    const pending = new Promise<HumanBrowserResult>((done) => {
      endFrame = done;
    });
    let frames = 0;
    const bridge: Pick<OctantHostBridge, "presentBrowser"> = {
      presentBrowser: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId };
        if (request.kind === "frame")
          return ++frames === 1
            ? {
                status: "frame",
                sequence: 1,
                width: 800,
                height: 600,
                dataUrl: "data:image/jpeg;base64,AA==",
              }
            : frames === 2
              ? { status: "idle" }
              : pending;
        if (request.kind === "editor")
          return {
            status: "editor",
            editor: {
              id: decodeBrowserEditorId("00000000-0000-4000-8000-000000000715"),
              selectionStart: 1,
              selectionEnd: 1,
              caret: { x: 67, y: 158, width: 0, height: 24 },
            },
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
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const view = render(
      <EmbeddedBrowserSurface
        bridge={bridge}
        contextId={contextId}
        threadId={threadId}
        overlaySelector="[data-overlay]"
        onState={vi.fn()}
      />,
    );
    try {
      fireEvent.load(await screen.findByAltText("Browser page image"));
      screen.getByLabelText("Embedded Browser page").focus();
      const input = screen.getByLabelText("Browser text input");
      await waitFor(() => expect(input.getAttribute("contenteditable")).toBe("true"));
      endFrame?.({ status: "refused" });
      await waitFor(() => expect(input.getAttribute("contenteditable")).toBe("false"));
      expect(input.style.display).toBe("none");
      expect(Number.parseFloat(input.style.height)).toBeLessThanOrEqual(32);
      expect(calls.filter((request) => request.kind === "composition")).toHaveLength(0);
    } finally {
      endFrame?.({ status: "refused" });
      view.unmount();
      rect.mockRestore();
      rects.mockRestore();
      focus.mockRestore();
    }
  });
  it("leaves the page with Control-Escape while its text field holds focus", async () => {
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
        if (request.kind === "editor")
          return {
            status: "editor",
            editor: {
              id: decodeBrowserEditorId("00000000-0000-4000-8000-000000000716"),
              selectionStart: 0,
              selectionEnd: 0,
              caret: { x: 10, y: 10, width: 0, height: 24 },
            },
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
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    // jsdom has no Range geometry; the caret position itself is not under test.
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 0, 24),
    });
    const view = render(
      <EmbeddedBrowserSurface
        bridge={bridge}
        contextId={contextId}
        threadId={threadId}
        overlaySelector="[data-overlay]"
        onState={vi.fn()}
      />,
    );
    try {
      fireEvent.load(await screen.findByAltText("Browser page image"));
      const surface = screen.getByLabelText("Embedded Browser page");
      surface.focus();
      const input = screen.getByLabelText("Browser text input");
      await waitFor(() => expect(document.activeElement).toBe(input));
      fireEvent.keyDown(input, { key: "Escape", ctrlKey: true });
      expect(surface.contains(document.activeElement)).toBe(false);
      await waitFor(() => expect(calls.some((request) => request.kind === "detach")).toBe(true));
    } finally {
      view.unmount();
      rect.mockRestore();
      rects.mockRestore();
      focus.mockRestore();
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });
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
