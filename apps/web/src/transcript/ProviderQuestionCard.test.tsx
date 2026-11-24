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

describe("choosing a provider question's option by number", () => {
  const options = [
    { label: "Allow isolated test pairing" },
    { label: "Keep existing pairings only" },
  ];

  it("picks the option whose number is pressed inside the card, and sends nothing until Submit", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<ProviderQuestionCard onAnswer={onAnswer} options={options} prompt="May I pair?" />);
    const first = screen.getByRole("radio", { name: "Allow isolated test pairing" });
    first.focus();
    await user.keyboard("2");
    const second = screen.getByRole("radio", { name: "Keep existing pairings only" });
    expect(second).toHaveAttribute("aria-checked", "true");
    expect(second).toHaveFocus();
    expect(onAnswer).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("Keep existing pairings only");
  });

  it("still picks by number once focus has moved to Submit", async () => {
    const user = userEvent.setup();
    render(<ProviderQuestionCard onAnswer={vi.fn()} options={options} prompt="May I pair?" />);
    await user.click(screen.getByRole("radio", { name: "Allow isolated test pairing" }));
    screen.getByRole("button", { name: "Submit" }).focus();
    await user.keyboard("2");
    expect(screen.getByRole("radio", { name: "Keep existing pairings only" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps digits typed into the answer field as text", async () => {
    const user = userEvent.setup();
    render(<ProviderQuestionCard onAnswer={vi.fn()} options={options} prompt="May I pair?" />);
    await user.click(screen.getByRole("radio", { name: "Type your own answer" }));
    const field = screen.getByLabelText("Your answer");
    await user.type(field, "12");
    expect(field).toHaveValue("12");
    expect(screen.getByRole("radio", { name: "Type your own answer" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
