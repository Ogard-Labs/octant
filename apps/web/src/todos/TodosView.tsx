import type { StableHostId } from "@octant/contracts/remote-access";
import {
  TODO_MAX_TAGS,
  TODO_NOTES_MAX_CHARACTERS,
  TODO_TITLE_MAX_CHARACTERS,
  decodeTodoCommand,
  type Todo,
  type TodoCommand,
  type TodoProjectLink,
  type TodoThreadLink,
} from "@octant/contracts/todos";
import type { OctantMode } from "@octant/contracts";
import { Check, Ellipsis, Folder, Hash, SquareCheck } from "../ui/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { FilterMenu } from "../surface/FilterMenu";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { OctantInput } from "../ui/base/OctantInput";
import {
  OctantMenu,
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuSeparator,
} from "../ui/base/OctantMenu";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { TodoQuickAdd } from "./TodoQuickAdd";
import {
  newestTodoThread,
  todoThreadKey,
  type TodoStartTarget,
  type TodoThreadState,
} from "./todoThreadModel";
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

/** A thread started from a to-do whose link the list host has not recorded. */
export interface TodoUnlinkedStart {
  readonly threadId: string;
  readonly mode: OctantMode;
}

/** Start and the thread state on each row; absent where this window cannot start threads. */
export interface TodoStartProps {
  readonly threadStates: ReadonlyMap<string, TodoThreadState>;
  readonly onStart: (todo: Todo, target: TodoStartTarget) => void;
  readonly onOpenThread: (link: TodoThreadLink, title: string) => void;
  /** By to-do id. */
  readonly unlinked: ReadonlyMap<string, TodoUnlinkedStart>;
  readonly onLink: (todoId: string) => void;
}

