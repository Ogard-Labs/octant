import type * as monaco from "monaco-editor";
import { afterEach, expect, it, vi } from "vitest";
import { installNativeEditorMenu } from "./nativeEditorMenu";

afterEach(() => Reflect.deleteProperty(window, "octantHost"));

it("runs native editor choices through the editor and refuses edits after read-only changes", async () => {
  let listener: ((event: monaco.editor.IEditorMouseEvent) => void) | undefined;
  let readOnly = false;
  let keyListener: ((event: monaco.IKeyboardEvent) => void) | undefined;
  const trigger = vi.fn();
  const dispose = vi.fn();
  const editor = {
    updateOptions: vi.fn(),
    onContextMenu: (callback: typeof listener) => {
      listener = callback;
      return { dispose };
    },
    onKeyDown: (callback: typeof keyListener) => {
      keyListener = callback;
      return { dispose: vi.fn() };
    },
    getDomNode: () => null,
    getPosition: () => null,
    getScrolledVisiblePosition: () => null,
    getSelection: () => null,
    setPosition: vi.fn(),
    focus: vi.fn(),
    getRawOptions: () => ({ readOnly }),
    getModel: () => ({ canUndo: () => true, canRedo: () => false }),
    getAction: () => null,
    trigger,
  } as unknown as monaco.editor.IStandaloneCodeEditor;
  const popup = vi.fn().mockResolvedValue({ kind: "selected", id: "3" });
  Object.defineProperty(window, "octantHost", {
    configurable: true,
    value: { popupNativeMenu: popup },
  });
  const stop = installNativeEditorMenu(editor);
  const event = {
    target: { position: null },
    event: {
      browserEvent: { clientX: 20, clientY: 30 },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    },
  } as unknown as monaco.editor.IEditorMouseEvent;
  listener?.(event);
  await vi.waitFor(() =>
    expect(trigger).toHaveBeenCalledWith(
      "native-menu",
      "editor.action.clipboardCopyAction",
      undefined,
    ),
  );
  expect(popup).toHaveBeenCalledWith(
    expect.objectContaining({
      x: 20,
      y: 30,
      items: expect.arrayContaining([{ kind: "item", id: "1", label: "Redo", enabled: false }]),
    }),
  );
  keyListener?.({
    browserEvent: { key: "ContextMenu" },
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as monaco.IKeyboardEvent);
  await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(2));
  expect(popup).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0 }));
  trigger.mockClear();
  popup.mockImplementation(async () => {
    readOnly = true;
    return { kind: "selected", id: "2" };
  });
  listener?.(event);
  await vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(3));
  expect(trigger).not.toHaveBeenCalled();
  stop();
  expect(dispose).toHaveBeenCalledOnce();
});
