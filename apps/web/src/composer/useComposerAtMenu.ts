import {
  createElement,
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ProjectId,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderMention,
  ThreadNativeSetupRequest,
} from "@octant/contracts";
import {
  insertSubagentModelTag,
  type PickerGroup,
  type SubagentModelTag,
  type SubagentModelTagMatch,
} from "@octant/domain";
import { Bot, File, Folder, Globe2, Monitor, Plug, Sparkles } from "../ui/icons";
import { filterOctantCommands } from "../palette/commandModel";
import { useOctantCommands } from "../palette/CommandRegistry";
import { readPathMentionQuery, type PathMentionCandidate } from "../code/pathMentions";
import { useThreadNativeSetupServices } from "../providers/ThreadNativeSetupControl";
import { OctantButton } from "../ui/base/OctantButton";
import type { ComposerInputElement } from "./ComposerInput";
// The picker and chip load the first time a prompt shows one, so the start
// screen's initial load carries neither them nor their styles.
const loadSubagentModelPicker = () => import("./SubagentModelPicker");
const SubagentModelPicker = lazy(() =>
  loadSubagentModelPicker().then((module) => ({ default: module.SubagentModelPicker })),
);
const SubagentModelChip = lazy(() =>
  loadSubagentModelPicker().then((module) => ({ default: module.SubagentModelChip })),
);

/** How many skills, servers, and connectors one query lists before files. */
const MAX_EXTENSION_ROWS = 12;

type AtMenuIcon = "skill" | "server" | "computer" | "browser" | "file" | "folder" | "model";

/** The token that opens the subagent model picker. */
const MODEL_TOKEN = "model";

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
  /**
   * Identifies the thread/Project/setup scope of `load`. Changing it drops
   * earlier folder-scoped mentions immediately so stale Project skills never
   * appear after switching threads or turning Project skills off.
   */
  readonly scopeKey?: string;
  /** Loads thread- or Project-scoped mentions when the `@` menu opens. */
  readonly load?: () => Promise<ReadonlyArray<ProviderMention>>;
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

export type ThreadProviderMentionsTarget =
  | {
      readonly kind: "thread";
      readonly mode: "work" | "code";
      readonly threadId: string;
      readonly projectId?: ProjectId | undefined;
      readonly providerInstanceId: ProviderInstanceId | undefined;
      readonly executionPolicy?: ProviderExecutionPolicy | undefined;
    }
  | {
      readonly kind: "draft";
      readonly mode: "work" | "code";
      readonly projectId: ProjectId | undefined;
      readonly providerInstanceId: ProviderInstanceId | undefined;
      readonly executionPolicy?: ProviderExecutionPolicy | undefined;
    };

/**
 * The selected provider's skills and plugins for a Work or Code thread or
 * draft. Starts with the account-level mentions from the picker group and
 * refreshes from the host when `@` opens so Project skills appear (labeled
 * "Project") only while the thread's launch actually loads them.
 */
