import { decodeTodoListView } from "@octant/contracts/todos";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTodoList } from "./useTodoList";

const view = decodeTodoListView({
  kind: "todo-list",
  hostId: "11111111-1111-4111-8111-111111111111",
  todos: [],
});

describe("a list on another computer", () => {
  it("reads again when the other computer reports a change", async () => {
    const read = vi.fn(async () => view);
    let notify:
      | ((result: { changed: boolean; epoch: string; sequence: number }) => void)
      | undefined;
    const waitForChange = vi.fn(
      (_cursor, _signal) =>
        new Promise<{ changed: boolean; epoch: string; sequence: number }>((resolve) => {
          notify = resolve;
        }),
    );
    const client = { read, change: vi.fn(async () => view) };
    const { unmount } = renderHook(() =>
      useTodoList(client, undefined, { key: "other", waitForChange }),
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    const previous = read.mock.calls.length;
    await act(async () => {
      notify?.({ changed: true, epoch: "host", sequence: 1 });
    });
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(previous));
    unmount();
  });
  it("keeps the new list when an old host answers after a switch", async () => {
    const other = decodeTodoListView({
      kind: "todo-list",
      hostId: "22222222-2222-4222-8222-222222222222",
      todos: [],
    });
    let resolveOld: ((result: typeof view) => void) | undefined;
    const first = {
      read: vi.fn(
        () =>
          new Promise<typeof view>((resolve) => {
            resolveOld = resolve;
          }),
      ),
      change: vi.fn(async () => view),
    };
    const second = { read: vi.fn(async () => other), change: vi.fn(async () => other) };
    const { result, rerender } = renderHook(
      ({ client, key }) => useTodoList(client, undefined, { key }),
      { initialProps: { client: first, key: "first" } },
    );
    await waitFor(() => expect(first.read).toHaveBeenCalled());
    rerender({ client: second, key: "second" });
    await waitFor(() => expect(result.current.read).toEqual({ status: "ready", view: other }));
    await act(async () => {
      resolveOld?.(view);
    });
    expect(result.current.read).toEqual({ status: "ready", view: other });
  });
});
