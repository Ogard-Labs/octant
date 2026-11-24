import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ProjectThreadRows } from "./ProjectThreadList";

vi.mock("./ThreadRowInfoCard", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

it("names the thread and keeps the sidebar when the info card cannot load", async () => {
  const user = userEvent.setup();
  render(
    <ProjectThreadRows
      onSelectThread={vi.fn()}
      threads={[
        {
          threadId: "thread-one",
          title: "Controller foundation",
          provider: { displayName: "Claude", driverKind: "claude" },
        },
      ]}
    />,
  );

  await user.hover(screen.getByRole("button", { name: /Controller foundation/ }));

  const card = await screen.findByRole("group", { name: "Thread details" });
  await waitFor(() => expect(card).toHaveTextContent("Controller foundation"));
  expect(screen.getByRole("button", { name: /Controller foundation/ })).toBeVisible();
});
