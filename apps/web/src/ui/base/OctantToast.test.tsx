import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantToast } from "./OctantToast";

describe("OctantToast", () => {
  it("announces a compact notice with its details and can be dismissed by keyboard", async () => {
    const onDismiss = vi.fn();
    render(
      <OctantToast
        detail="The hand-off document for a long/project/path is ready."
        onDismiss={onDismiss}
        title="Workspace activity"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Workspace activity");
    expect(screen.getByRole("status")).toHaveTextContent("long/project/path");
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    dismiss.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("announces a danger notice immediately while keeping its message visible", () => {
    render(
      <OctantToast
        detail="The export failed."
        onDismiss={() => undefined}
        title="Export"
        tone="danger"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The export failed.");
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeVisible();
  });
});
