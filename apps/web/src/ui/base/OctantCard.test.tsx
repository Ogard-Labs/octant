import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OctantCard } from "./OctantCard";

describe("a card's material", () => {
  it("keeps the page card opaque and ringed by default", () => {
    render(<OctantCard aria-label="Plain" />);
    const card = screen.getByLabelText("Plain");
    expect(card).toHaveAttribute("data-variant", "default");
    expect(card.className).toContain("bg-card");
  });

  it("hands a glass card over unpainted, for the static system to dress", () => {
    render(<OctantCard aria-label="Frosted" variant="glass" />);
    const card = screen.getByLabelText("Frosted");
    expect(card).toHaveAttribute("data-variant", "glass");
    // The ladder has one definition (octant.css, 0107). A second copy in
    // utilities here is what this asserts against.
    expect(card.className).not.toContain("bg-card");
    expect(card.className).not.toContain("ring-");
  });

  it("dresses a glass card only where the engine can draw the blur, and drops it for reduced transparency", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/octant.css"), "utf8");
    const glass = '\\[data-slot="card"\\]\\[data-variant="glass"\\]';
    // Opaque first: where no blur can be drawn, text would land on the
    // person's photograph directly.
    expect(styles).toMatch(
      new RegExp(`${glass}\\s*\\{[^}]*background:\\s*var\\(--oct-surface\\);`, "s"),
    );
    expect(styles).toMatch(
      new RegExp(
        `@supports \\(backdrop-filter[^{]*\\{(?:[^@]|@(?!supports))*?${glass}\\s*\\{[^}]*background-color:\\s*var\\(--oct-glass-floor\\);`,
        "s",
      ),
    );
    expect(styles).toMatch(
      new RegExp(`data-octant-reduced-transparency="true"\\](?:[^{]*,)*[^{]*${glass}\\s*\\{`, "s"),
    );
    expect(styles).toMatch(
      new RegExp(`@media \\(prefers-reduced-transparency: reduce\\)(?:[^@])*?${glass}`, "s"),
    );
  });
});
