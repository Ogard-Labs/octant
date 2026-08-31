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
});
