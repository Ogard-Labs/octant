import type { StableHostId } from "@octant/contracts/remote-access";
import {
  TODO_MAX_TAGS,
  TODO_NOTES_MAX_CHARACTERS,
  TODO_TITLE_MAX_CHARACTERS,
  decodeTodoCommand,
  type Todo,
  type TodoCommand,
  type TodoProjectLink,
} from "@octant/contracts/todos";
import { Check, Ellipsis, Folder, Hash } from "../ui/icons";
import { useMemo, useRef, useState } from "react";
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { WorkListMenuTrigger } from "../surface/WorkList";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantInput } from "../ui/base/OctantInput";
import {
  OctantMenu,
  OctantMenuCheckboxItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRoot,
  OctantMenuSeparator,
} from "../ui/base/OctantMenu";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { TodoQuickAdd } from "./TodoQuickAdd";
import {
  DEFAULT_TODO_FILTER,
  NO_PROJECT,
  countTodos,
  filterTodos,
  isStarted,
  projectKey,
  tagsInList,
  todoProjectChoices,
  todoStateSentence,
  type TodoFilter,
  type TodoProjectChoice,
  type TodoProjectSource,
  type TodoStateFilter,
} from "./todoListModel";
import type { TodoChangeOutcome, TodoList } from "./useTodoList";

export interface TodosPageProps {
  readonly list: TodoList;
  /** This host's active Projects; an archived or deleted one reads "Project removed". */
  readonly projects: ReadonlyArray<TodoProjectSource>;
  readonly onClose: () => void;
}

const STATE_FILTERS: ReadonlyArray<{ readonly id: TodoStateFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "started", label: "Started" },
  { id: "done", label: "Done" },
];

function outcomeProblem(outcome: TodoChangeOutcome): string | undefined {
  if (outcome.status === "saved") return undefined;
  return outcome.status === "refused" ? outcome.refusal.message : outcome.message;
}

