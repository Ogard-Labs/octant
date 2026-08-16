import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { isApplePlatform } from "../platform";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { useOctantCommands } from "./CommandRegistry";
import { filterOctantCommands, groupOctantCommands, type OctantCommand } from "./commandModel";

const RESULTS_ID = "command-palette-results";

function optionId(index: number): string {
  return `command-palette-option-${index}`;
}

/**
 * Report whether a keyboard event is the palette chord.
 *
 * `Cmd+K` on Apple hardware and `Ctrl+K` elsewhere. On macOS — the shipping
 * target — `Ctrl+K` is Cocoa's "delete to end of line" in every text field, and
 * the handler that asks this question cancels the event, so accepting `Ctrl+K`
 * there would take that editing command away from the whole app in exchange for
 * a second way to reach a palette `Cmd+K` already opens. Shift and Alt must be
 * absent, so the chord cannot collide with Zen (`Cmd/Ctrl+Shift+Z`) or with any
 * Shift/Alt-qualified editor binding.
 */
export function isCommandPaletteEvent(event: globalThis.KeyboardEvent): boolean {
  if (event.shiftKey || event.altKey || event.key.toLowerCase() !== "k") return false;
  return isApplePlatform() ? event.metaKey : event.metaKey || event.ctrlKey;
}

/**
 * The global command palette (`Cmd/Ctrl+K`).
 *
 * It runs the same host-derived commands the `/` composer affordance offers,
 * plus shell navigation. Only `run` commands appear: an `address` command
 * writes a reference into a composer draft, and the palette has no draft to
 * write into, so offering one here would be exactly the dead entry this surface
 * must not show.
 *
 * Keyboard operation is the whole contract. The combobox keeps focus while
 * Up/Down/Home/End move an active option, Enter runs it, and Escape dismisses;
 * the dialog traps focus while open and returns it to the element that was
 * focused when the chord fired. The active row is marked by `aria-selected` and
 * `aria-activedescendant` for assistive technology, and by a fill *and* a
 * visible `Enter` affordance on screen, so its state never rests on colour.
 */
export function CommandPalette() {
  const commands = useOctantCommands().filter((command) => command.action.kind === "run");
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const available = commands.length > 0;

  useEffect(() => {
    if (!available) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (!isCommandPaletteEvent(event)) return;
      event.preventDefault();
      if (open) {
        setOpen(false);
        return;
      }
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setActiveIndex(0);
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [available, open]);

  if (!open) return null;

  // One order for everything. Grouping is the palette's affordance — a query
  // that matches a Project and a thread says so — but it reorders the ranked
  // results, so the grouped order is flattened and *that* is what the arrow
  // keys move through and what Enter runs. Indexing the ranked list instead
  // would run a different command than the row drawn as active.
  const groups = groupOctantCommands(filterOctantCommands(commands, query));
  const results = groups.flatMap((group) => group.commands);
  const indexOfCommand = new Map(results.map((command, index) => [command.id, index]));
  const active = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);
  const statusMessage =
    results.length === 0
      ? "No matching command."
      : `${results.length} matching command${results.length === 1 ? "" : "s"}.`;

  function close(): void {
    setOpen(false);
  }

  function run(command: OctantCommand | undefined): void {
    if (command === undefined || command.action.kind !== "run") return;
    setOpen(false);
    command.action.run();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(active + 1 >= results.length ? 0 : active + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(active <= 0 ? results.length - 1 : active - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(results.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      run(results[active]);
    }
  }

  return (
    <OctantDialog
      className="command-palette"
      initialFocus={inputRef}
      label="Command palette"
      onClose={close}
      open
      popupId="command-palette-dialog"
      restoreFocus={restoreFocusRef}
    >
      <div className="command-palette__field">
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <OctantInput
          {...(active >= 0 ? { "aria-activedescendant": optionId(active) } : {})}
          aria-controls={RESULTS_ID}
          aria-expanded={results.length > 0}
          aria-label="Search commands"
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search commands"
          ref={inputRef}
          role="combobox"
          value={query}
        />
      </div>
      <p className="command-palette__scope" role="note">
        Commands this host offers right now. Each one runs through its ordinary authority check.
      </p>
      <p aria-atomic="true" aria-live="polite" className="command-palette__status" role="status">
        {statusMessage}
      </p>
      <div
        aria-label="Command results"
        className="command-palette__results"
        id={RESULTS_ID}
        role="listbox"
      >
        {groups.map((group) => (
          <div
            aria-label={group.group}
            className="command-palette__group"
            key={group.group}
            role="group"
          >
            <p aria-hidden="true" className="command-palette__group-label">
              {group.group}
            </p>
            {group.commands.map((command) => {
              const index = indexOfCommand.get(command.id) ?? -1;
              return (
                <div
                  aria-selected={index === active}
                  className="command-palette__result"
                  data-active={index === active}
                  id={optionId(index)}
                  key={command.id}
                  onClick={() => run(command)}
                  onMouseMove={() => setActiveIndex(index)}
                  role="option"
                >
                  <span className="command-palette__result-title">{command.title}</span>
                  {command.detail === undefined ? null : (
                    <span className="command-palette__result-detail">{command.detail}</span>
                  )}
                  {index === active ? (
                    <span className="command-palette__result-hint">
                      <CornerDownLeft aria-hidden="true" size={12} strokeWidth={1.8} />
                      <span>Enter</span>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </OctantDialog>
  );
}
