import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeComposerAccessMenu } from "./CodeComposerAccessMenu";

describe("CodeComposerAccessMenu", () => {
  it("names the current access posture and reports a change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CodeComposerAccessMenu onChange={onChange} value="approval-gated" />);

    const trigger = screen.getByRole("button", { name: "Access policy" });
    expect(trigger).toHaveTextContent("Ask for approvals");
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitemradio", { name: "Full access" }));

    expect(onChange).toHaveBeenCalledWith("full-access");
  });

  it("lets the posture be remembered for the Project from the same menu", async () => {
    const user = userEvent.setup();
    const onPersistenceChange = vi.fn();
    render(
      <CodeComposerAccessMenu
        onChange={() => {}}
        onPersistenceChange={onPersistenceChange}
        persistence="current-session"
        value="full-access"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Access policy" }));
    const remember = await screen.findByRole("menuitemcheckbox", {
      name: "Remember for this Project",
    });
    expect(remember).not.toBeChecked();
    await user.click(remember);

    expect(onPersistenceChange).toHaveBeenCalledWith("project-default");
  });

  it("opens from the keyboard on the current posture, not on the first one", async () => {
    const user = userEvent.setup();
    render(<CodeComposerAccessMenu onChange={() => {}} value="auto-accept-edits" />);

    screen.getByRole("button", { name: "Access policy" }).focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: "Auto-accept edits" })).toHaveFocus(),
    );
  });
});