/** The To-dos destination: the person's own list on this host (docs/design/todos.md). */
export function TodosView(props: TodosPageProps) {
  const { read, change } = props.list;
  const view = read.status === "loading" ? undefined : read.view;
  const todos = useMemo(() => view?.todos ?? [], [view]);
  const choices = useMemo(
    () => todoProjectChoices(view?.hostId, props.projects),
    [view?.hostId, props.projects],
  );
  const [filter, setFilter] = useState<TodoFilter>(DEFAULT_TODO_FILTER);
  const [selected, setSelected] = useState<string>();
  const [deleting, setDeleting] = useState<Todo>();
  const [problem, setProblem] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const counts = countTodos(todos);
  const shown = filterTodos(todos, filter);
  const tags = tagsInList(todos);
  const stateCounts: Record<TodoStateFilter, number> = {
    all: todos.filter((todo) => todo.state !== "dropped").length,
    open: counts.open,
    started: counts.started,
    done: todos.filter((todo) => todo.state === "done").length,
  };

  async function send(command: TodoCommand): Promise<TodoChangeOutcome> {
    const outcome = await change(command);
    setProblem(outcomeProblem(outcome));
    return outcome;
  }

  /** Moves a to-do so it lands where `target` is, the way a drop or Move up/down asks. */
  function moveOnto(todoId: string, target: Todo) {
    const from = todos.findIndex((todo) => String(todo.id) === todoId);
    const to = todos.findIndex((todo) => todo.id === target.id);
    if (from === -1 || to === -1 || from === to) return;
    // Moving down puts it after the target, so before the one after the target.
    const before = from < to ? todos[to + 1] : target;
    void send(
      decodeTodoCommand({
        kind: "move-todo",
        todoId,
        ...(before === undefined ? {} : { beforeTodoId: before.id }),
      }),
    );
  }

  return (
    <Surface ariaLabel="To-dos" className="todos-page">
      <SurfaceHeader detail={todoStateSentence(counts)} onBack={props.onClose} title="To-dos" />
      <OctantCard className="todos-card">
        <TodoQuickAdd onChange={change} projects={choices} />
        <div className="todos-card__filters">
          <OctantToggleGroup<TodoStateFilter>
            aria-label="Show to-dos"
            className="inbox-card__filters"
            onValueChange={(value) => {
              const next = STATE_FILTERS.find((entry) => entry.id === value[0]);
              if (next !== undefined) setFilter({ ...filter, state: next.id });
            }}
            value={[filter.state]}
          >
            {STATE_FILTERS.map((entry) => (
              <OctantToggleGroupItem key={entry.id} value={entry.id}>
                {entry.label}
                <span className="oct-meta">{stateCounts[entry.id]}</span>
              </OctantToggleGroupItem>
            ))}
          </OctantToggleGroup>
          <span className="todos-card__pickers">
            <ProjectPicker choices={choices} filter={filter} onChange={setFilter} />
            {tags.length === 0 ? null : (
              <TagPicker filter={filter} onChange={setFilter} tags={tags} />
            )}
            <label className="todos-card__dropped oct-row-detail">
              <OctantCheckbox
                checked={filter.showDropped}
                onChange={(event) => setFilter({ ...filter, showDropped: event.target.checked })}
              />
              Show dropped
            </label>
          </span>
        </div>
        {problem === undefined ? null : (
          <OctantAlert className="todos-card__problem" tone="warning">
            {problem}
          </OctantAlert>
        )}
        {read.status === "failed" ? (
          <p className="oct-row-detail todos-card__note" role="status">
            {read.view === undefined
              ? read.message
              : `${read.message} The list below is the last one read.`}
          </p>
        ) : null}
        {read.status === "loading" ? (
          <p className="oct-row-detail todos-card__note" role="status">
            Reading your to-dos…
          </p>
        ) : view === undefined ? null : shown.length === 0 ? (
          <p className="oct-row-detail todos-card__note" role="status">
            {todos.length === 0
              ? "Write down what you mean to do; when you are ready, a to-do can be handed to an agent as a thread."
              : "No to-do matches these filters."}
          </p>
        ) : (
          <ul aria-label="To-dos" className="todo-list">
            {shown.map((todo, index) => (
              <TodoRow
                choices={choices}
                dragging={dragging}
                hostId={view.hostId}
                key={String(todo.id)}
                onDelete={() => setDeleting(todo)}
                onDragEnd={() => setDragging(undefined)}
                onDragStart={() => setDragging(String(todo.id))}
                onDrop={() => {
                  if (dragging !== undefined) moveOnto(dragging, todo);
                  setDragging(undefined);
                }}
                onMoveDown={
                  shown[index + 1] === undefined
                    ? undefined
                    : () => {
                        const next = shown[index + 1];
                        if (next !== undefined) moveOnto(String(todo.id), next);
                      }
                }
                onMoveUp={
                  shown[index - 1] === undefined
                    ? undefined
                    : () => {
                        const previous = shown[index - 1];
                        if (previous !== undefined) moveOnto(String(todo.id), previous);
                      }
                }
                onSelect={() =>
                  setSelected(selected === String(todo.id) ? undefined : String(todo.id))
                }
                onSend={send}
                projects={props.projects}
                selected={selected === String(todo.id)}
                todo={todo}
              />
            ))}
          </ul>
        )}
      </OctantCard>
      {deleting === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Delete"
          destructive
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const todo = deleting;
            setDeleting(undefined);
            if (selected === String(todo.id)) setSelected(undefined);
            void send(decodeTodoCommand({ kind: "delete-todo", todoId: todo.id }));
          }}
          title="Delete this to-do?"
        >
          “{deleting.title}” is removed from every device. Drop keeps it out of the list without
          deleting it.
        </OctantConfirmDialog>
      )}
    </Surface>
  );
}

