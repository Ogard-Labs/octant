import { createElement, useId, useState, type KeyboardEvent } from "react";
import { Slash } from "lucide-react";
import type { ProviderInstanceId, ProviderSlashCommand } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import {
  applySlashCommandToken,
  filterOctantCommands,
  parseSlashCommandToken,
  type OctantCommand,
} from "../palette/commandModel";
import { useOctantCommands } from "../palette/CommandRegistry";
import { OctantButton } from "../ui/base/OctantButton";

/** The provider's own slash commands a composer lists beside Octant's. */
export interface ComposerProviderCommands {
  /** The provider's name, so each row says whose command it is. */
  readonly label: string;
  readonly commands: ReadonlyArray<ProviderSlashCommand>;
}

/**
 * The selected provider's own commands, as its picker group carries them.
 * Every mode lists and runs them, Chat and Plan included; the thread's level
 * decides on the host what a command may then do.
 */
export function composerProviderCommands(
  groups: ReadonlyArray<PickerGroup> | undefined,
  instanceId: ProviderInstanceId | undefined,
): ComposerProviderCommands | undefined {
  if (instanceId === undefined) return undefined;
  const group = groups?.find((candidate) => String(candidate.instance.id) === String(instanceId));
  const commands = group?.providerCommands;
  if (group === undefined || commands === undefined || commands.length === 0) return undefined;
  return { label: group.driverLabel, commands };
}

/** The provider's own commands as `/` menu rows, each writing `/name ` into the draft. */
export function providerCommandEntries(
  provider: ComposerProviderCommands | undefined,
): ReadonlyArray<OctantCommand> {
  if (provider === undefined) return [];
  return provider.commands.map((command) => ({
    id: `provider-command:${command.name}`,
    title: `/${command.name}`,
    group: "Provider commands",
    detail: [`${provider.label}'s own`, command.argumentHint, command.description]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" · "),
    keywords: [command.name, provider.label],
    action: { kind: "address", reference: `/${command.name} ` },
  }));
}

/**
 * Shared `/` behavior for every composer, including first-turn drafts. `/`
 * runs Octant's commands and lists the thread's provider's own commands
 * beside them, labelled as the provider's; choosing one of those writes
 * `/name ` into the draft, which is sent to the runtime as the prompt.
 * Skills, plugin servers, and connectors are picked with `@` (see
 * `useComposerAtMenu`).
 */
export function useComposerSlashCommands(input: {
  readonly draft: string;
  readonly onDraftChange: (draft: string, caret?: number) => void;
  readonly textarea?: () => HTMLTextAreaElement | null;
  readonly provider?: ComposerProviderCommands | undefined;
}) {
  const listId = useId();
  const commands = [
    ...useOctantCommands().filter((command) => command.action.kind === "run"),
    ...providerCommandEntries(input.provider),
  ];
  const [token, setToken] = useState<ReturnType<typeof parseSlashCommandToken>>();
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = token === undefined ? [] : filterOctantCommands(commands, token.query);
  const tokenIsCurrent =
    token !== undefined && input.draft.slice(token.start, token.end) === `/${token.query}`;
  const open = tokenIsCurrent && commands.length > 0;
  const active = open ? matches[activeIndex] : undefined;

  const sync = (draft: string, caret: number | null) => {
    setToken(parseSlashCommandToken(draft, caret));
    setActiveIndex(0);
  };
  const choose = (command: OctantCommand) => {
    if (token === undefined || !tokenIsCurrent) return;
    const removed = applySlashCommandToken(input.draft, token);
    const reference = command.action.kind === "address" ? command.action.reference : "";
    const applied = {
      draft: `${removed.draft.slice(0, removed.caretIndex)}${reference}${removed.draft.slice(removed.caretIndex)}`,
      caretIndex: removed.caretIndex + reference.length,
    };
    input.onDraftChange(applied.draft, applied.caretIndex);
    setToken(undefined);
    setActiveIndex(0);
    queueMicrotask(() => {
      const textarea = input.textarea?.();
      if (textarea?.isConnected !== true) return;
      textarea.focus();
      textarea.setSelectionRange(applied.caretIndex, applied.caretIndex);
    });
    if (command.action.kind === "run") command.action.run();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing) return false;
    if (open && matches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % matches.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + matches.length) % matches.length);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && active) {
        event.preventDefault();
        choose(active);
        return true;
      }
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setToken(undefined);
      return true;
    }
    return false;
  };
  return {
    active,
    activeIndex,
    commandIds: commands.map((command) => command.id),
    choose,
    handleKeyDown,
    listId,
    matches,
    open,
    sync,
  };
}

export function ComposerSlashTypeahead(props: {
  readonly controller: ReturnType<typeof useComposerSlashCommands>;
}) {
  const { controller } = props;
  if (!controller.open) return null;
  const content =
    controller.matches.length === 0
      ? createElement(
          "p",
          { className: "chat-composer__command-empty", role: "status" },
          "No matching command. Leaving this as ordinary text.",
        )
      : createElement(
          "ul",
          {
            "aria-label": "Commands you can run",
            className: "chat-composer__command-list",
            id: controller.listId,
            role: "listbox",
          },
          ...controller.matches.map((command, index) =>
            createElement(
              "li",
              { className: "chat-composer__command-option", key: command.id, role: "presentation" },
              createElement(
                OctantButton,
                {
                  "aria-selected": index === controller.activeIndex,
                  id: `${controller.listId}-${command.id}`,
                  onClick: () => controller.choose(command),
                  role: "option",
                  size: "sm",
                  type: "button",
                  variant: index === controller.activeIndex ? "secondary" : "ghost",
                },
                createElement(Slash, { "aria-hidden": true, size: 12 }),
                createElement("span", null, command.title),
                createElement(
                  "span",
                  { className: "chat-composer__command-meta" },
                  command.detail === undefined
                    ? command.group
                    : `${command.group} · ${command.detail}`,
                ),
              ),
            ),
          ),
        );
  return createElement("div", { className: "chat-composer__command-typeahead" }, content);
}
