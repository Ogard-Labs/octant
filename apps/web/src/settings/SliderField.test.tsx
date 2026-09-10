import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SliderField } from "./SliderField";

describe("SliderField", () => {
  it("says where the slider is, so a value can be returned to", () => {
    render(
      <SliderField
        aria-label="Pattern opacity"
        format={(value) => `${String(value)}%`}
        max={100}
        min={0}
        onChange={() => undefined}
        value={42}
      />,
    );

    // A label, a track, and a 12px thumb told a person nothing about whether
    // they had set 40 or 60, and gave them no way back to what they had.
    expect(screen.getByRole("slider", { name: "Pattern opacity" })).toHaveValue("42");
    expect(screen.getByText("42%")).toBeVisible();
  });

  it("reads the number plainly when the field has no unit", () => {
    render(<SliderField aria-label="Sidebar width" onChange={() => undefined} value={280} />);

    expect(screen.getByText("280")).toBeVisible();
  });
});
