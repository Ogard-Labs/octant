import { createElement, useId, useState, type KeyboardEvent } from "react";
import { Slash } from "lucide-react";
import {
  applySlashCommandToken,
  filterOctantCommands,
  parseSlashCommandToken,
  type OctantCommand,
} from "../palette/commandModel";
import { useOctantCommands } from "../palette/CommandRegistry";
import { OctantButton } from "../ui/base/OctantButton";

/** Shared `/` behavior for every composer, including first-turn drafts. */
export function useComposerSlashCommands(input: {
  readonly draft: string;
  readonly onDraftChange: (draft: string, caret?: number) => void;
  readonly onResolveExtensionReference?: (reference: string) => Promise<boolean>;
}) {
  const listId = useId();
  const commands = useOctantCommands().filter(
    (command) => command.action.kind === "run" || input.onResolveExtensionReference !== undefined,
  );
  const [token, setToken] = useState<ReturnType<typeof parseSlashCommandToken>>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [resolving, setResolving] = useState(false);
  const matches = token === undefined ? [] : filterOctantCommands(commands, token.query);
  const open = token !== undefined && commands.length > 0;
  const active = open ? matches[activeIndex] : undefined;

  const sync = (draft: string, caret: number | null) => {
    setToken(parseSlashCommandToken(draft, caret));
    setActiveIndex(0);
  };
  const choose = (command: OctantCommand) => {
    if (token === undefined) return;
    const applied = applySlashCommandToken(input.draft, token);
    input.onDraftChange(applied.draft, applied.caretIndex);
    setToken(undefined);
    setActiveIndex(0);
    if (command.action.kind === "run") {
      command.action.run();
      return;
    }
    setResolving(true);
    const pending = input.onResolveExtensionReference?.(command.action.reference);
    if (pending === undefined) {
      setResolving(false);
      return;
    }
    void pending.finally(() => setResolving(false));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing) return false;
    if (resolving) {
      event.preventDefault();
      return true;
    }
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
  return { active, activeIndex, choose, handleKeyDown, listId, matches, open, resolving, sync };
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
                createElement(Slash, { "aria-hidden": true, size: 12, strokeWidth: 1.8 }),
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
