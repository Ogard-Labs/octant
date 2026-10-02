import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WelcomeHeading } from "./WelcomeHeading";

afterEach(cleanup);

const evening = () => new Date(2026, 8, 30, 20, 15);
const dateLine = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
}).format(evening());

describe("WelcomeHeading", () => {
  it("says only the greeting for the hour and the person's name as the heading", () => {
    render(<WelcomeHeading greetingName="Henrik" now={evening} />);
    expect(screen.getByRole("heading", { name: "Good evening, Henrik" })).toBeVisible();
  });

  it("greets without a name while the profile has none", () => {
    render(<WelcomeHeading now={() => new Date(2026, 8, 6, 9, 0)} />);
    expect(screen.getByRole("heading", { name: "Good morning" })).toBeVisible();
  });

  it("puts the date, what is running, and what waits for review on one quiet line", () => {
    render(<WelcomeHeading now={evening} reviewCount={1} runningCount={2} />);
    expect(screen.getByText(`${dateLine} · 2 running · 1 waiting for your review`)).toBeVisible();
  });

  it("leaves a zero count out and falls back to the date alone", () => {
    const { rerender } = render(<WelcomeHeading now={evening} reviewCount={0} runningCount={3} />);
    expect(screen.getByText(`${dateLine} · 3 running`)).toBeVisible();
    rerender(<WelcomeHeading now={evening} reviewCount={0} runningCount={0} />);
    expect(screen.getByText(dateLine)).toBeVisible();
  });
});
