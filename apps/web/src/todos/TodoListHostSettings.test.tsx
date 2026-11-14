import { decodeStableHostId } from "@octant/contracts/remote-access";
import { decodeTodoListHostView } from "@octant/contracts/todos";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TodoListHostSettings, TodoListHostSettingsContext } from "./TodoListHostSettings";

const THIS = "11111111-1111-4111-8111-111111111111";
const STUDIO = decodeStableHostId("22222222-2222-4222-8222-222222222222");

function page(ownListEmpty: boolean, choose = vi.fn(async () => undefined)) {
  render(
    <TodoListHostSettingsContext.Provider
      value={{
        read: {
          status: "ready",
          view: decodeTodoListHostView({
            kind: "todo-list-host",
            thisHostId: THIS,
            choice: { kind: "this-host" },
            ownListEmpty,
          }),
        },
        computers: [{ hostId: STUDIO, name: "Studio Mac" }],
        choose,
      }}
    >
      <TodoListHostSettings />
    </TodoListHostSettingsContext.Provider>,
  );
  return choose;
}

describe("Settings › To-dos", () => {
  it("keeps the list on a paired computer the person picks", async () => {
    const user = userEvent.setup();
    const choose = page(true);
    await user.click(screen.getByRole("combobox", { name: "Keep the list on" }));
    await user.click(await screen.findByRole("option", { name: "Studio Mac" }));
    expect(choose).toHaveBeenCalledWith({ kind: "other-host", hostId: STUDIO, name: "Studio Mac" });
  });

  it("holds the list here while this computer keeps to-dos", () => {
    page(false);
    expect(screen.getByRole("combobox", { name: "Keep the list on" })).toBeDisabled();
    expect(screen.getByText(/already keeps to-dos, so the list stays here/)).toBeVisible();
  });
});
