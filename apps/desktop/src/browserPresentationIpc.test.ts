import { describe, expect, it } from "vitest";
import {
  decodeHumanBrowserRequest,
  decodeHumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import {
  decodeHumanBrowserIpcRequest,
  decodeHumanBrowserIpcResult,
} from "./browserPresentationIpc";

const owner = {
  contextId: "00000000-0000-4000-8000-000000000701",
  threadId: "00000000-0000-4000-8000-000000000702",
};
const presentationId = "00000000-0000-4000-8000-000000000703";
const frame = {
  status: "frame",
  sequence: 1,
  width: 800,
  height: 600,
  dataUrl: "data:image/jpeg;base64,AA==",
};

describe("sandboxed human Browser protocol", () => {
  it("keeps source editing menu identities and commands inside main", () => {
    const menuId = "00000000-0000-4000-8000-000000000704";
    for (const operation of [
      { kind: "edit-menu" },
      { kind: "edit-menu-watch", menuId },
      { kind: "edit-menu-keyboard", menuId },
      { kind: "edit-menu-dismiss", menuId },
      { kind: "edit-menu-action", menuId, action: "copy" },
    ]) {
      const request = { ...owner, presentationId, ...operation };
      expect(decodeHumanBrowserRequest(request)).toEqual(request);
      expect(() => decodeHumanBrowserIpcRequest(request)).toThrow();
    }
    const response = {
      status: "edit-menu",
      menuId,
      flags: { undo: true, redo: false, cut: false, copy: false, paste: false, selectAll: true },
    };
    expect(decodeHumanBrowserResult(response)).toEqual(response);
    expect(() => decodeHumanBrowserIpcResult(response)).toThrow();
    const pending = { status: "edit-menu-pending", menuId };
    expect(decodeHumanBrowserResult(pending)).toEqual(pending);
    expect(() => decodeHumanBrowserIpcResult(pending)).toThrow();
    expect(() =>
      decodeHumanBrowserRequest({
        ...owner,
        presentationId,
        kind: "edit-menu-action",
        menuId,
        action: "executeScript",
      }),
    ).toThrow();
  });

  it("carries each closed operation without importing the runtime schema into preload", () => {
    const requests = [
      { ...owner, kind: "attach" },
      {
        ...owner,
        presentationId,
        kind: "layout",
        layout: { width: 800, height: 600, visible: true },
      },
      { ...owner, presentationId, kind: "frame", acknowledgement: 0 },
      {
        ...owner,
        presentationId,
        kind: "input",
        frameSequence: 1,
        input: { type: "char", keyCode: "\r" },
      },
      { ...owner, presentationId, kind: "command", command: "reload" },
      { ...owner, presentationId, kind: "tab", command: { kind: "open" } },
      { ...owner, presentationId, kind: "state" },
      { ...owner, presentationId, kind: "detach" },
      { ...owner, presentationId, kind: "editor" },
      {
        ...owner,
        presentationId,
        kind: "composition",
        composition: { phase: "begin", editorId: presentationId },
      },
      {
        ...owner,
        presentationId,
        kind: "composition",
        composition: {
          phase: "update",
          compositionId: presentationId,
          text: "😀",
          selectionStart: 2,
          selectionEnd: 2,
        },
      },
      {
        ...owner,
        presentationId,
        kind: "composition",
        composition: { phase: "commit", compositionId: presentationId, text: "é" },
      },
      {
        ...owner,
        presentationId,
        kind: "composition",
        composition: { phase: "cancel", compositionId: presentationId },
      },
    ];
    for (const request of requests)
      expect(decodeHumanBrowserIpcRequest(request)).toEqual(decodeHumanBrowserRequest(request));
    for (const result of [
      { status: "attached", presentationId },
      frame,
      { status: "accepted" },
      { status: "idle" },
      { status: "refused" },
      { status: "editor-unavailable" },
      { status: "composition-started", compositionId: presentationId },
      {
        status: "editor",
        editor: {
          id: presentationId,
          selectionStart: 3,
          selectionEnd: 3,
          caret: { x: 87, y: 119, width: 0, height: 28 },
        },
      },
      // An email or number field and a rich editor carry only their caret.
      {
        status: "editor",
        editor: { id: presentationId, caret: { x: 4, y: 6, width: 0, height: 20 } },
      },
      // A password field carries its identity alone.
      { status: "editor", editor: { id: presentationId, secure: true } },
    ])
      expect(decodeHumanBrowserIpcResult(result)).toEqual(decodeHumanBrowserResult(result));
  });

  it("refuses caller authority, unknown input fields and invalid frame boundaries at both hops", () => {
    for (const request of [
      { ...owner, kind: "attach", windowId: owner.contextId },
      {
        ...owner,
        presentationId,
        kind: "composition",
        composition: {
          phase: "update",
          compositionId: presentationId,
          text: "😀",
          selectionStart: 1,
          selectionEnd: 1,
        },
      },
      {
        ...owner,
        presentationId,
        kind: "composition",
        composition: { phase: "commit", compositionId: presentationId, text: "\uD800" },
      },
      {
        ...owner,
        presentationId,
        kind: "composition",
        composition: { phase: "commit", compositionId: presentationId, text: "a".repeat(257) },
      },
      {
        ...owner,
        presentationId,
        kind: "input",
        frameSequence: 1,
        input: { type: "keyDown", keyCode: "a", script: "fixture" },
      },
    ]) {
      expect(() => decodeHumanBrowserIpcRequest(request)).toThrow();
      expect(() => decodeHumanBrowserRequest(request)).toThrow();
    }
    for (const result of [
      { ...frame, sequence: 0 },
      { ...frame, width: NaN },
      { ...frame, width: 1_921 },
      { ...frame, dataUrl: "data:text/html,fixture" },
      // A password field's offsets, caret or value never travel with its identity.
      {
        status: "editor",
        editor: { id: presentationId, secure: true, selectionStart: 0, selectionEnd: 7 },
      },
      {
        status: "editor",
        editor: {
          id: presentationId,
          secure: true,
          caret: { x: 4, y: 6, width: 0, height: 20 },
        },
      },
      { status: "editor", editor: { id: presentationId, secure: true, value: "fixture" } },
      { status: "editor", editor: { id: presentationId, secure: false } },
      {
        status: "editor",
        editor: {
          id: presentationId,
          selectionStart: 2,
          caret: { x: 4, y: 6, width: 0, height: 20 },
        },
      },
    ]) {
      expect(() => decodeHumanBrowserIpcResult(result)).toThrow();
      expect(() => decodeHumanBrowserResult(result)).toThrow();
    }
  });
});
