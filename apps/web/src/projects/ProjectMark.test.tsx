import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectMark, projectMarkHue, projectMarkInitials } from "./ProjectMark";

describe("ProjectMark", () => {
  it("takes two letters from a Project's name", () => {
    expect(projectMarkInitials("Aurora Docs")).toBe("AD");
    expect(projectMarkInitials("auroradocs-mcp")).toBe("AM");
    expect(projectMarkInitials("Ferie")).toBe("FE");
    expect(projectMarkInitials("Æble")).toBe("ÆB");
    expect(projectMarkInitials("---")).toBe("");
  });

  it("gives the same Project the same colour every time, and different Projects different ones", () => {
    expect(projectMarkHue("project-a")).toBe(projectMarkHue("project-a"));
    expect(projectMarkHue("project-a")).not.toBe(projectMarkHue("project-b"));
    expect(projectMarkHue("project-a")).toBeLessThan(360);
  });

  it("draws the initials on the Project's hue, and a neutral folder for a thread with no Project", () => {
    const { container, rerender } = render(<ProjectMark name="Harbor" projectId="p-1" />);
    const mark = container.querySelector<HTMLElement>(".project-mark");
    expect(mark).toHaveTextContent("HA");
    expect(mark?.style.getPropertyValue("--project-mark-hue")).toBe(String(projectMarkHue("p-1")));

    rerender(<ProjectMark name="No Project" />);
    expect(container.querySelector(".project-mark")).toHaveAttribute("data-neutral", "true");
  });
});
