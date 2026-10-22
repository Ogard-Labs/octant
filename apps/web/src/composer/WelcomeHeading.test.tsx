import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WelcomeHeading } from "./WelcomeHeading";

afterEach(cleanup);

describe("WelcomeHeading", () => {
  it("asks one question and says where to begin, without a greeting or counts", () => {
    render(<WelcomeHeading />);
    expect(screen.getByRole("heading", { name: "What are we building today?" })).toBeVisible();
    expect(screen.getByText("Pick a project, or just start typing")).toBeVisible();
    expect(screen.queryByText(/running|waiting for your review|Good (morning|evening)/)).toBeNull();
  });

  it("draws the aperture mark at 22px above the question", () => {
    const { container } = render(<WelcomeHeading />);
    const mark = container.querySelector("svg.welcome__mark");
    expect(mark).toHaveAttribute("width", "22");
    expect(mark).toHaveAttribute("height", "22");
    expect(mark?.querySelector("use")).toHaveAttribute("href", "./icons.svg#aperture");
    expect(mark?.nextElementSibling).toBe(screen.getByRole("heading"));
  });
});
