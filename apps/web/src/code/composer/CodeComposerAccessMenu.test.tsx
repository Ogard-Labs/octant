import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeComposerAccessMenu } from "./CodeComposerAccessMenu";

describe("CodeComposerAccessMenu", () => {
  it("names the current access posture and reports a change", () => {
    const onChange = vi.fn();
    render(<CodeComposerAccessMenu onChange={onChange} value="approval-gated" />);

    const trigger = screen.getByRole("button", { name: "Access policy" });
    expect(trigger).toHaveTextContent("Approval");
    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: /Full access/ })).toHaveTextContent(
      "Allow commands and edits without prompts.",
    );
    fireEvent.click(screen.getByRole("option", { name: /Full access/ }));

    expect(onChange).toHaveBeenCalledWith("full-access");
  });

  it("lets the posture be remembered for the Project from the same menu", () => {
    const onPersistenceChange = vi.fn();
    render(
      <CodeComposerAccessMenu
        onChange={() => {}}
        onPersistenceChange={onPersistenceChange}
        persistence="current-session"
        value="full-access"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Access policy" }));
    const remember = screen.getByRole("switch", { name: "Remember access for this Project" });
    expect(remember).not.toBeChecked();
    fireEvent.click(remember);

    expect(onPersistenceChange).toHaveBeenCalledWith("project-default");
  });
});
