import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryEntryDialog } from "./MemoryEntryDialog";

describe("MemoryEntryDialog", () => {
  it("names a memory decision from its visible heading and explains what will be remembered", () => {
    render(
      <MemoryEntryDialog
        busy={false}
        mode={{ kind: "create" }}
        onClose={() => undefined}
        onCreate={async () => true}
        onRetract={async () => true}
        onSupersede={async () => true}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Add Project memory" });
    expect(dialog).toHaveAttribute(
      "aria-labelledby",
      screen.getByRole("heading", { name: "Add Project memory" }).id,
    );
    expect(dialog).toHaveAccessibleDescription(
      "Choose exactly what this Project may remember. Nothing is inferred from conversations.",
    );
  });
});
