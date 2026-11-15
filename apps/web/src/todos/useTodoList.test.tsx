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
});