export function useThreadProviderMentions(
  groups: ReadonlyArray<PickerGroup> | undefined,
  target: ThreadProviderMentionsTarget,
): ComposerProviderMentions | undefined {
  const services = useThreadNativeSetupServices();
  const readMentions = services?.readMentions;
  const revision = services?.revision ?? 0;
  const instanceId = target.providerInstanceId;
  const group =
    instanceId === undefined
      ? undefined
      : groups?.find((candidate) => String(candidate.instance.id) === String(instanceId));
  const accountNativeSetup =
    group !== undefined && "nativeSetup" in group.instance ? group.instance.nativeSetup : undefined;
  const project =
    target.projectId === undefined
      ? undefined
      : services?.projects?.find((candidate) => String(candidate.id) === String(target.projectId));
  const trustedKey =
    project !== undefined && project.type !== "chat"
      ? (project.nativeProviders ?? []).join(",")
      : "";
  const request = useMemo<
    Extract<ThreadNativeSetupRequest, { kind: "mentions" | "draft-mentions" }> | undefined
  >(() => {
    if (readMentions === undefined || group === undefined || instanceId === undefined) {
      return undefined;
    }
    if (target.kind === "thread") {
      return { kind: "mentions", mode: target.mode, threadId: target.threadId };
    }
    if (target.projectId === undefined) return undefined;
    return {
      kind: "draft-mentions",
      mode: target.mode,
      projectId: target.projectId,
      providerInstanceId: instanceId,
      ...(target.executionPolicy === undefined ? {} : { executionPolicy: target.executionPolicy }),
    };
  }, [
    readMentions,
    group,
    instanceId,
    target.kind,
    target.mode,
    target.kind === "thread" ? target.threadId : undefined,
    target.projectId,
    target.executionPolicy,
  ]);
  const scopeKey =
    request === undefined
      ? undefined
      : [
          request.kind,
          request.mode,
          request.kind === "mentions" ? request.threadId : String(request.projectId),
          String(instanceId),
          target.executionPolicy ?? "",
          accountNativeSetup === false ? "acct-off" : "acct-on",
          trustedKey,
          String(revision),
        ].join(":");
  return useMemo<ComposerProviderMentions | undefined>(() => {
    if (group === undefined) return undefined;
    const mentions = group.providerMentions ?? [];
    if (request === undefined || readMentions === undefined || scopeKey === undefined) {
      return mentions.length === 0 ? undefined : { label: group.driverLabel, mentions };
    }
    return {
      label: group.driverLabel,
      mentions,
      scopeKey,
      load: () => readMentions(request),
    };
  }, [group, request, readMentions, scopeKey]);
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
  readonly textarea?: () => ComposerInputElement | null;
  readonly apps?: ReadonlyArray<AtMenuApp>;
  readonly files?: AtMenuFiles;
  readonly provider?: ComposerProviderMentions | undefined;
  /**
   * The provider catalog `@model` chooses a subagent's route from. Without it
   * the composer offers no model picker and tags show their raw ids.
   */
  readonly modelGroups?: ReadonlyArray<PickerGroup> | undefined;
}) {
  const listId = useId();
  const commands = useOctantCommands();
  const [token, setToken] = useState<ReturnType<typeof readPathMentionQuery>>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [modelPicker, setModelPicker] = useState<
    | {
        readonly start: number;
        readonly end: number;
        /** Where the caret was when the picker opened; Escape returns it there. */
        readonly caret?: number | undefined;
        readonly initial?: SubagentModelTag | undefined;
      }
    | undefined
  >(undefined);
  const modelGroups = input.modelGroups;
  const [loadedMentions, setLoadedMentions] = useState<
    { readonly scopeKey: string; readonly mentions: ReadonlyArray<ProviderMention> } | undefined
  >(undefined);
  const loadedForOpenRef = useRef<string | undefined>(undefined);
  const raw = token === undefined ? undefined : `@${token.query}`;
  const tokenIsCurrent =
    token !== undefined &&
    raw !== undefined &&
    input.draft.slice(token.start, token.start + raw.length) === raw;
  const providerLoad = input.provider?.load;
  const providerScopeKey = input.provider?.scopeKey;
  useEffect(() => {
    if (!tokenIsCurrent) {
      loadedForOpenRef.current = undefined;
      return;
    }
    if (providerLoad === undefined || providerScopeKey === undefined) return;
    if (loadedForOpenRef.current === providerScopeKey) return;
    loadedForOpenRef.current = providerScopeKey;
    let current = true;
    let settled = false;
    void providerLoad()
      .then((mentions) => {
        settled = true;
        if (current) setLoadedMentions({ scopeKey: providerScopeKey, mentions });
      })
      .catch(() => {
        settled = true;
      });
    return () => {
      current = false;
      // If `load` identity changed before the in-flight request settled, allow
      // the next effect run for the same scope to start a fresh request.
      if (!settled && loadedForOpenRef.current === providerScopeKey) {
        loadedForOpenRef.current = undefined;
      }
    };
  }, [tokenIsCurrent, providerLoad, providerScopeKey]);
  const providerMentions =
    providerScopeKey !== undefined && loadedMentions?.scopeKey === providerScopeKey
      ? loadedMentions.mentions
      : (input.provider?.mentions ?? []);

  const focusPrompt = (caret: number) => {
    queueMicrotask(() => {
      const textarea = input.textarea?.();
      if (textarea?.isConnected !== true) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };
  const chooseModel = (tag: SubagentModelTag) => {
    if (modelPicker === undefined) return;
    const inserted = insertSubagentModelTag(input.draft, modelPicker, tag);
    setModelPicker(undefined);
    setToken(undefined);
    input.onDraftChange(inserted.draft, inserted.caret);
    focusPrompt(inserted.caret);
  };
  const dismissModelPicker = () => {
    if (modelPicker === undefined) return;
    setModelPicker(undefined);
    setToken(undefined);
    focusPrompt(modelPicker.caret ?? modelPicker.end);
  };
  const renderModelChip =
    modelGroups === undefined
      ? undefined
      : (
          match: SubagentModelTagMatch,
          locate: () => { readonly start: number; readonly end: number },
        ) =>
          createElement(
            Suspense,
            { fallback: createElement("span", { className: "composer-chip__label" }, match.text) },
            createElement(SubagentModelChip, {
              groups: modelGroups,
              tag: match.tag,
              onActivate: () => {
                const range = locate();
                setModelPicker({ start: range.start, end: range.end, initial: match.tag });
              },
            }),
          );

  // `@model` is the menu's first row, not a picker that opens by itself: a
  // file mention such as `@models/schema.ts` passes through `@model` while it
  // is typed, and must keep the keyboard. Enter on the row opens the picker.
  const rows: Array<AtMenuRow> = [];
  if (tokenIsCurrent && modelGroups !== undefined) {
    // The token runs past the caret when the caret sits inside it; the row
    // is offered only when the whole word is `@model` or its prefix, and the
    // chosen tag replaces all of it, not only the part before the caret.
    const rest = input.draft.slice(token.start + raw.length).match(/^\S*/)?.[0] ?? "";
    const word = `${token.query}${rest}`.toLowerCase();
    if (word.length > 0 && MODEL_TOKEN.startsWith(word)) {
      // Start loading the picker while the row is offered, so it is usually
      // ready by the time Enter opens it.
      // A failed early load is retried when the picker renders, where its
      // own error surfaces; the warm-up itself has nothing to report.
      loadSubagentModelPicker().catch(() => undefined);
      const start = token.start;
      const end = token.start + 1 + word.length;
      rows.push({
        id: "subagent-model",
        title: "@model",
        meta: "Choose a subagent's provider, model, and reasoning",
        icon: "model",
        choose: () => setModelPicker({ start, end, caret: start + raw.length }),
      });
    }
  }
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
    for (const mention of providerMentions
      .filter((candidate) => candidate.name.toLowerCase().includes(query))
      .slice(0, MAX_EXTENSION_ROWS)) {
      const reference = providerMentionReference(mention);
      const providerLabel = provider?.label ?? "Provider";
      const origin =
        mention.scope === "project"
          ? `Project · ${providerLabel}'s own ${mention.kind}`
          : `${providerLabel}'s own ${mention.kind}`;
      rows.push({
        id: `provider-mention:${mention.kind}:${mention.name}`,
        title: reference,
        meta: [origin, mention.description]
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
  const open = rows.length > 0 || modelPicker !== undefined;
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
  const handleKeyDown = (event: KeyboardEvent<ComposerInputElement>): boolean => {
    if (event.nativeEvent.isComposing) return false;
    if (resolving) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        return true;
      }
      return false;
    }
    // Until the picker's search takes focus (its code may still be loading),
    // the prompt keeps the keyboard: Enter must not fall through to the
    // composer's send, and Escape cancels the picker.
    if (modelPicker !== undefined) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissModelPicker();
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
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
    modelPicker:
      modelPicker === undefined || modelGroups === undefined
        ? undefined
        : {
            groups: modelGroups,
            initial: modelPicker.initial,
            choose: chooseModel,
            dismiss: dismissModelPicker,
          },
    open,
    renderModelChip,
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
  model: Bot,
} as const;

export function ComposerAtTypeahead(props: {
  readonly controller: ReturnType<typeof useComposerAtMenu>;
}) {
  const { controller } = props;
  if (!controller.open) return null;
  const picker = controller.modelPicker;
  if (picker !== undefined) {
    return createElement(
      Suspense,
      { fallback: null },
      createElement(SubagentModelPicker, {
        groups: picker.groups,
        initial: picker.initial,
        onChoose: picker.choose,
        onDismiss: picker.dismiss,
      }),
    );
  }
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
