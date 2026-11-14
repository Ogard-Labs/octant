import { matchKeybinding } from "@octant/domain";
import { useEffect, useMemo, useRef } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";
import { OctantDialog } from "../ui/base/OctantDialog";
import { TodoQuickAdd } from "./TodoQuickAdd";
import { todoProjectChoices, type TodoProjectSource } from "./todoListModel";
import type { TodoList } from "./useTodoList";

/**
 * New to-do over whatever page is in front: the same quick add line as the
 * To-dos page, closed once the to-do is on the list.
 */
export function TodoQuickAddDialog(props: {
  readonly open: boolean;
  readonly list: TodoList;
  readonly projects: ReadonlyArray<TodoProjectSource>;
  readonly onClose: () => void;
}) {
  const hostId = props.list.read.status === "loading" ? undefined : props.list.read.view?.hostId;
  const choices = useMemo(
    () => todoProjectChoices(hostId, props.projects),
    [hostId, props.projects],
  );
  const input = useRef<HTMLInputElement>(null);
  return (
    <OctantDialog
      className="todo-quick-add-dialog"
      initialFocus={input}
      label="New to-do"
      onClose={props.onClose}
      open={props.open}
    >
      <TodoQuickAdd
        inputRef={input}
        onAdded={props.onClose}
        onChange={props.list.change}
        projects={choices}
      />
    </OctantDialog>
  );
}

/**
 * Runs `onNew` on the new-to-do chord (Mod+Shift+L by default). It answers in
 * a text field too: the chord types nothing there.
 */
export function useNewTodoShortcut(onNew: () => void): void {
  const { keybindings } = useKeybindings();
  const latest = useRef(onNew);
  latest.current = onNew;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "new-todo") return;
      event.preventDefault();
      latest.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}
