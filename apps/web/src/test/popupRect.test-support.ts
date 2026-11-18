import { expect } from "vitest";

export interface PopupRects {
  readonly popup: string;
  readonly reserved: ReadonlyArray<{ readonly element: Element; readonly rect: string }>;
}

const describeRect = (element: Element): string => {
  const rect = element.getBoundingClientRect();
  return [rect.x, rect.y, rect.width, rect.height].map((value) => value.toFixed(1)).join(",");
};

/**
 * What a popup looks like: its own rectangle and the rectangle of every row
 * marked `data-reserved`, the rows a choice may quiet but never add or remove.
 */
export function measurePopup(popup: Element): PopupRects {
  return {
    popup: describeRect(popup),
    reserved: [...popup.querySelectorAll("[data-reserved]")].map((element) => ({
      element,
      rect: describeRect(element),
    })),
  };
}

/**
 * A popup keeps its size and place whatever happens inside it: data arriving,
 * a choice made, a toggle thrown. Runs `interaction` and asserts the popup and
 * its reserved rows are the same elements at the same rectangles afterwards.
 *
 * jsdom lays nothing out, so under it every rectangle is zero and the check
 * that has teeth is the identity of the reserved rows: none inserted, none
 * removed, none replaced. Under a real layout the rectangles are compared too.
 */
export async function expectPopupUnmoved(
  popup: Element,
  interaction: () => void | Promise<void>,
): Promise<void> {
  const before = measurePopup(popup);
  await interaction();
  const after = measurePopup(popup);
  expect(after.popup).toBe(before.popup);
  expect(after.reserved.map((row) => row.element)).toEqual(
    before.reserved.map((row) => row.element),
  );
  expect(after.reserved.map((row) => row.rect)).toEqual(before.reserved.map((row) => row.rect));
}
