import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CredentialRequestCard as Card } from "@octant/contracts/credential-request";
import { CredentialRequestCard } from "./CredentialRequestCard";

const card: Card = {
  id: "00000000-0000-4000-8000-000000000001",
  threadId: "thread",
  label: "Linear API token",
  reason: "Check that this token can access your Linear account.",
  consumer: "Linear",
  destination: "https://api.linear.app",
  actionLabel: "Check access",
  state: "pending",
};
describe("credential card", () => {
  it("submits from the keyboard once and clears the masked input", async () => {
    const user = userEvent.setup();
    const answer = vi.fn(async () => true);
    render(<CredentialRequestCard card={card} answer={answer} />);
    const input = screen.getByLabelText("Linear API token", { selector: "input" });
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "private-token{Enter}");
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer).toHaveBeenCalledWith({ id: card.id, action: "allow", secret: "private-token" });
    expect(input).toHaveValue("");
    expect(screen.queryByText("private-token")).not.toBeInTheDocument();
  });
  it("declines without sending the draft secret", async () => {
    const user = userEvent.setup();
    const answer = vi.fn(async () => true);
    render(<CredentialRequestCard card={card} answer={answer} />);
    await user.type(
      screen.getByLabelText("Linear API token", { selector: "input" }),
      "private-token",
    );
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(answer).toHaveBeenCalledWith({ id: card.id, action: "decline" });
  });
  it("does not replay an uncertain submission and collapses when the host settles it", async () => {
    const user = userEvent.setup();
    const answer = vi.fn(async () => {
      throw new Error("private-token");
    });
    const view = render(<CredentialRequestCard card={card} answer={answer} />);
    await user.type(
      screen.getByLabelText("Linear API token", { selector: "input" }),
      "private-token",
    );
    await user.click(screen.getByRole("button", { name: "Check access" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private-token");
    expect(answer).toHaveBeenCalledTimes(1);
    view.rerender(<CredentialRequestCard card={{ ...card, state: "used" }} answer={answer} />);
    expect(
      screen.queryByLabelText("Linear API token", { selector: "input" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Token not saved");
  });
  it("lets the person reveal a token and masks it again on submission", async () => {
    const user = userEvent.setup();
    render(<CredentialRequestCard card={card} answer={async () => true} />);
    const input = screen.getByLabelText("Linear API token", { selector: "input" });
    await user.type(input, "dummy-token");
    await user.click(screen.getByRole("button", { name: "Show token" }));
    expect(input).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Check access" }));
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
  });
  it("keeps an accepted submission disabled until the host publishes its outcome", async () => {
    const user = userEvent.setup();
    render(<CredentialRequestCard card={card} answer={async () => true} />);
    const input = screen.getByLabelText("Linear API token", { selector: "input" });
    await user.type(input, "dummy-token{Enter}");
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check access" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for confirmation");
  });
});