function ProjectPicker(props: {
  readonly choices: ReadonlyArray<TodoProjectChoice>;
  readonly filter: TodoFilter;
  readonly onChange: (filter: TodoFilter) => void;
}) {
  const toggle = (key: string, on: boolean) => {
    const projects = new Set(props.filter.projects);
    if (on) projects.add(key);
    else projects.delete(key);
    props.onChange({ ...props.filter, projects });
  };
  const count = props.filter.projects.size;
  return (
    <OctantMenuRoot>
      <WorkListMenuTrigger
        active={count > 0}
        label={count === 0 ? "Filter by Project" : `Filter by Project, ${String(count)} chosen`}
        tooltip="Projects"
      >
        <Folder aria-hidden="true" size={16} />
      </WorkListMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
          <OctantMenuPopup aria-label="Filter by Project" className="min-w-[14rem]">
            {props.choices.map((choice) => {
              const key = projectKey(choice.link);
              return (
                <OctantMenuCheckboxItem
                  checked={props.filter.projects.has(key)}
                  closeOnClick={false}
                  key={key}
                  label={choice.link.name}
                  onCheckedChange={(on) => toggle(key, on)}
                >
                  {choice.link.name}
                </OctantMenuCheckboxItem>
              );
            })}
            {props.choices.length === 0 ? null : <OctantMenuSeparator />}
            <OctantMenuCheckboxItem
              checked={props.filter.projects.has(NO_PROJECT)}
              closeOnClick={false}
              label="No Project"
              onCheckedChange={(on) => toggle(NO_PROJECT, on)}
            >
              No Project
            </OctantMenuCheckboxItem>
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

function TagPicker(props: {
  readonly tags: ReadonlyArray<string>;
  readonly filter: TodoFilter;
  readonly onChange: (filter: TodoFilter) => void;
}) {
  const count = props.filter.tags.size;
  return (
    <OctantMenuRoot>
      <WorkListMenuTrigger
        active={count > 0}
        label={count === 0 ? "Filter by tag" : `Filter by tag, ${String(count)} chosen`}
        tooltip="Tags"
      >
        <Hash aria-hidden="true" size={16} />
      </WorkListMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
          <OctantMenuPopup aria-label="Filter by tag" className="min-w-[12rem]">
            {props.tags.map((tag) => (
              <OctantMenuCheckboxItem
                checked={props.filter.tags.has(tag)}
                closeOnClick={false}
                key={tag}
                label={tag}
                onCheckedChange={(on) => {
                  const tags = new Set(props.filter.tags);
                  if (on) tags.add(tag);
                  else tags.delete(tag);
                  props.onChange({ ...props.filter, tags });
                }}
              >
                {tag}
              </OctantMenuCheckboxItem>
            ))}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

interface TodoRowProps {
  readonly todo: Todo;
  readonly hostId: StableHostId;
  readonly choices: ReadonlyArray<TodoProjectChoice>;
  readonly projects: ReadonlyArray<TodoProjectSource>;
  readonly selected: boolean;
  readonly dragging: string | undefined;
  readonly onSelect: () => void;
  readonly onSend: (command: TodoCommand) => Promise<TodoChangeOutcome>;
  readonly onDelete: () => void;
  readonly onMoveUp: (() => void) | undefined;
  readonly onMoveDown: (() => void) | undefined;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onDrop: () => void;
}

/** A link to a Project on this host that is no longer active reads as removed. */
function projectLabel(
  link: TodoProjectLink,
  hostId: StableHostId,
  projects: ReadonlyArray<TodoProjectSource>,
): string {
  if (String(link.hostId) !== String(hostId)) return link.name;
  const project = projects.find((entry) => String(entry.id) === String(link.projectId));
  return project === undefined ? "Project removed" : project.name;
}

function TodoRow(props: TodoRowProps) {
  const { todo } = props;
  const [over, setOver] = useState(false);
  const done = todo.state === "done";
  const id = String(todo.id);
  const menuItems = [
    { label: "Edit", value: "edit" },
    ...(props.onMoveUp === undefined ? [] : [{ label: "Move up", value: "up" }]),
    ...(props.onMoveDown === undefined ? [] : [{ label: "Move down", value: "down" }]),
    todo.state === "dropped"
      ? { label: "Bring back", value: "restore" }
      : { label: "Drop", value: "drop" },
    { label: "Delete…", value: "delete" },
  ];
  return (
    <li
      className="todo-row"
      data-dragging={props.dragging === id ? "true" : undefined}
      data-drop-target={
        over && props.dragging !== undefined && props.dragging !== id ? "true" : undefined
      }
      data-selected={props.selected ? "true" : undefined}
      data-state={todo.state}
      draggable={!props.selected}
      onDragEnd={() => {
        setOver(false);
        props.onDragEnd();
      }}
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        if (props.dragging === undefined) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
        props.onDragStart();
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        props.onDrop();
      }}
    >
      <div className="todo-row__line">
        <OctantButton
          aria-checked={done}
          aria-label={todo.title}
          className="todo-row__check"
          onClick={() =>
            void props.onSend(
              decodeTodoCommand({
                kind: "set-todo-state",
                todoId: todo.id,
                state: done ? "open" : "done",
              }),
            )
          }
          role="checkbox"
          type="button"
          variant="bare"
        >
          {done ? <Check aria-hidden="true" size={12} /> : null}
        </OctantButton>
        <OctantButton
          aria-expanded={props.selected}
          className="todo-row__open"
          onClick={props.onSelect}
          type="button"
          variant="bare"
        >
          <span className="oct-row-label todo-row__title">{todo.title}</span>
          {todo.projects.length + todo.tags.length === 0 &&
          !isStarted(todo) &&
          todo.state !== "dropped" ? null : (
            <span className="todo-row__meta">
              {todo.state === "dropped" ? <span className="oct-meta">Dropped</span> : null}
              {isStarted(todo) ? <span className="oct-meta">Started</span> : null}
              {todo.projects.map((link) => (
                <span className="todo-chip" key={projectKey(link)}>
                  <Folder aria-hidden="true" size={12} />
                  {projectLabel(link, props.hostId, props.projects)}
                </span>
              ))}
              {todo.tags.map((tag) => (
                <span className="todo-chip" key={`tag:${tag}`}>
                  <Hash aria-hidden="true" size={12} />
                  {tag}
                </span>
              ))}
            </span>
          )}
        </OctantButton>
        <span className="todo-row__actions">
          <OctantMenu
            items={menuItems}
            onValueChange={(value) => {
              if (value === "edit") {
                if (!props.selected) props.onSelect();
              } else if (value === "up") props.onMoveUp?.();
              else if (value === "down") props.onMoveDown?.();
              else if (value === "delete") props.onDelete();
              else
                void props.onSend(
                  decodeTodoCommand({
                    kind: "set-todo-state",
                    todoId: todo.id,
                    state: value === "drop" ? "dropped" : "open",
                  }),
                );
            }}
            selectionMode="action"
            trigger={<Ellipsis aria-hidden="true" size={16} />}
            triggerClassName="shell-icon-button"
            triggerLabel={`Actions for ${todo.title}`}
            value=""
          />
        </span>
      </div>
      {props.selected ? (
        <TodoEditor
          choices={props.choices}
          hostId={props.hostId}
          onClose={props.onSelect}
          onSend={props.onSend}
          projects={props.projects}
          todo={todo}
        />
      ) : null}
    </li>
  );
}

function tagsFromText(text: string): ReadonlyArray<string> {
  const tags: string[] = [];
  for (const part of text.split(",")) {
    const tag = part.trim().replace(/^#/, "");
    if (tag !== "" && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function sameStrings(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The to-do opened in place. Title and notes are saved against the version
 * they were opened on; when another device changed them first, the host
 * refuses, the row shows the saved text, and the person's own text stays in
 * the fields to save again.
 */
function TodoEditor(props: {
  readonly todo: Todo;
  readonly hostId: StableHostId;
  readonly choices: ReadonlyArray<TodoProjectChoice>;
  readonly projects: ReadonlyArray<TodoProjectSource>;
  readonly onSend: (command: TodoCommand) => Promise<TodoChangeOutcome>;
  readonly onClose: () => void;
}) {
  const { todo } = props;
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [tagText, setTagText] = useState(todo.tags.join(", "));
  const [projectKeys, setProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(todo.projects.map(projectKey)),
  );
  // The version the text was opened on. After a refusal the person has seen
  // the other device's text, so saving again is made on the version now shown.
  const openedOn = useRef(todo.version);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  // A link to a Project this window does not list (another host's, or one
  // since removed) stays as it was: the editor offers only this host's Projects.
  // Another host's Project links stay as they are: this window lists only
  // this host's Projects. A link to one of this host's Projects that is no
  // longer active is offered too, so the person can remove it.
  const onThisHost = (link: TodoProjectLink) => String(link.hostId) === String(props.hostId);
  const editable: ReadonlyArray<TodoProjectChoice> = [
    ...props.choices,
    ...todo.projects
      .filter(
        (link) =>
          onThisHost(link) &&
          !props.choices.some((choice) => projectKey(choice.link) === projectKey(link)),
      )
      .map((link) => ({ link })),
  ];
  // The links in their saved order, then any newly ticked, so saving only a
  // title does not reorder them.
  const chosen = [
    ...todo.projects.filter((link) => !onThisHost(link) || projectKeys.has(projectKey(link))),
    ...props.choices
      .filter(
        (choice) =>
          projectKeys.has(projectKey(choice.link)) &&
          !todo.projects.some((link) => projectKey(link) === projectKey(choice.link)),
      )
      .map((choice) => choice.link),
  ];

  async function save() {
    const trimmedTitle = title.trim();
    if (trimmedTitle === "" || /[\r\n]/.test(trimmedTitle)) {
      setProblem("A to-do needs a one-line title.");
      return;
    }
    const tags = tagsFromText(tagText);
    if (tags.length > TODO_MAX_TAGS) {
      setProblem(`A to-do has at most ${String(TODO_MAX_TAGS)} tags.`);
      return;
    }
    const commands: TodoCommand[] = [];
    try {
      if (trimmedTitle !== todo.title || notes !== todo.notes) {
        commands.push(
          decodeTodoCommand({
            kind: "edit-todo",
            todoId: todo.id,
            expectedVersion: conflict ? todo.version : openedOn.current,
            title: trimmedTitle,
            notes,
          }),
        );
      }
      // Tags are sent only when the person edited the field: a tag may hold a
      // comma or start with #, which the comma-separated field cannot carry back.
      if (tagText !== todo.tags.join(", ") && !sameStrings(tags, todo.tags)) {
        commands.push(decodeTodoCommand({ kind: "set-todo-tags", todoId: todo.id, tags }));
      }
      if (!sameStrings(chosen.map(projectKey), todo.projects.map(projectKey))) {
        commands.push(
          decodeTodoCommand({ kind: "set-todo-projects", todoId: todo.id, projects: chosen }),
        );
      }
    } catch {
      setProblem("Those changes cannot be saved as written.");
      return;
    }
    setBusy(true);
    for (const command of commands) {
      const outcome = await props.onSend(command);
      if (outcome.status === "refused" && outcome.refusal.reason === "changed-elsewhere") {
        setConflict(true);
        setBusy(false);
        return;
      }
      if (outcome.status !== "saved") {
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    props.onClose();
  }

  return (
    <form
      aria-label={`Edit ${todo.title}`}
      className="todo-editor"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {conflict ? (
        <OctantAlert tone="warning">
          Another device changed this to-do. It now reads “{todo.title}”
          {todo.notes === "" ? ", with no notes" : `, with the notes “${todo.notes}”`}. Your text is
          still below; save to replace it.
        </OctantAlert>
      ) : null}
      <label className="todo-editor__field">
        <span className="oct-row-detail">Title</span>
        <OctantInput
          maxLength={TODO_TITLE_MAX_CHARACTERS}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </label>
      <label className="todo-editor__field">
        <span className="oct-row-detail">Notes</span>
        <OctantTextarea
          maxLength={TODO_NOTES_MAX_CHARACTERS}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          value={notes}
        />
      </label>
      <label className="todo-editor__field">
        <span className="oct-row-detail">Tags, separated by commas</span>
        <OctantInput onChange={(event) => setTagText(event.target.value)} value={tagText} />
      </label>
      {editable.length === 0 ? null : (
        <fieldset className="todo-editor__projects">
          <legend className="oct-row-detail">Projects</legend>
          {editable.map((choice) => {
            const key = projectKey(choice.link);
            return (
              <label className="todo-editor__project" key={key}>
                <OctantCheckbox
                  checked={projectKeys.has(key)}
                  onChange={(event) => {
                    const next = new Set(projectKeys);
                    if (event.target.checked) next.add(key);
                    else next.delete(key);
                    setProjectKeys(next);
                  }}
                />
                {projectLabel(choice.link, props.hostId, props.projects)}
              </label>
            );
          })}
        </fieldset>
      )}
      {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
      <div className="todo-editor__actions">
        <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
          Cancel
        </OctantButton>
        <OctantButton disabled={busy} size="sm" type="submit">
          Save
        </OctantButton>
      </div>
    </form>
  );
}
