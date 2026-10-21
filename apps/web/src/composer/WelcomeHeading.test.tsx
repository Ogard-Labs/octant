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
});
