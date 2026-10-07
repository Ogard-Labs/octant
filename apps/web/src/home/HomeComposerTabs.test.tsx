import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { HomeComposerTabs } from "./HomeComposerTabs";

function Composer() {
  const [draft, setDraft] = useState("");
  return (
    <textarea
      aria-label="Prompt"
      onChange={(event) => setDraft(event.target.value)}
      value={draft}
    />
  );
}

function renderTabs(runningCount: number) {
  return render(
    <HomeComposerTabs slot={{ runningCount, running: <p>Running list</p> }}>
      <Composer />
    </HomeComposerTabs>,
  );
}

describe("the start-screen composer tabs", () => {
  it("opens on New task with the composer showing and the Running list not mounted", () => {
    renderTabs(2);
    expect(screen.getByRole("tab", { name: "New task" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeVisible();
    expect(screen.queryByText("Running list")).toBeNull();
  });

  it("names the Running count on its tab and says nothing at zero", () => {
    const { unmount } = renderTabs(3);
    expect(screen.getByRole("tab", { name: "Running 3" })).toBeVisible();
    unmount();
    renderTabs(0);
    expect(screen.getByRole("tab", { name: "Running" })).toBeVisible();
  });

  it("keeps what was typed when the person looks at Running and comes back", async () => {
    const user = userEvent.setup();
    renderTabs(1);
    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Refactor the router");

    await user.click(screen.getByRole("tab", { name: "Running 1" }));
    expect(screen.getByText("Running list")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Prompt", hidden: true })).not.toBeVisible();

    await user.click(screen.getByRole("tab", { name: "New task" }));
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Refactor the router");
  });

  it("is a tablist the keyboard drives, with Tab going on to the composer", async () => {
    const user = userEvent.setup();
    renderTabs(1);
    expect(screen.getByRole("tablist", { name: "Start" })).toBeVisible();

    screen.getByRole("tab", { name: "New task" }).focus();
    // Tab leaves the tablist for the composer itself, not for the panel around it.
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("tab", { name: "New task" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Running 1" })).toHaveFocus();
    // Moving between tabs only moves focus; Enter chooses.
    expect(screen.getByRole("tab", { name: "New task" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("tab", { name: "Running 1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Running list")).toBeVisible();
  });

  it("leaves the composer on its own when the screen has no Running tab", () => {
    render(
      <HomeComposerTabs slot={undefined}>
        <Composer />
      </HomeComposerTabs>,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeVisible();
  });
});
