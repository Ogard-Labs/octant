import {
  TODO_TITLE_MAX_CHARACTERS,
  decodeTodoCommand,
  decodeTodoId,
  type TodoCommand,
} from "@octant/contracts/todos";
import { Folder, Hash, X } from "../ui/icons";
import { useId, useState, type RefObject } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import type { TodoChangeOutcome } from "./useTodoList";
import {
  parseQuickAdd,
  projectKey,
  withoutQuickAddWord,
  type TodoProjectChoice,
} from "./todoListModel";

export interface TodoQuickAddProps {
  readonly projects: ReadonlyArray<TodoProjectChoice>;
  readonly onChange: (command: TodoCommand) => Promise<TodoChangeOutcome>;
  /** Called once a to-do was added, for a dialog that closes then. */
  readonly onAdded?: () => void;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  readonly autoFocus?: boolean;
}

/**
 * One line that adds a to-do on top. `#word` adds a tag and `@name` picks a
 * Project; both show as chips before the to-do is added, and removing a chip
 * removes its word from the line.
 */
export function TodoQuickAdd(props: TodoQuickAddProps) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const problemId = useId();
  // One id per draft, kept across failed sends: when the host saved the add
  // but its answer was lost, sending again names the same to-do and adds it
  // once. A new id is drawn only after a confirmed save.
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const draft = parseQuickAdd(text, props.projects);

  async function add() {
    if (busy || draft.title === "") return;
    if (draft.title.length > TODO_TITLE_MAX_CHARACTERS) {
      setProblem(`A to-do title is at most ${String(TODO_TITLE_MAX_CHARACTERS)} characters.`);
      return;
    }
    let command: TodoCommand;
    try {
      command = decodeTodoCommand({
        kind: "add-todo",
        todoId: decodeTodoId(draftId),
        title: draft.title,
        tags: draft.tags,
        projects: draft.projects,
      });
    } catch {
      setProblem("That to-do cannot be added as written.");
      return;
    }
    setBusy(true);
    const outcome = await props.onChange(command);
    setBusy(false);
    if (outcome.status === "saved") {
      setText("");
      setDraftId(crypto.randomUUID());
      setProblem(undefined);
      props.onAdded?.();
      return;
    }
    setProblem(outcome.status === "refused" ? outcome.refusal.message : outcome.message);
  }

  const chips = draft.tags.length + draft.projects.length;
  return (
    <div className="todo-quick-add">
      <OctantInput
        aria-describedby={problem === undefined ? undefined : problemId}
        aria-label="New to-do"
        autoFocus={props.autoFocus === true}
        className="todo-quick-add__input"
        // Read-only, not disabled, while saving: disabling the field blurred it,
        // and the next to-do needed a click before it could be typed.
        readOnly={busy}
        onChange={(event) => {
          setText(event.target.value);
          setProblem(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void add();
        }}
        placeholder="Add a to-do — #tag, @Project"
        {...(props.inputRef === undefined ? {} : { ref: props.inputRef })}
        value={text}
      />
      {chips === 0 ? null : (
        <ul aria-label="Added with this to-do" className="todo-chips">
          {draft.projects.map((link) => (
            <li className="todo-chip" key={projectKey(link)}>
              <Folder aria-hidden="true" size={12} />
              <span>{link.name}</span>
              <OctantButton
                aria-label={`Remove ${link.name}`}
                className="todo-chip__remove"
                onClick={() =>
                  setText(withoutQuickAddWord(text, { project: link }, props.projects))
                }
                type="button"
                variant="bare"
              >
                <X aria-hidden="true" size={12} />
              </OctantButton>
            </li>
          ))}
          {draft.tags.map((tag) => (
            <li className="todo-chip" key={`tag:${tag}`}>
              <Hash aria-hidden="true" size={12} />
              <span>{tag}</span>
              <OctantButton
                aria-label={`Remove tag ${tag}`}
                className="todo-chip__remove"
                onClick={() => setText(withoutQuickAddWord(text, { tag }, props.projects))}
                type="button"
                variant="bare"
              >
                <X aria-hidden="true" size={12} />
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
      {problem === undefined ? null : (
        <OctantAlert className="todo-quick-add__problem" id={problemId} tone="warning">
          {problem}
        </OctantAlert>
      )}
    </div>
  );
}
