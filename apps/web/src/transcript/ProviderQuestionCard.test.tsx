import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderQuestionCard } from "./ProviderQuestionCard";

describe("a provider question asking for a secret", () => {
  it("takes the answer in a masked field the person may reveal, and submits what was typed", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(
      <ProviderQuestionCard
        onAnswer={onAnswer}
        options={[]}
        prompt="Database credential?"
        secret
      />,
    );
    const field = screen.getByLabelText("Your secret answer");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(screen.getByText(/does not save it or add it to the thread/u)).toBeInTheDocument();
    await user.type(field, "hunter2");
    await user.click(screen.getByRole("button", { name: "Show answer" }));
    expect(field).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("hunter2");
  });
});
