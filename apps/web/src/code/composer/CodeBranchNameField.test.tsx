import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeBranchNameField } from "./CodeBranchNameField";

describe("CodeBranchNameField", () => {
  it("gives each field its own ids, so two composers on screen are not tied to each other", () => {
    render(
      <>
        <CodeBranchNameField
          chosen={false}
          onEdit={() => undefined}
          onSuggest={() => undefined}
          suggestDisabled={false}
          suggestion="idle"
          value="octant/one"
        />
        <CodeBranchNameField
          chosen={false}
          onEdit={() => undefined}
          onSuggest={() => undefined}
          suggestDisabled={false}
          suggestion="idle"
          value="octant/two"
        />
      </>,
    );
    const [first, second] = screen.getAllByRole("textbox", { name: "Branch name" });
    expect(first?.id).not.toBe("");
    expect(first?.id).not.toBe(second?.id);
    // Each label reaches its own input.
    expect(screen.getAllByLabelText("Branch name")).toEqual([first, second]);
  });

  it("ties the reason a typed name was refused to its field, and shows the name that stays", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn(() => "A branch with that name already exists.");
    render(
      <CodeBranchNameField
        chosen={false}
        onEdit={onEdit}
        suggestDisabled={false}
        suggestion="idle"
        value="octant/kept"
      />,
    );
    const field = screen.getByRole("textbox", { name: "Branch name" });
    await user.clear(field);
    await user.type(field, "taken");
    await user.tab();
    expect(field).toHaveValue("octant/kept");
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(
      '"taken" was not used. A branch with that name already exists.',
    );
  });
});
