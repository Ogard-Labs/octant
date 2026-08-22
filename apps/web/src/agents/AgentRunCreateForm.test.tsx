import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunControlResolvedFacts } from "@octant/contracts";
import { AgentRunCreateForm } from "./AgentRunCreateForm";

const chatFacts: AgentRunControlResolvedFacts = {
  mode: "chat",
  allowedRoles: ["research"],
  providerInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
  modelId: "gpt-4o" as never,
  reasoning: "high",
  workspaceKind: "chat-virtual",
  authority: {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: true,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  executionKind: "octant-managed",
  attemptedExecutionKind: "provider-native",
  nativeFallbackReason: "nativeChildAgents-claimed-unsupported",
  capabilityDegradations: ["native-child-agents-unavailable"],
  creationPosture: "automatic",
};

const codeFacts: AgentRunControlResolvedFacts = {
  mode: "code",
  allowedRoles: ["implementation", "review"],
  providerInstanceId: chatFacts.providerInstanceId,
  modelId: chatFacts.modelId,
  workspaceKind: "code-worktree",
  authority: {
    ...chatFacts.authority,
    filesystem: true,
    shell: true,
    git: true,
    network: true,
    executionPolicy: "approval-gated",
  },
  executionKind: "provider-native",
  attemptedExecutionKind: "provider-native",
  capabilityDegradations: [],
  creationPosture: "automatic",
};

describe("AgentRunCreateForm", () => {
  it("renders an explanatory status instead of fields when posture is Off", () => {
    render(<AgentRunCreateForm posture="off" onSubmit={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/posture is Off/i);
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
  });

  it("submits a role and task without provider, model, or authority inputs", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AgentRunCreateForm facts={chatFacts} posture="automatic" onSubmit={onSubmit} />);

    expect(screen.queryByLabelText("Provider instance ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model ID")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Filesystem" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Task"), "Review the open PR diff.");
    await user.click(screen.getByRole("button", { name: "Create subagent" }));

    expect(onSubmit).toHaveBeenCalledWith({
      role: "research",
      task: "Review the open PR diff.",
    });
  });

  it("shows resolved facts read-only including Octant-managed fallback", () => {
    render(<AgentRunCreateForm facts={chatFacts} posture="automatic" onSubmit={vi.fn()} />);
    const facts = screen.getByRole("region", { name: "Resolved child facts" });
    expect(facts).toHaveTextContent("Research-only virtual workspace");
    expect(facts).toHaveTextContent("gpt-4o");
    expect(facts).toHaveTextContent("Octant-managed");
    expect(screen.getByRole("status")).toHaveTextContent(/Native execution is ineligible/i);
  });

  it("offers Implement and Review for Code and shows an isolated worktree", async () => {
    const user = userEvent.setup();
    const onRoleChange = vi.fn();
    render(
      <AgentRunCreateForm
        facts={codeFacts}
        posture="automatic"
        onRoleChange={onRoleChange}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Implement" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Research" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Resolved child facts" })).toHaveTextContent(
      "Confirmed isolated worktree",
    );
    await user.selectOptions(screen.getByLabelText("Role"), "review");
    expect(onRoleChange).toHaveBeenCalledWith("review");
  });

  it("asks for the parent thread's context only when the user selects it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<AgentRunCreateForm facts={chatFacts} posture="automatic" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Task"), "Summarise what we decided.");
    await user.click(screen.getByRole("button", { name: "Create subagent" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("includeParentContext");
    await user.click(screen.getByLabelText("Include this thread\u2019s recent conversation"));
    await user.click(screen.getByRole("button", { name: "Create subagent" }));
    expect(onSubmit.mock.calls[1]?.[0]).toMatchObject({ includeParentContext: true });
  });

  it("shows an Ask-posture confirmation hint and surfaces a denial error", () => {
    render(
      <AgentRunCreateForm
        facts={chatFacts}
        posture="ask"
        errorMessage="Posture rejected."
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText(/explicit confirmation/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Posture rejected.");
  });

  it("disables submission while a creation request is in flight", () => {
    render(
      <AgentRunCreateForm facts={chatFacts} posture="automatic" submitting onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });
});
