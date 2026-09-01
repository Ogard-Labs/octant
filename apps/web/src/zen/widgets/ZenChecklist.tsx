import type { ZenChecklistElementPayload, ZenChecklistItemId } from "@octant/contracts/zen";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantInput } from "../../ui/base/OctantInput";

export interface ZenChecklistProps {
  readonly element: ZenChecklistElementPayload;
  readonly onAddItem?: (
    elementId: ZenChecklistElementPayload["elementId"],
    text: string,
    expectedWidgetVersion: ZenChecklistElementPayload["widgetVersion"],
  ) => Promise<void>;
  readonly onSetCompleted?: (
    elementId: ZenChecklistElementPayload["elementId"],
    itemId: ZenChecklistItemId,
    done: boolean,
    expectedWidgetVersion: ZenChecklistElementPayload["widgetVersion"],
  ) => Promise<void>;
  readonly onReorder?: (
    elementId: ZenChecklistElementPayload["elementId"],
    itemId: ZenChecklistItemId,
    beforeItemId: ZenChecklistItemId | null,
    expectedWidgetVersion: ZenChecklistElementPayload["widgetVersion"],
  ) => Promise<void>;
  readonly onRemoveItem?: (
    elementId: ZenChecklistElementPayload["elementId"],
    itemId: ZenChecklistItemId,
    expectedWidgetVersion: ZenChecklistElementPayload["widgetVersion"],
  ) => Promise<void>;
}

export function ZenChecklist(props: ZenChecklistProps) {
  const { element } = props;
  const [newItem, setNewItem] = useState("");
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const checkboxRefs = useRef(new Map<string, HTMLInputElement>());

  async function run(
    action: () => Promise<void>,
    restoreItemId?: ZenChecklistItemId,
  ): Promise<void> {
    setStatus("saving");
    try {
      await action();
      setStatus("saved");
      if (restoreItemId !== undefined) {
        queueMicrotask(() => checkboxRefs.current.get(String(restoreItemId))?.focus());
      }
    } catch {
      setStatus("error");
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const text = newItem.trim();
    if (text.length === 0 || props.onAddItem === undefined) return;
    void run(async () => {
      await props.onAddItem?.(element.elementId, text, element.widgetVersion);
      setNewItem("");
    });
  }

  function beforeIdForMove(index: number, direction: -1 | 1): ZenChecklistItemId | null {
    if (direction === -1) return element.items[index - 1]?.itemId ?? null;
    return element.items[index + 2]?.itemId ?? null;
  }

  function move(itemId: ZenChecklistItemId, index: number, direction: -1 | 1): void {
    if (props.onReorder === undefined) return;
    void run(
      () =>
        props.onReorder!(
          element.elementId,
          itemId,
          beforeIdForMove(index, direction),
          element.widgetVersion,
        ),
      itemId,
    );
  }

  function handleItemKeyDown(
    event: KeyboardEvent<HTMLLIElement>,
    itemId: ZenChecklistItemId,
    index: number,
  ): void {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const direction = event.key === "ArrowUp" ? -1 : 1;
    if (
      (direction === -1 && index === 0) ||
      (direction === 1 && index === element.items.length - 1)
    ) {
      return;
    }
    event.preventDefault();
    move(itemId, index, direction);
  }

  const title = element.title ?? "Checklist";
  return (
    <div className="zen-checklist">
      <ul aria-label={`${title} items`} className="zen-check">
        {element.items.map((item, index) => (
          <li
            className={item.done ? "is-done" : undefined}
            key={item.itemId}
            onKeyDown={(event) => handleItemKeyDown(event, item.itemId, index)}
          >
            <label className="check zen-checklist__label">
              <OctantCheckbox
                checked={item.done}
                disabled={element.locked || props.onSetCompleted === undefined}
                onChange={(event) =>
                  void run(() =>
                    props.onSetCompleted!(
                      element.elementId,
                      item.itemId,
                      event.currentTarget.checked,
                      element.widgetVersion,
                    ),
                  )
                }
                ref={(node) => {
                  if (node === null) checkboxRefs.current.delete(String(item.itemId));
                  else checkboxRefs.current.set(String(item.itemId), node);
                }}
              />
              <span>{item.text}</span>
            </label>
            <span className="zen-checklist__actions">
              <OctantButton
                aria-label={`Move ${item.text} up`}
                disabled={element.locked || index === 0 || props.onReorder === undefined}
                onClick={() => move(item.itemId, index, -1)}
                size="sm"
                type="button"
                variant="ghost"
              >
                ↑
              </OctantButton>
              <OctantButton
                aria-label={`Move ${item.text} down`}
                disabled={
                  element.locked ||
                  index === element.items.length - 1 ||
                  props.onReorder === undefined
                }
                onClick={() => move(item.itemId, index, 1)}
                size="sm"
                type="button"
                variant="ghost"
              >
                ↓
              </OctantButton>
              <OctantButton
                aria-label={`Remove ${item.text}`}
                disabled={element.locked || props.onRemoveItem === undefined}
                onClick={() =>
                  void run(() =>
                    props.onRemoveItem!(element.elementId, item.itemId, element.widgetVersion),
                  )
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                Remove
              </OctantButton>
            </span>
          </li>
        ))}
      </ul>
      <form className="zen-checklist__add" noValidate onSubmit={submit}>
        <label>
          <span className="visually-hidden">New checklist item</span>
          <OctantInput
            aria-label="New checklist item"
            disabled={element.locked || props.onAddItem === undefined}
            maxLength={500}
            onChange={(event) => setNewItem(event.currentTarget.value)}
            type="text"
            value={newItem}
          />
        </label>
        <OctantButton
          disabled={newItem.trim().length === 0 || element.locked || props.onAddItem === undefined}
          size="sm"
          type="submit"
          variant="secondary"
        >
          Add item
        </OctantButton>
      </form>
      {status === "error" ? (
        <p className="zen-widget-status zen-widget-status--error" role="alert">
          Checklist update failed. The saved list is unchanged.
        </p>
      ) : (
        <p aria-live="polite" className="zen-widget-status" role="status">
          {status === "saving" ? "Saving…" : "Saved"}
        </p>
      )}
    </div>
  );
}
