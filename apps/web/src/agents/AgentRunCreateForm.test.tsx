import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRunCreateForm } from "./AgentRunCreateForm";

describe("AgentRunCreateForm", () => {
  it("renders an explanatory status instead of fields when posture is Off", () => {
    render(<AgentRunCreateForm posture="off" onSubmit={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/posture is Off/i);
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
  });

  it("submits explicit role, task, provider, model, and authority facts", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AgentRunCreateForm posture="automatic" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Task"), "Review the open PR diff.");
    await user.type(
      screen.getByLabelText("Provider instance ID"),
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    await user.type(screen.getByLabelText("Model ID"), "gpt-4o");
    await user.click(screen.getByLabelText("Filesystem"));
    await user.click(screen.getByRole("button", { name: "Create subagent" }));

    expect(onSubmit).toHaveBeenCalledWith({
      role: "research",
      task: "Review the open PR diff.",
      providerInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      modelId: "gpt-4o",
      authority: {
        filesystem: true,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
    });
  });

  it("asks for the parent thread's context only when the user selects it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AgentRunCreateForm posture="automatic" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Task"), "Summarise what we decided.");
    await user.type(
      screen.getByLabelText("Provider instance ID"),
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    await user.type(screen.getByLabelText("Model ID"), "gpt-4o");
    // The default is off: a child is admitted with its task alone unless the
    // user says the parent conversation belongs in it.
    await user.click(screen.getByRole("button", { name: "Create subagent" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("includeParentContext");

    await user.click(screen.getByLabelText("Include this thread\u2019s recent conversation"));
    await user.click(screen.getByRole("button", { name: "Create subagent" }));

    expect(onSubmit.mock.calls[1]?.[0]).toMatchObject({ includeParentContext: true });
  });

  it("offers only the research role and an authority proposal Chat can admit by default", () => {
    render(<AgentRunCreateForm posture="automatic" onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("Role")).toHaveValue("research");
    expect(screen.getByRole("option", { name: "research" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "implementation" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Network")).not.toBeChecked();
  });

  it("shows an Ask-posture confirmation hint and surfaces a denial error", () => {
    render(
      <AgentRunCreateForm posture="ask" errorMessage="Posture rejected." onSubmit={vi.fn()} />,
    );
    expect(screen.getByText(/explicit confirmation/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Posture rejected.");
  });

  it("disables submission while a creation request is in flight", () => {
    render(<AgentRunCreateForm posture="automatic" submitting onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });
});
