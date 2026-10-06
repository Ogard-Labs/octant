import type * as monaco from "monaco-editor";
import type { NativeMenuEntry } from "@octant/contracts/shell";

/** Keep editor commands in the renderer; the host presents only their labels. */
export function installNativeEditorMenu(editor: monaco.editor.IStandaloneCodeEditor): () => void {
  const popup = window.octantHost?.popupNativeMenu;
  if (popup === undefined) return () => undefined;
  editor.updateOptions({ contextmenu: false });
  let disposed = false;
  const present = (x: number, y: number, position: monaco.IPosition | null) => {
    if (position !== null && !editor.getSelection()?.containsPosition(position))
      editor.setPosition(position);
    editor.focus();
    const readOnly = editor.getRawOptions().readOnly === true;
    const model = editor.getModel();
    const commands = [
      { command: "undo", label: "Undo", enabled: !readOnly && model?.canUndo() === true },
      { command: "redo", label: "Redo", enabled: !readOnly && model?.canRedo() === true },
      { command: "editor.action.clipboardCutAction", label: "Cut", enabled: !readOnly },
      { command: "editor.action.clipboardCopyAction", label: "Copy", enabled: true },
      { command: "editor.action.clipboardPasteAction", label: "Paste", enabled: !readOnly },
      { command: "editor.action.selectAll", label: "Select All", enabled: true },
      { command: "actions.find", label: "Find", enabled: true },
      { command: "editor.action.startFindReplaceAction", label: "Replace", enabled: !readOnly },
      ...["editor.action.formatDocument", "editor.action.rename"].flatMap((id) => {
        const action = editor.getAction(id);
        return action === null || !action.isSupported()
          ? []
          : [{ command: id, label: action.label, enabled: !readOnly }];
      }),
    ];
    const items: NativeMenuEntry[] = commands.flatMap((command, index) => [
      ...(index === 2 || index === 5 || index === 6 ? [{ kind: "separator" } as const] : []),
      { kind: "item", id: String(index), label: command.label, enabled: command.enabled },
    ]);
    void popup({
      x,
      y,
      items,
    }).then((outcome) => {
      if (disposed || outcome.kind !== "selected") return;
      const command = commands.find((_, index) => String(index) === outcome.id);
      if (command === undefined || !command.enabled) return;
      editor.focus();
      // Read-only may have changed while the native menu was tracking.
      if (
        editor.getRawOptions().readOnly === true &&
        !["editor.action.clipboardCopyAction", "editor.action.selectAll", "actions.find"].includes(
          command.command,
        )
      )
        return;
      editor.trigger("native-menu", command.command, undefined);
    });
  };
  const subscription = editor.onContextMenu((event) => {
    event.event.preventDefault();
    event.event.stopPropagation();
    present(
      event.event.browserEvent.clientX,
      event.event.browserEvent.clientY,
      event.target.position,
    );
  });
  const keyboard = editor.onKeyDown((event) => {
    if (
      event.browserEvent.key !== "ContextMenu" &&
      !(event.browserEvent.key === "F10" && event.shiftKey)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = editor.getDomNode()?.getBoundingClientRect();
    const position = editor.getPosition();
    const caret = position === null ? null : editor.getScrolledVisiblePosition(position);
    present(
      (bounds?.left ?? 0) + (caret?.left ?? 0),
      (bounds?.top ?? 0) + (caret?.top ?? 0) + (caret?.height ?? 0),
      position,
    );
  });
  return () => {
    disposed = true;
    subscription.dispose();
    keyboard.dispose();
  };
}
