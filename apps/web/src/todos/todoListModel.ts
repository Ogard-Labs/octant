import type { ProjectId } from "@octant/contracts";
import type { StableHostId } from "@octant/contracts/remote-access";
import {
  TODO_MAX_PROJECTS,
  TODO_PROJECT_NAME_MAX_CHARACTERS,
  TODO_MAX_TAGS,
  TODO_TAG_MAX_CHARACTERS,
  type Todo,
  type TodoProjectLink,
} from "@octant/contracts/todos";

/** A Project the person can attach to a to-do from this window. */
export interface TodoProjectChoice {
  readonly link: TodoProjectLink;
}

/** A Project on this host the person can attach a to-do to. */
export interface TodoProjectSource {
  readonly id: ProjectId;
  readonly name: string;
}

/** Links this host's Projects by the list host's id, which the list itself reports. */
export function todoProjectChoices(
  hostId: StableHostId | undefined,
  projects: ReadonlyArray<TodoProjectSource>,
): ReadonlyArray<TodoProjectChoice> {
  if (hostId === undefined) return [];
  return projects.flatMap((project) => {
    // A link carries a trimmed name within its bound, as the host checks.
    const name = project.name.trim().slice(0, TODO_PROJECT_NAME_MAX_CHARACTERS).trim();
    return name === "" ? [] : [{ link: { hostId, projectId: project.id, name } }];
  });
}

export function projectKey(link: Pick<TodoProjectLink, "hostId" | "projectId">): string {
  return `${String(link.hostId)}:${String(link.projectId)}`;
}

/** What quick add will save: the title with its `#tag` and `@project` words lifted out. */
export interface QuickAddDraft {
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<TodoProjectLink>;
}

function compact(name: string): string {
  return name.toLocaleLowerCase().replace(/\s+/g, "");
}

/**
 * `@name` picks the Project whose name, without spaces and ignoring case, is
 * the word, or the only one that starts with it. A word that names no Project,
 * or names several, stays in the title: the person typed it, and dropping it
 * silently would lose text.
 */
function projectFor(
  word: string,
  projects: ReadonlyArray<TodoProjectChoice>,
): TodoProjectLink | undefined {
  const wanted = compact(word);
  const exact = projects.filter((choice) => compact(choice.link.name) === wanted);
  if (exact.length === 1) return exact[0]?.link;
  if (exact.length > 1) return undefined;
  const starting = projects.filter((choice) => compact(choice.link.name).startsWith(wanted));
  return starting.length === 1 ? starting[0]?.link : undefined;
}

export function parseQuickAdd(
  text: string,
  projects: ReadonlyArray<TodoProjectChoice>,
): QuickAddDraft {
  const tags: string[] = [];
  const links: TodoProjectLink[] = [];
  const kept: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    const tag = /^#(.+)$/.exec(word)?.[1];
    if (tag !== undefined && tag.length <= TODO_TAG_MAX_CHARACTERS && tags.length < TODO_MAX_TAGS) {
      if (!tags.includes(tag)) tags.push(tag);
      continue;
    }
    const name = /^@(.+)$/.exec(word)?.[1];
    const link = name === undefined ? undefined : projectFor(name, projects);
    if (link !== undefined && links.length < TODO_MAX_PROJECTS) {
      if (!links.some((existing) => projectKey(existing) === projectKey(link))) links.push(link);
      continue;
    }
    kept.push(word);
  }
  return { title: kept.join(" "), tags, projects: links };
}

/** Removes one `#tag` or `@project` word from quick add's text, as its chip's remove button does. */
export function withoutQuickAddWord(
  text: string,
  remove: { readonly tag: string } | { readonly project: TodoProjectLink },
  projects: ReadonlyArray<TodoProjectChoice>,
): string {
  return text
    .split(/(\s+)/)
    .filter((part) => {
      if ("tag" in remove) return part !== `#${remove.tag}`;
      const name = /^@(.+)$/.exec(part)?.[1];
      const link = name === undefined ? undefined : projectFor(name, projects);
      return link === undefined || projectKey(link) !== projectKey(remove.project);
    })
    .join("")
    .replace(/\s{2,}/g, " ");
}

export type TodoStateFilter = "all" | "open" | "started" | "done";

export interface TodoFilter {
  readonly state: TodoStateFilter;
  readonly showDropped: boolean;
  /** Project keys; `none` keeps to-dos with no Project. Empty keeps every to-do. */
  readonly projects: ReadonlySet<string>;
  /** Exact tags. Empty keeps every to-do. */
  readonly tags: ReadonlySet<string>;
}

export const NO_PROJECT = "none";

export const DEFAULT_TODO_FILTER: TodoFilter = {
  state: "open",
  showDropped: false,
  projects: new Set(),
  tags: new Set(),
};

/** Started is derived: an open to-do with a thread started from it. */
export function isStarted(todo: Todo): boolean {
  return todo.state === "open" && todo.threads.length > 0;
}

function matchesState(todo: Todo, filter: TodoFilter): boolean {
  if (todo.state === "dropped") return filter.showDropped;
  switch (filter.state) {
    case "all":
      return true;
    case "open":
      return todo.state === "open";
    case "started":
      return isStarted(todo);
    case "done":
      return todo.state === "done";
  }
}

/** Filters combine: state, then any chosen Project, then any chosen tag. */
export function filterTodos(todos: ReadonlyArray<Todo>, filter: TodoFilter): ReadonlyArray<Todo> {
  return todos.filter((todo) => {
    if (!matchesState(todo, filter)) return false;
    if (filter.projects.size > 0) {
      const inProject =
        (todo.projects.length === 0 && filter.projects.has(NO_PROJECT)) ||
        todo.projects.some((link) => filter.projects.has(projectKey(link)));
      if (!inProject) return false;
    }
    if (filter.tags.size > 0 && !todo.tags.some((tag) => filter.tags.has(tag))) return false;
    return true;
  });
}

export interface TodoCounts {
  readonly open: number;
  readonly started: number;
  /** Open and not started: what the sidebar badge counts. */
  readonly waiting: number;
}

export function countTodos(todos: ReadonlyArray<Todo>): TodoCounts {
  let open = 0;
  let started = 0;
  for (const todo of todos) {
    if (todo.state !== "open") continue;
    open += 1;
    if (isStarted(todo)) started += 1;
  }
  return { open, started, waiting: open - started };
}

/** The page's one sentence of state: "4 open, 1 started", or what an empty list means. */
export function todoStateSentence(counts: TodoCounts): string {
  if (counts.open === 0) return "Nothing is open.";
  return counts.started === 0
    ? `${String(counts.open)} open`
    : `${String(counts.open)} open, ${String(counts.started)} started`;
}

/** Every tag in the list, for the tag picker, in first-seen order. */
export function tagsInList(todos: ReadonlyArray<Todo>): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const todo of todos) for (const tag of todo.tags) seen.add(tag);
  return [...seen];
}

/**
 * Whether the list takes no change from this window: its host cannot be
 * reached, or it lives on another computer whose last read failed. A paired
 * computer can drop off while its transport still reads as ready, so the
 * failed read is what says so; the next read that succeeds unlocks it.
 */
export function todoListIsReadOnly(
  source: { readonly remote: boolean; readonly unreachable?: string },
  readStatus: "loading" | "ready" | "failed",
): boolean {
  return source.unreachable !== undefined || (source.remote && readStatus === "failed");
}
