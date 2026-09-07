import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WelcomeHeading } from "./WelcomeHeading";

afterEach(cleanup);

describe("WelcomeHeading", () => {
  it("leads the question with a greeting for the hour and the person's name", () => {
    render(
      <WelcomeHeading
        greetingName="Henrik"
        now={() => new Date(2026, 8, 6, 20, 15)}
        question="What should we build?"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Good evening, Henrik. What should we build?" }),
    ).toBeVisible();
  });

  it("keeps the plain question while the profile has no name", () => {
    render(
      <WelcomeHeading now={() => new Date(2026, 8, 6, 9, 0)} question="What should we build?" />,
    );
    expect(screen.getByRole("heading", { name: "What should we build?" })).toBeVisible();
  });
});
