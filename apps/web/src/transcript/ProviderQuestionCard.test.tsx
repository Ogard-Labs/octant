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

  it("sends a secret with its leading and trailing spaces, but not a blank one", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<ProviderQuestionCard onAnswer={onAnswer} options={[]} prompt="Passphrase?" secret />);
    const field = screen.getByLabelText("Your secret answer");
    const submit = screen.getByRole("button", { name: "Submit" });
    await user.type(field, "   ");
    expect(submit).toBeDisabled();
    await user.clear(field);
    await user.type(field, " three words ");
    await user.click(submit);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(" three words ");
  });
});
