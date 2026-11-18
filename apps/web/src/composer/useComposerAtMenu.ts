import { createElement, useId, useState, type KeyboardEvent } from "react";
import type { ProviderInstanceId, ProviderMention } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { File, Folder, Globe2, Monitor, Plug, Sparkles } from "../ui/icons";
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

/** The provider's own skills and plugins a composer offers beside Octant's. */
export interface ComposerProviderMentions {
  /** The provider's name, so each row says whose skill or plugin it is. */
  readonly label: string;
  readonly mentions: ReadonlyArray<ProviderMention>;
}

/** The selected provider's own skills and plugins, as its picker group carries them. */
export function composerProviderMentions(
  groups: ReadonlyArray<PickerGroup> | undefined,
  instanceId: ProviderInstanceId | undefined,
): ComposerProviderMentions | undefined {
  if (instanceId === undefined) return undefined;
  const group = groups?.find((candidate) => String(candidate.instance.id) === String(instanceId));
  const mentions = group?.providerMentions;
  if (group === undefined || mentions === undefined || mentions.length === 0) return undefined;
  return { label: group.driverLabel, mentions };
}

/** The runtime's own reference for a skill or plugin, as its own composer writes it. */
function providerMentionReference(mention: ProviderMention): string {
  return mention.kind === "skill" ? `$${mention.name}` : `@${mention.name}`;
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
 * MCP servers, and connectors — then the thread's provider's own skills and
 * plugins, labelled as the provider's, plus the files the thread's confined
 * listing returned in Work and Code. Choosing an Octant row only hands the
 * reference to the composer's ordinary draft-resolution path, which the host
 * re-checks at send; choosing a provider's row writes the runtime's own
 * reference (`$name`, `@name`) into the draft, which its driver resolves
 * against its own listing at send. Nothing here installs, trusts, enables, or
 * elevates anything.
 */
export function useComposerAtMenu(input: {
  readonly draft: string;
  readonly onDraftChange: (draft: string, caret?: number) => void;
  readonly onResolveExtensionReference?: (reference: string) => Promise<boolean>;
  readonly textarea?: () => HTMLTextAreaElement | null;
  readonly apps?: ReadonlyArray<AtMenuApp>;
  readonly files?: AtMenuFiles;
  readonly provider?: ComposerProviderMentions | undefined;
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
    const query = token.query.toLowerCase();
    const provider = input.provider;
    for (const mention of (provider?.mentions ?? [])
      .filter((candidate) => candidate.name.toLowerCase().includes(query))
      .slice(0, MAX_EXTENSION_ROWS)) {
      const reference = providerMentionReference(mention);
      rows.push({
        id: `provider-mention:${mention.kind}:${mention.name}`,
        title: reference,
        meta: [`${provider?.label ?? "Provider"}'s own ${mention.kind}`, mention.description]
          .filter((part) => part !== undefined && part.length > 0)
          .join(" · "),
        icon: mention.kind === "skill" ? "skill" : "server",
        choose: () => {
          const start = token.start;
          const written = `${reference} `;
          const draft = `${input.draft.slice(0, start)}${written}${input.draft.slice(start + raw.length)}`;
          const caret = start + written.length;
          input.onDraftChange(draft, caret);
          queueMicrotask(() => {
            const textarea = input.textarea?.();
            if (textarea?.isConnected !== true) return;
            textarea.focus();
            textarea.setSelectionRange(caret, caret);
          });
        },
      });
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
    const next = caret === null ? undefined : readPathMentionQuery(draft, caret);
    setToken(next);
    // Arrow keys fire keyup too; only a different token starts the list over.
    if (next?.query !== token?.query || next?.start !== token?.start) setActiveIndex(0);
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
            createElement(ICONS[row.icon], { "aria-hidden": true, size: 12 }),
            createElement("span", null, row.title),
            createElement("span", { className: "chat-composer__command-meta" }, row.meta),
          ),
        ),
      ),
    ),
  );
}
