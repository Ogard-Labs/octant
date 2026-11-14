import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WelcomeHeading } from "./WelcomeHeading";

afterEach(cleanup);

describe("WelcomeHeading", () => {
  it("asks one question and says where to begin, without a greeting or counts", () => {
    render(<WelcomeHeading />);
    expect(screen.getByRole("heading", { name: "What are we building today?" })).toBeVisible();
    expect(screen.getByText("Pick a Project, or just start typing")).toBeVisible();
    expect(screen.queryByText(/running|waiting for your review|Good (morning|evening)/)).toBeNull();
  });

  it("stops asking for a project once one is chosen", () => {
    render(<WelcomeHeading projectChosen />);
    expect(screen.getByText("Just start typing")).toBeVisible();
    expect(screen.queryByText(/Pick a Project/)).toBeNull();
  });

  it("asks the general question when no Project is chosen", () => {
    render(<WelcomeHeading projectName="   " />);
    expect(screen.getByRole("heading", { name: "What are we building today?" })).toBeVisible();
  });

  it("names the chosen Project in the question and keeps the full name available", () => {
    render(<WelcomeHeading projectChosen projectName="Octant" />);
    expect(
      screen.getByRole("heading", { name: "What should we work on in Octant?" }),
    ).toBeVisible();
    expect(screen.getByTitle("Octant")).toHaveTextContent("Octant");
    expect(screen.queryByText("What are we building today?")).toBeNull();
  });

  it("keeps a very long Project name whole in the markup so CSS can truncate it to one line", () => {
    const name = "A very long Project name that would never fit on the one line of the question";
    render(<WelcomeHeading projectChosen projectName={name} />);
    expect(screen.getByTitle(name)).toHaveTextContent(name);
    expect(screen.getByRole("heading")).toHaveClass("welcome__question--project");
  });

  it("changes the words in place when another Project is chosen", () => {
    const { rerender } = render(<WelcomeHeading projectChosen projectName="One" />);
    const heading = screen.getByRole("heading");
    rerender(<WelcomeHeading projectChosen projectName="Two" />);
    expect(screen.getByRole("heading")).toBe(heading);
    expect(heading).toHaveTextContent("What should we work on in Two?");
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
