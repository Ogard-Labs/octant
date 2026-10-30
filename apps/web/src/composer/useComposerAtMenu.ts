import { createElement, useId, useState, type KeyboardEvent } from "react";
import { File, Folder, Globe2, Monitor, Plug, Sparkles } from "lucide-react";
import { filterOctantCommands } from "../palette/commandModel";
import { useOctantCommands } from "../palette/CommandRegistry";
import { readPathMentionQuery, type PathMentionCandidate } from "../code/pathMentions";
import { OctantButton } from "../ui/base/OctantButton";

/** How many skills, servers, and connectors one query lists before files. */
const MAX_EXTENSION_ROWS = 12;

type AtMenuIcon = "skill" | "server" | "computer" | "browser" | "file" | "folder";

export interface AtMenuRow {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly icon: AtMenuIcon;
  /** Runs after the `@…` token is out of the draft; never grants anything. */
  readonly choose: () => void;
}

/** An application mention that is already open for the same `@` token. */
export interface AtMenuApp {
  readonly kind: "computer" | "browser";
  readonly controller: { readonly open: boolean; readonly choose: () => void };
}

/** The Work and Code file picker, offered as rows beside the extensions. */
export interface AtMenuFiles {
  readonly open: boolean;
  readonly candidates: ReadonlyArray<PathMentionCandidate>;
  readonly choose: (candidate: PathMentionCandidate) => void;
}

/**
 * The one `@` picker every composer shares.
 *
 * It lists what the host's effective snapshot already offers — skills, plugin
 * MCP servers, and connectors — plus the files the thread's confined listing
 * returned in Work and Code. Choosing a row only hands the reference to the
 * composer's ordinary draft-resolution path, which the host re-checks at send;
 * nothing here installs, trusts, enables, or elevates anything.
 */
export function useComposerAtMenu(input: {
  readonly draft: string;
  readonly onDraftChange: (draft: string, caret?: number) => void;
  readonly onResolveExtensionReference?: (reference: string) => Promise<boolean>;
  readonly textarea?: () => HTMLTextAreaElement | null;
  readonly apps?: ReadonlyArray<AtMenuApp>;
  readonly files?: AtMenuFiles;
}) {
  const listId = useId();
  const commands = useOctantCommands();
  const [token, setToken] = useState<ReturnType<typeof readPathMentionQuery>>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [resolving, setResolving] = useState(false);
  const raw = token === undefined ? undefined : `@${token.query}`;
  const tokenIsCurrent =
    token !== undefined &&
    raw !== undefined &&
    input.draft.slice(token.start, token.start + raw.length) === raw;

  const rows: Array<AtMenuRow> = [];
  if (tokenIsCurrent) {
    for (const app of input.apps ?? []) {
      if (!app.controller.open) continue;
      rows.push({
        id: `app:${app.kind}`,
        title: app.kind === "computer" ? "Computer" : "Browser",
        meta: app.kind === "computer" ? "Computer use" : "Built-in browser",
        icon: app.kind,
        choose: app.controller.choose,
      });
    }
    const resolve = input.onResolveExtensionReference;
    if (resolve !== undefined) {
      const addressable = commands.filter((command) => command.action.kind === "address");
      for (const command of filterOctantCommands(addressable, token.query).slice(
        0,
        MAX_EXTENSION_ROWS,
      )) {
        if (command.action.kind !== "address") continue;
        const reference = command.action.reference;
        rows.push({
          id: command.id,
          title: command.title,
          meta: command.detail ?? command.group,
          icon: command.group === "Skills" ? "skill" : "server",
          choose: () => {
            const start = token.start;
            const draft = `${input.draft.slice(0, start)}${input.draft.slice(start + raw.length)}`;
            input.onDraftChange(draft, start);
            queueMicrotask(() => {
              const textarea = input.textarea?.();
              if (textarea?.isConnected !== true) return;
              textarea.focus();
              textarea.setSelectionRange(start, start);
            });
            setResolving(true);
            void resolve(reference)
              .catch(() => false)
              .finally(() => setResolving(false));
          },
        });
      }
    }
    if (input.files?.open === true) {
      const files = input.files;
      for (const candidate of files.candidates) {
        rows.push({
          id: `file:${candidate.path}`,
          title: candidate.path,
          meta: candidate.kind === "directory" ? "Folder" : "File",
          icon: candidate.kind === "directory" ? "folder" : "file",
          choose: () => files.choose(candidate),
        });
      }
    }
  }
  const open = rows.length > 0;
  const active = open ? rows[Math.min(activeIndex, rows.length - 1)] : undefined;

  const sync = (draft: string, caret: number | null) => {
    setToken(caret === null ? undefined : readPathMentionQuery(draft, caret));
    setActiveIndex(0);
  };
  const choose = (row: AtMenuRow) => {
    if (resolving) return;
    setToken(undefined);
    setActiveIndex(0);
    row.choose();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing) return false;
    if (resolving) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        return true;
      }
      return false;
    }
    if (!open) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % rows.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + rows.length) % rows.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && active) {
      event.preventDefault();
      choose(active);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setToken(undefined);
      return true;
    }
    return false;
  };
  return {
    active,
    activeIndex,
    choose,
    handleKeyDown,
    listId,
    open,
    resolving,
    rows,
    setActiveIndex,
    sync,
  };
}

const ICONS = {
  skill: Sparkles,
  server: Plug,
  computer: Monitor,
  browser: Globe2,
  file: File,
  folder: Folder,
} as const;

export function ComposerAtTypeahead(props: {
  readonly controller: ReturnType<typeof useComposerAtMenu>;
}) {
  const { controller } = props;
  if (!controller.open) return null;
  return createElement(
    "div",
    { className: "chat-composer__command-typeahead" },
    createElement(
      "ul",
      {
        "aria-label": "Skills, tools, and files you can mention",
        className: "chat-composer__command-list",
        id: controller.listId,
        role: "listbox",
      },
      ...controller.rows.map((row, index) =>
        createElement(
          "li",
          { className: "chat-composer__command-option", key: row.id, role: "presentation" },
          createElement(
            OctantButton,
            {
              "aria-selected": row.id === controller.active?.id,
              id: `${controller.listId}-${row.id}`,
              onClick: () => controller.choose(row),
              onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
              onMouseEnter: () => controller.setActiveIndex(index),
              role: "option",
              size: "sm",
              type: "button",
              variant: row.id === controller.active?.id ? "secondary" : "ghost",
            },
            createElement(ICONS[row.icon], { "aria-hidden": true, size: 12, strokeWidth: 1.8 }),
            createElement("span", null, row.title),
            createElement("span", { className: "chat-composer__command-meta" }, row.meta),
          ),
        ),
      ),
    ),
  );
}