export interface TodosPageProps {
  readonly list: TodoList;
  /** This host's active Projects; an archived or deleted one reads "Project removed". */
  readonly projects: ReadonlyArray<TodoProjectSource>;
  readonly onClose: () => void;
  readonly start?: TodoStartProps;
  /** This host's own id, which names its Projects and threads; defaults to the list's host. */
  readonly thisHostId?: StableHostId;
  /**
   * The list host cannot be reached: the last list read shows, nothing is
   * sent, and quick add keeps drafts on this device until the person sends.
   */
  readonly readOnly?: boolean;
  /** Names the list host; unsent drafts are kept per list host, never shared. */
  readonly listKey?: string;
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
  const localHostId = props.thisHostId ?? view?.hostId;
  const readOnly = props.readOnly === true;
  const draftsKey = props.listKey ?? "this-host";
  const [unsent, setUnsent] = useState<ReadonlyArray<UnsentTodo>>(() => readUnsentTodos(draftsKey));
  const [unsentKey, setUnsentKey] = useState(draftsKey);
  if (unsentKey !== draftsKey) {
    // A draft belongs to the list host it was written for: after the list
    // moves, another host's drafts are neither shown nor sendable here.
    setUnsentKey(draftsKey);
    setUnsent(readUnsentTodos(draftsKey));
  }
  // Every write starts from what storage holds now, not from this window's
  // copy: two windows holding drafts for one list must not erase each other's.
  const holdUnsent = (draft: UnsentTodo) => {
    const stored = readUnsentTodos(draftsKey);
    const next = stored.some((held) => String(held.command.todoId) === String(draft.command.todoId))
      ? stored
      : [...stored, draft];
    writeUnsentTodos(draftsKey, next);
    setUnsent(next);
  };
  const dropUnsent = (todoId: string) => {
    const next = readUnsentTodos(draftsKey).filter(
      (held) => String(held.command.todoId) !== todoId,
    );
    writeUnsentTodos(draftsKey, next);
    setUnsent(next);
  };
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === null || event.key === unsentStorageKey(draftsKey)) {
        setUnsent(readUnsentTodos(draftsKey));
      }
    };
    globalThis.addEventListener("storage", follow);
    return () => globalThis.removeEventListener("storage", follow);
  }, [draftsKey]);
  const choices = useMemo(
    () => todoProjectChoices(localHostId, props.projects),
    [localHostId, props.projects],
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

  // A list that holds nothing has nothing to switch or filter and no state to
  // sum up: its toolbar and header sentence stay away and the empty state
  // speaks. That holds for the last list read before a failure too, and while
  // the first read is still out, so no toolbar shows only to leave again.
  const pageIsEmpty = view !== undefined && todos.length === 0;
  const hasTodos = view !== undefined && todos.length > 0;
  const stateSentence = hasTodos ? todoStateSentence(counts) : undefined;
  // State is the visible switch, so only the menu's own choices count.
  const filterCount = filter.projects.size + filter.tags.size + (filter.showDropped ? 1 : 0);
  const resetFilters = () =>
    setFilter({ ...filter, showDropped: false, projects: new Set(), tags: new Set() });
  const toggleProject = (key: string, on: boolean) => {
    const projects = new Set(filter.projects);
    if (on) projects.add(key);
    else projects.delete(key);
    setFilter({ ...filter, projects });
  };

  return (
    <Surface ariaLabel="To-dos" className="todos-page">
      <SurfaceHeader
        onBack={props.onClose}
        title="To-dos"
        {...(stateSentence === undefined ? {} : { detail: stateSentence })}
      />
      <>
        <TodoQuickAdd
          onChange={async (command) => {
            if (!readOnly) return change(command);
            // Never sent on its own: a mutation names one destination and is
            // not queued as offline work. The person sends it when the list
            // host is back.
            if (command.kind === "add-todo") {
              holdUnsent({ command, title: command.title });
            }
            return { status: "saved" };
          }}
          projects={choices}
        />
        {unsent.length === 0 ? null : (
          <section aria-label="Not sent" className="todo-unsent">
            <h3 className="oct-section-label">Not sent</h3>
            <ul className="todo-unsent__list">
              {unsent.map((draft) => (
                <li className="todo-unsent__row" key={String(draft.command.todoId)}>
                  <span className="oct-row-label">{draft.title}</span>
                  <OctantButton
                    aria-label={`Send ${draft.title}`}
                    disabled={readOnly}
                    onClick={async () => {
                      const outcome = await send(draft.command);
                      if (outcome.status === "saved") dropUnsent(String(draft.command.todoId));
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Send
                  </OctantButton>
                  <OctantButton
                    aria-label={`Discard ${draft.title}`}
                    onClick={() => dropUnsent(String(draft.command.todoId))}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Discard
                  </OctantButton>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!hasTodos ? null : (
          <div aria-label="To-do controls" className="surface-toolbar todos-toolbar" role="group">
            <OctantToggleGroup<TodoStateFilter>
              aria-label="Show to-dos"
              onValueChange={(value) => {
                const next = STATE_FILTERS.find((entry) => entry.id === value[0]);
                if (next !== undefined) setFilter({ ...filter, state: next.id });
              }}
              value={[filter.state]}
            >
              {STATE_FILTERS.map((entry) => (
                <OctantToggleGroupItem
                  aria-label={`${entry.label}, ${String(stateCounts[entry.id])}`}
                  key={entry.id}
                  value={entry.id}
                >
                  {entry.label}
                  {/* A zero says nothing the empty switch does not; the name still carries it. */}
                  {stateCounts[entry.id] === 0 ? null : (
                    <span className="oct-meta todos-toolbar__count">{stateCounts[entry.id]}</span>
                  )}
                </OctantToggleGroupItem>
              ))}
            </OctantToggleGroup>
            <FilterMenu count={filterCount} onReset={resetFilters}>
              <OctantMenuGroup>
                <OctantMenuGroupLabel>Project</OctantMenuGroupLabel>
                {choices.map((choice) => {
                  const key = projectKey(choice.link);
                  return (
                    <OctantMenuCheckboxItem
                      checked={filter.projects.has(key)}
                      closeOnClick={false}
                      key={key}
                      label={choice.link.name}
                      onCheckedChange={(on) => toggleProject(key, on)}
                    >
                      {choice.link.name}
                    </OctantMenuCheckboxItem>
                  );
                })}
                <OctantMenuCheckboxItem
                  checked={filter.projects.has(NO_PROJECT)}
                  closeOnClick={false}
                  label="No Project"
                  onCheckedChange={(on) => toggleProject(NO_PROJECT, on)}
                >
                  No Project
                </OctantMenuCheckboxItem>
              </OctantMenuGroup>
              {tags.length === 0 ? null : (
                <>
                  <OctantMenuSeparator />
                  <OctantMenuGroup>
                    <OctantMenuGroupLabel>Tag</OctantMenuGroupLabel>
                    {tags.map((tag) => (
                      <OctantMenuCheckboxItem
                        checked={filter.tags.has(tag)}
                        closeOnClick={false}
                        key={tag}
                        label={tag}
                        onCheckedChange={(on) => {
                          const next = new Set(filter.tags);
                          if (on) next.add(tag);
                          else next.delete(tag);
                          setFilter({ ...filter, tags: next });
                        }}
                      >
                        {tag}
                      </OctantMenuCheckboxItem>
                    ))}
                  </OctantMenuGroup>
                </>
              )}
              <OctantMenuSeparator />
              <OctantMenuCheckboxItem
                checked={filter.showDropped}
                closeOnClick={false}
                label="Show dropped"
                onCheckedChange={(on) => setFilter({ ...filter, showDropped: on })}
              >
                Show dropped
              </OctantMenuCheckboxItem>
            </FilterMenu>
          </div>
        )}
        {problem === undefined ? null : (
          <OctantAlert className="todos-page__problem" tone="warning">
            {problem}
          </OctantAlert>
        )}
        {read.status === "failed" ? (
          <p className="oct-row-detail todos-page__note" role="status">
            {hasTodos ? `${read.message} The list below is the last one read.` : read.message}
          </p>
        ) : null}
        {read.status === "loading" ? (
          <p className="oct-row-detail todos-page__note" role="status">
            Reading your to-dos…
          </p>
        ) : view === undefined ? null : pageIsEmpty ? (
          <OctantEmpty
            detail="Write down what you mean to do. A to-do can be handed to an agent as a thread when you are ready."
            icon={<SquareCheck size={20} />}
            layout="line"
            title="No to-dos yet"
          />
        ) : shown.length === 0 ? (
          <p className="oct-row-detail todos-page__note" role="status">
            No to-do matches these filters.
          </p>
        ) : (
          <ul aria-label="To-dos" className="todo-list">
            {shown.map((todo, index) => (
              <TodoRow
                choices={choices}
                dragging={dragging}
                hostId={localHostId ?? view.hostId}
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
                readOnly={readOnly}
                {...(props.start === undefined ? {} : { start: props.start })}
                projects={props.projects}
                selected={selected === String(todo.id)}
                todo={todo}
              />
            ))}
          </ul>
        )}
      </>
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
  readonly start?: TodoStartProps;
  readonly readOnly: boolean;
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
      draggable={!props.selected && !props.readOnly}
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
          disabled={props.readOnly}
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
          disabled={props.readOnly}
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
              {isStarted(todo) && props.start === undefined ? (
                <span className="oct-meta">Started</span>
              ) : null}
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
        {props.readOnly ? null : (
          <span className="todo-row__actions">
            {props.start === undefined || todo.state !== "open" ? null : (
              <TodoStartControl
                hostId={props.hostId}
                onStart={(target) => props.start?.onStart(todo, target)}
                projects={props.projects}
                todo={todo}
              />
            )}
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
        )}
      </div>
      {props.start === undefined || props.readOnly ? null : (
        <TodoThreadLine onSend={props.onSend} start={props.start} todo={todo} />
      )}
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

/**
 * Start opens the ordinary new-thread draft; nothing starts until the person
 * sends. With one of this host's Projects it goes there; with several the
 * person picks one; with none, Chat or any Project.
 */
function TodoStartControl(props: {
  readonly todo: Todo;
  readonly hostId: StableHostId;
  readonly projects: ReadonlyArray<TodoProjectSource>;
  readonly onStart: (target: TodoStartTarget) => void;
}) {
  const linked = props.projects.filter((project) =>
    props.todo.projects.some(
      (link) =>
        String(link.hostId) === String(props.hostId) &&
        String(link.projectId) === String(project.id),
    ),
  );
  const targets: ReadonlyArray<TodoStartTarget> =
    linked.length > 0
      ? linked.map((project) => ({
          kind: "project",
          projectId: String(project.id),
          name: project.name,
        }))
      : [
          { kind: "chat" },
          ...props.projects.map(
            (project): TodoStartTarget => ({
              kind: "project",
              projectId: String(project.id),
              name: project.name,
            }),
          ),
        ];
  const only = targets.length === 1 ? targets[0] : undefined;
  if (only !== undefined) {
    return (
      <OctantButton
        aria-label={`Start ${props.todo.title}`}
        onClick={() => props.onStart(only)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Start
      </OctantButton>
    );
  }
  const valueOf = (target: TodoStartTarget) =>
    target.kind === "chat" ? "chat" : `project:${target.projectId}`;
  return (
    <OctantMenu
      items={targets.map((target) => ({
        label: target.kind === "chat" ? "Chat" : target.name,
        value: valueOf(target),
      }))}
      onValueChange={(value) => {
        const target = targets.find((entry) => valueOf(entry) === value);
        if (target !== undefined) props.onStart(target);
      }}
      selectionMode="action"
      trigger={<span>Start</span>}
      triggerClassName={octantButtonClassName({ variant: "ghost", size: "sm" })}
      triggerLabel={`Start ${props.todo.title}`}
      value=""
    />
  );
}

/**
 * The newest thread started from the to-do, as the window's own rows show it.
 * A thread the list host did not record says so, with Link to try again; the
 * thread itself is unaffected.
 */
function TodoThreadLine(props: {
  readonly todo: Todo;
  readonly start: TodoStartProps;
  readonly onSend: (command: TodoCommand) => Promise<TodoChangeOutcome>;
}) {
  const { todo, start } = props;
  const unlinked = start.unlinked.get(String(todo.id));
  const link = newestTodoThread(todo);
  const state = link === undefined ? undefined : start.threadStates.get(todoThreadKey(link));
  if (unlinked === undefined && link === undefined) return null;
  return (
    <div className="todo-row__thread">
      {link === undefined ? null : state === undefined ? (
        <span className="oct-meta">Started</span>
      ) : (
        <OctantButton
          aria-label={`${state.label}: open ${state.title}`}
          className="todo-thread"
          data-phase={state.phase}
          onClick={() => start.onOpenThread(link, state.title)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {state.label}
          <span className="oct-meta todo-thread__title">{state.title}</span>
        </OctantButton>
      )}
      {state?.phase === "done" && todo.state === "open" ? (
        <OctantButton
          onClick={() =>
            void props.onSend(
              decodeTodoCommand({ kind: "set-todo-state", todoId: todo.id, state: "done" }),
            )
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          Tick off
        </OctantButton>
      ) : null}
      {unlinked === undefined ? null : (
        <span className="todo-row__unlinked">
          <span className="oct-row-detail">Thread started, not linked</span>
          <OctantButton
            onClick={() => start.onLink(String(todo.id))}
            size="sm"
            type="button"
            variant="ghost"
          >
            Link
          </OctantButton>
        </span>
      )}
    </div>
  );
}

/** A quick add held on this device while the list host could not be reached. */
interface UnsentTodo {
  readonly command: Extract<TodoCommand, { kind: "add-todo" }>;
  readonly title: string;
}

function unsentStorageKey(listKey: string): string {
  return `octant.todos.unsent.v1:${listKey}`;
}

/** Unsent drafts live in this browser's storage only; it may be absent or refuse. */
function readUnsentTodos(listKey: string): ReadonlyArray<UnsentTodo> {
  try {
    const stored = globalThis.localStorage.getItem(unsentStorageKey(listKey));
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      try {
        const command = decodeTodoCommand(
          typeof entry === "object" && entry !== null && "command" in entry
            ? entry.command
            : undefined,
        );
        return command.kind === "add-todo" ? [{ command, title: command.title }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function writeUnsentTodos(listKey: string, unsent: ReadonlyArray<UnsentTodo>): void {
  try {
    if (unsent.length === 0) globalThis.localStorage.removeItem(unsentStorageKey(listKey));
    else globalThis.localStorage.setItem(unsentStorageKey(listKey), JSON.stringify(unsent));
  } catch {
    // Storage refused: the drafts stay for this page's life.
  }
}
