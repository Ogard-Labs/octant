/**
 * Which open dock tools stay on the strip, and which move into overflow.
 *
 * The active tool always stays visible so a narrow dock never hides the thing
 * the person is looking at. Remaining slots fill from the left of the open
 * set; overflow is the rest, in the same order.
 */
export function partitionDockTools<T extends { readonly id: string }>(
  tools: ReadonlyArray<T>,
  activeId: string | undefined,
  capacity: number,
): { readonly visible: ReadonlyArray<T>; readonly overflow: ReadonlyArray<T> } {
  if (tools.length === 0) return { visible: [], overflow: [] };
  if (capacity >= tools.length) return { visible: tools, overflow: [] };

  const keep = Math.max(1, capacity);
  const active = tools.find((tool) => tool.id === activeId);
  const rest = tools.filter((tool) => tool.id !== activeId);
  const visibleRest = rest.slice(0, active === undefined ? keep : keep - 1);
  const visible =
    active === undefined
      ? visibleRest
      : [...tools.filter((tool) => visibleRest.includes(tool) || tool === active)];
  const overflow = tools.filter((tool) => !visible.includes(tool));
  return { visible, overflow };
}
