import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copyText, TurnActionMenu } from "./TurnActionMenu";

const actions = [
  { label: "Branch from here", value: "branch" },
  { label: "Checkpoint", value: "checkpoint" },
  { label: "Copy references", value: "copy-references" },
] as const;

function menu(onAction = vi.fn()) {
  render(
    <TurnActionMenu actions={actions} onAction={onAction}>
      <p>Please summarize this.</p>
    </TurnActionMenu>,
  );
  return onAction;
}

describe("the turn action menu", () => {
  it("keeps secondary actions in one More actions control instead of as permanent text", () => {
    menu();

    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveClass("shell-icon-button");
    expect(trigger.className).not.toMatch(/\bbtn-icon\b/);
    expect(screen.queryByRole("button", { name: "Branch from here" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Checkpoint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy references" })).not.toBeInTheDocument();
  });

  it("opens the same actions from the keyboard and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onAction = menu();
    const trigger = screen.getByRole("button", { name: "More actions" });

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Branch from here" })).toHaveFocus(),
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("dismisses the open menu without firing an action and leaves the trigger focused", async () => {
    const user = userEvent.setup();
    const onAction = menu();
    const trigger = screen.getByRole("button", { name: "More actions" });

    await user.click(trigger);
    expect(await screen.findByRole("menuitemradio", { name: "Checkpoint" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onAction).not.toHaveBeenCalled();
  });

  it("mirrors the same actions on the platform context menu", async () => {
    const user = userEvent.setup();
    const onAction = menu();

    fireEvent.contextMenu(screen.getByText("Please summarize this."));
    expect(await screen.findByRole("menuitem", { name: "Branch from here" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Checkpoint" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Copy references" })).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "Copy references" }));
    expect(onAction).toHaveBeenCalledWith("copy-references");
  });

  it("dismisses the context menu on Escape without firing an action", async () => {
    const user = userEvent.setup();
    const onAction = menu();

    fireEvent.contextMenu(screen.getByText("Please summarize this."));
    expect(await screen.findByRole("menuitem", { name: "Branch from here" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Branch from here" })).not.toBeInTheDocument(),
    );
    expect(onAction).not.toHaveBeenCalled();
  });

  it("names the More actions control for a screen reader", () => {
    menu();
    expect(screen.getByRole("button", { name: "More actions" })).toHaveAccessibleName(
      "More actions",
    );
  });

  it("reserves the More actions control so hover and focus cannot shift the turn", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");
    const start = styles.indexOf(".turn-action-menu {");
    const end = styles.indexOf("/* ── Thread Search", start);
    const block = styles.slice(start, end);

    expect(block).toContain("position: absolute");
    expect(block).toMatch(/\.turn-action-menu:hover \.turn-action-menu__more/);
    expect(block).toMatch(/\.turn-action-menu:focus-within \.turn-action-menu__more/);
    expect(block).toContain("opacity: 0");
    expect(block).not.toContain("display: none");
    expect(block).toMatch(/@media \(max-width: 680px\)[\s\S]*opacity: 1/);
    expect(block).toMatch(/@media \(prefers-contrast: more\)[\s\S]*opacity: 1/);
  });

  it("writes the turn's references when the host exposes a clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });

    await copyText("Please summarize this.\nhttps://example.test/guide");

    expect(writeText).toHaveBeenCalledWith("Please summarize this.\nhttps://example.test/guide");
    vi.unstubAllGlobals();
  });
});
