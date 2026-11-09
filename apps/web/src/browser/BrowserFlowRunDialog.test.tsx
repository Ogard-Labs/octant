import type {
  BrowserFlowsCommand,
  BrowserFlowsResult,
  BrowserFlowRun,
  BrowserFlowSummary,
} from "@octant/contracts/browser-flows";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserFlowRunDialog } from "./BrowserFlowRunDialog";
const projectId = "10000000-0000-4000-8000-000000000001" as never;
const task = {
  threadId: "10000000-0000-4000-8000-000000000002" as never,
  mode: "code" as const,
  title: "Check form",
  modelId: "synthetic-model" as never,
  accessLabel: "Ask first",
  profileLabel: "Private",
};
const flow: BrowserFlowSummary = {
  projectId,
  projectLabel: "Site",
  name: "Fill form",
  stepCount: 1,
  savedAt: "2026-11-07T10:00:00.000Z" as never,
};
const run: BrowserFlowRun = {
  id: "10000000-0000-4000-8000-000000000003" as never,
  projectId,
  task,
  flow: {
    name: flow.name,
    savedAt: flow.savedAt,
    steps: [
      {
        operation: "type",
        input: { operation: "type", ref: "e1", text: "saved value" },
        targets: { ref: { role: "textbox", name: "Message" } },
        expect: { path: "/form" },
      },
    ],
  },
  state: "review",
  completed: 0,
  expiresAt: "2026-11-07T10:15:00.000Z" as never,
};

describe("reviewing a saved Browser flow", () => {
  it("requires an explicit existing task and a separate reviewed start with run-specific text", async () => {
    const user = userEvent.setup();
    const manageFlows = vi.fn(
      async (command: BrowserFlowsCommand): Promise<BrowserFlowsResult> =>
        command.kind === "run-tasks"
          ? { kind: "browser-flow-tasks", tasks: [task] }
          : {
              kind: "browser-flow-run",
              run:
                command.kind === "start-run" ? { ...run, state: "completed", completed: 1 } : run,
            },
    );
    render(<BrowserFlowRunDialog client={{ manageFlows }} flow={flow} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Review run" })).toBeDisabled();
    await user.click(await screen.findByRole("combobox", { name: "Task to run this flow" }));
    await user.click(await screen.findByRole("option", { name: "Check form · Code" }));
    await user.click(screen.getByRole("button", { name: "Review run" }));
    const input = await screen.findByRole("textbox", { name: "Text for step 1" });
    expect(manageFlows).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/synthetic-model.*Ask first.*Private/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "this run only");
    await user.click(screen.getByRole("button", { name: "Run fixed steps" }));
    await waitFor(() =>
      expect(manageFlows).toHaveBeenCalledWith({
        kind: "start-run",
        runId: run.id,
        values: [{ step: 0, text: "this run only" }],
      }),
    );
    expect(await screen.findByText("1 of 1 steps completed.")).toBeInTheDocument();
  });

  it("ignores a previous host client's pending review after the client changes", async () => {
    const user = userEvent.setup();
    const oldReview = Promise.withResolvers<BrowserFlowsResult>();
    const oldClient = {
      manageFlows: vi.fn(
        async (command: BrowserFlowsCommand): Promise<BrowserFlowsResult> =>
          command.kind === "run-tasks"
            ? { kind: "browser-flow-tasks", tasks: [task] }
            : oldReview.promise,
      ),
    };
    const onClose = vi.fn();
    const view = render(<BrowserFlowRunDialog client={oldClient} flow={flow} onClose={onClose} />);
    await user.click(await screen.findByRole("combobox", { name: "Task to run this flow" }));
    await user.click(await screen.findByRole("option", { name: "Check form · Code" }));
    await user.click(screen.getByRole("button", { name: "Review run" }));
    const nextClient = {
      manageFlows: vi.fn(
        async (): Promise<BrowserFlowsResult> => ({
          kind: "browser-flow-tasks",
          tasks: [{ ...task, title: "New host task" }],
        }),
      ),
    };
    view.rerender(<BrowserFlowRunDialog client={nextClient} flow={flow} onClose={onClose} />);
    oldReview.resolve({ kind: "browser-flow-run", run });
    await waitFor(() => expect(screen.getByRole("button", { name: "Review run" })).toBeDisabled());
    expect(screen.queryByRole("textbox", { name: "Text for step 1" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Task to run this flow" }));
    expect(await screen.findByRole("option", { name: "New host task · Code" })).toBeInTheDocument();
  });

  it("does not retry an uncertain start and inspects before another action", async () => {
    const user = userEvent.setup();
    const manageFlows = vi.fn(async (command: BrowserFlowsCommand): Promise<BrowserFlowsResult> => {
      if (command.kind === "run-tasks") return { kind: "browser-flow-tasks", tasks: [task] };
      if (command.kind === "start-run") throw Error("Connection lost");
      return {
        kind: "browser-flow-run",
        run: command.kind === "inspect-run" ? { ...run, state: "paused" } : run,
      };
    });
    const view = render(
      <BrowserFlowRunDialog client={{ manageFlows }} flow={flow} onClose={vi.fn()} />,
    );
    await user.click(await screen.findByRole("combobox", { name: "Task to run this flow" }));
    await user.click(await screen.findByRole("option", { name: "Check form · Code" }));
    await user.click(screen.getByRole("button", { name: "Review run" }));
    await user.click(await screen.findByRole("button", { name: "Run fixed steps" }));
    await user.click(await screen.findByRole("button", { name: "Check run" }));
    expect(manageFlows.mock.calls.filter(([command]) => command.kind === "start-run")).toHaveLength(
      1,
    );
    expect(manageFlows).toHaveBeenCalledWith({ kind: "inspect-run", runId: run.id });
    expect(await screen.findByRole("button", { name: "Resume" })).toBeEnabled();
    view.unmount();
    expect(manageFlows).toHaveBeenCalledWith({ kind: "cancel-run", runId: run.id });
  });
});
