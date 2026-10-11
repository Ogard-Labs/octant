import type {
  DiscoverySnapshot,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModel,
  ProviderModelId,
  ProviderObservedState,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import { buildModelPickerGroups, type PickerGroup } from "@octant/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FirstRunOnboarding, type FirstRunOnboardingProps } from "./FirstRunOnboarding";
import { summarizeFirstRunReadiness } from "./firstRunReadinessModel";
import {
  useFirstRunOnboardingController,
  type FirstRunOnboardingController,
} from "./useFirstRunOnboardingController";

const now = "2026-07-21T10:00:00.000Z" as UtcTimestamp;
const instanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const instance = {
  id: instanceId,
  displayName: "Ollama",
  driverKind: "ollama",
  configuration: {
    kind: "ollama-native-http",
    baseUrl: "http://127.0.0.1:11434",
  },
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1 as never,
  createdAt: now,
  updatedAt: now,
} as ProviderInstance;

const modelId = "llama-test" as ProviderModelId;

function readyModel(): ProviderModel {
  return {
    id: modelId,
    displayName: "Llama Test",
    orderHint: undefined,
    reasoning: "unavailable",
    inputModalities: ["text"],
    options: [],
    source: "discovered",
    verification: "verified",
  } as ProviderModel;
}

function readyObserved(models: ReadonlyArray<ProviderModel> = [readyModel()]) {
  return {
    instanceId,
    readiness: "ready",
    processState: "running",
    models,
    capabilities: {},
    observedAt: now,
  } as unknown as ProviderObservedState;
}

function groupsFor(models: ReadonlyArray<ProviderModel>): ReadonlyArray<PickerGroup> {
  return buildModelPickerGroups({
    instances: [instance],
    observedByInstance: new Map([[instanceId, readyObserved(models)]]),
    // The surface offers whatever groups App built for the mode; how the
    // picker policy decides tool capability is covered with that policy.
    mode: "chat",
  });
}

function controller(
  overrides: Partial<FirstRunOnboardingController> = {},
): FirstRunOnboardingController {
  return {
    pending: true,
    visible: true,
    submitting: undefined,
    blockedMessage: undefined,
    refused: false,
    complete: vi.fn(),
    skip: vi.fn(),
    defer: vi.fn(),
    ...overrides,
  };
}

const codeProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProjectId;
const codeProject = {
  id: codeProjectId,
  name: "octant",
  type: "code" as const,
  lifecycle: "active" as const,
};

// A scan that ran to completion: only then may the surface claim this Mac has
// no provider on it.
const searchedThisMac = {
  scanning: false,
  snapshot: { status: "completed", candidates: [] } as unknown as DiscoverySnapshot,
} as const;

function cleanReadiness() {
  return summarizeFirstRunReadiness({
    providerStatus: "ready",
    instances: [instance],
    observedByInstance: new Map(),
    discovery: searchedThisMac,
  });
}

function baseProps(): FirstRunOnboardingProps {
  return {
    controller: controller(),
    readiness: cleanReadiness(),
    onOpenProviderSettings: vi.fn(),
    onRescan: vi.fn(),
    scanning: false,
    workEnabled: true,
    workModelGroups: [],
    codeModelGroups: [],
    onSelectModel: vi.fn(async () => true),
    projects: [],
    onCreateProject: vi.fn(),
    onStartThread: vi.fn(),
  };
}

function mount(overrides: Partial<FirstRunOnboardingProps> = {}) {
  const props: FirstRunOnboardingProps = { ...baseProps(), ...overrides };
  const view = render(<FirstRunOnboarding {...props} />);
  return {
    ...props,
    rerender: (next: Partial<FirstRunOnboardingProps>) =>
      view.rerender(<FirstRunOnboarding {...props} {...next} />),
  };
}

function railStep(title: "Providers" | "Project" | "Model") {
  // The rail step reads as its title followed by its summary; a bare title is
  // the readiness view's fact button, not the rail.
  return screen.getByRole("button", { name: (name) => name.startsWith(title) && name !== title });
}

async function openHandoff(user: ReturnType<typeof userEvent.setup>) {
  await user.click(railStep("Model"));
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

function readyHandoff(): Partial<FirstRunOnboardingProps> {
  return {
    codeModelGroups: groupsFor([readyModel()]),
    codeModel: { providerInstanceId: instanceId, modelId },
    projects: [codeProject],
    readiness: summarizeFirstRunReadiness({
      providerStatus: "ready",
      instances: [instance],
      observedByInstance: new Map([[instanceId, readyObserved()]]),
      discovery: searchedThisMac,
    }),
  };
}

describe("FirstRunOnboarding", () => {
  it("stays out of the way once the host has recorded an answer", () => {
    mount({ controller: controller({ visible: false }) });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for a provider, a Project, and a model, and leaves profile and Navigator to Settings", async () => {
    mount();

    const dialog = screen.getByRole("dialog", { name: "Welcome to Octant" });
    const heading = screen.getByRole("heading", { name: "Welcome to Octant" });
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(screen.getByText("Step 1 of 3")).toBeVisible();
    expect(railStep("Providers")).toHaveAttribute("aria-current", "step");
    expect(railStep("Project")).toBeVisible();
    expect(railStep("Model")).toBeVisible();
    expect(screen.queryByRole("button", { name: /About you|Workspace|Navigator/ })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Set up a provider" })).toHaveFocus(),
    );
  });

  it("walks providers, then Project, then model with Continue and back again", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Project" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Model" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Your first task" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Project" })).toBeVisible();
  });

  it("lets setup be skipped from the first step without starting work", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.click(screen.getByRole("button", { name: "Skip setup" }));

    await waitFor(() => expect(props.controller.skip).toHaveBeenCalledOnce());
    expect(props.onStartThread).not.toHaveBeenCalled();
    expect(props.onCreateProject).not.toHaveBeenCalled();
  });

  it("records the same durable skip when the dialog is dismissed", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(props.controller.skip).toHaveBeenCalledOnce());
  });

  it("chooses the first task's folder through the same Project create flow as the shell", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.click(railStep("Project"));
    expect(screen.getByRole("radio", { name: "Code" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Choose a folder…" }));
    expect(props.onCreateProject).toHaveBeenLastCalledWith("code");

    await user.click(screen.getByRole("radio", { name: "Work" }));
    await user.click(screen.getByRole("button", { name: "Choose a folder…" }));
    expect(props.onCreateProject).toHaveBeenLastCalledWith("work");
    // Opening Project create is a prerequisite round-trip, not an answer.
    expect(props.controller.complete).not.toHaveBeenCalled();
    expect(props.controller.skip).not.toHaveBeenCalled();
  });

  it("offers only Code when Work is turned off", async () => {
    const user = userEvent.setup();
    const props = mount({ workEnabled: false });

    await user.click(railStep("Project"));

    expect(screen.queryByRole("radiogroup", { name: "First task mode" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Choose a folder…" }));
    expect(props.onCreateProject).toHaveBeenCalledWith("code");
  });

  it("starts in the folder the user just chose rather than the first one listed", async () => {
    const user = userEvent.setup();
    const chosenId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as ProjectId;
    const props = mount(readyHandoff());

    await user.click(railStep("Project"));
    await user.click(screen.getByRole("button", { name: "Add another folder" }));
    // Project create resolves while first run is concealed; the new Project
    // arrives as one more row from the host.
    props.rerender({ projects: [codeProject, { ...codeProject, id: chosenId, name: "site" }] });

    expect(screen.getByRole("radio", { name: "site" })).toHaveAttribute("aria-checked", "true");
    await openHandoff(user);
    await user.click(screen.getByRole("button", { name: "Start a task" }));

    await waitFor(() =>
      expect(props.onStartThread).toHaveBeenCalledWith({ mode: "code", projectId: chosenId }),
    );
  });

  it("records the model for the mode the first task starts in", async () => {
    const user = userEvent.setup();
    const props = mount({ codeModelGroups: groupsFor([readyModel()]) });

    await user.click(railStep("Model"));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));

    expect(props.onSelectModel).toHaveBeenCalledWith("code", {
      providerInstanceId: instanceId,
      modelId,
    });
  });

  it("points back at providers instead of showing an empty picker", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.click(railStep("Model"));

    expect(screen.getByRole("status")).toHaveTextContent(
      "No provider on this Mac is ready, so there is nothing to choose from yet.",
    );
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open provider settings" }));
    expect(props.onOpenProviderSettings).toHaveBeenCalledOnce();
    // Sending the user elsewhere must not answer first run for them.
    expect(props.controller.complete).not.toHaveBeenCalled();
  });

  it("points back at providers when a reachable provider offered no models", async () => {
    const user = userEvent.setup();
    mount({ codeModelGroups: groupsFor([]) });

    await user.click(railStep("Model"));

    // The provider is enabled and answered, so it still gets a picker group.
    // What decides this step is whether there is a model to choose.
    expect(screen.getByRole("status")).toHaveTextContent(
      "No provider on this Mac offered a model, so there is nothing to choose from yet.",
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("waits for a model choice to land before recording completion", async () => {
    const user = userEvent.setup();
    let acceptSelection!: (accepted: boolean) => void;
    const onSelectModel = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acceptSelection = resolve;
        }),
    );
    const props = mount({ ...readyHandoff(), onSelectModel });

    await user.click(railStep("Model"));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Start a task" }));

    expect(props.controller.complete).not.toHaveBeenCalled();

    acceptSelection(true);
    await waitFor(() => expect(props.controller.complete).toHaveBeenCalledOnce());
    expect(props.onStartThread).toHaveBeenCalledWith({ mode: "code", projectId: codeProjectId });
  });

  it("waits for a provider switch to land before recording completion", async () => {
    const user = userEvent.setup();
    let acceptEnable!: (accepted: boolean) => void;
    const onSetProviderEnabled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acceptEnable = resolve;
        }),
    );
    const props = mount({ ...readyHandoff(), onSetProviderEnabled });

    // The discovered provider is on, so this switch turns it off; the wizard
    // waits on the write either way, and asserting the direction keeps the
    // fixture from drifting out from under the test.
    await user.click(screen.getByRole("switch", { name: "Enable Ollama" }));
    expect(onSetProviderEnabled).toHaveBeenCalledWith(instanceId, false);

    await openHandoff(user);
    await user.click(screen.getByRole("button", { name: "Start a task" }));

    expect(props.controller.complete).not.toHaveBeenCalled();

    acceptEnable(true);
    await waitFor(() => expect(props.controller.complete).toHaveBeenCalledOnce());
  });

  it("keeps first run pending when a model choice is rejected", async () => {
    const user = userEvent.setup();
    const props = mount({ ...readyHandoff(), onSelectModel: vi.fn(async () => false) });

    await user.click(railStep("Model"));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Start a task" }));

    await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
    expect(props.controller.complete).not.toHaveBeenCalled();
  });

  it("lets the user answer again after a rejected write, without being held by it", async () => {
    const user = userEvent.setup();
    const onSelectModel = vi
      .fn<FirstRunOnboardingProps["onSelectModel"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const props = mount({ codeModelGroups: groupsFor([readyModel()]), onSelectModel });

    await user.click(railStep("Model"));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));
    await user.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(props.controller.skip).not.toHaveBeenCalled();

    // The discarded write must not hold the surface shut for the rest of the
    // session; answering again has to be able to resolve first run.
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));
    await user.click(screen.getByRole("button", { name: "Skip setup" }));

    await waitFor(() => expect(props.controller.skip).toHaveBeenCalledOnce());
  });

  it("says a refused answer was not kept, then lets the next press continue without it", async () => {
    const user = userEvent.setup();
    const props = mount({
      codeModelGroups: groupsFor([readyModel()]),
      onSelectModel: vi.fn(async () => false),
    });

    await user.click(railStep("Model"));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));
    await user.click(screen.getByRole("button", { name: "Skip setup" }));

    // The first press records nothing, because the answer the user just gave
    // is gone, but it must not look like a dead button.
    expect(await screen.findByText(/did not keep one of your answers/)).toBeVisible();
    expect(props.controller.skip).not.toHaveBeenCalled();

    // Refusing again with no new answer would trap Skip setup for as long as the
    // host kept refusing; the user has now been told, so this press goes on.
    await user.click(screen.getByRole("button", { name: "Skip setup" }));

    await waitFor(() => expect(props.controller.skip).toHaveBeenCalledOnce());
  });

  it("finishes with a task after a refused answer has been acknowledged", async () => {
    const user = userEvent.setup();
    const props = mount({ ...readyHandoff(), onSelectModel: vi.fn(async () => false) });

    await user.click(railStep("Model"));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Start a task" }));
    expect(await screen.findByText(/did not keep one of your answers/)).toBeVisible();
    expect(props.controller.complete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Start a task" }));

    await waitFor(() => expect(props.controller.complete).toHaveBeenCalledOnce());
    expect(props.onStartThread).toHaveBeenCalledWith({ mode: "code", projectId: codeProjectId });
  });

  it("says when the host did not record the outcome itself", () => {
    mount({ controller: controller({ refused: true }) });

    expect(screen.getByText(/The host did not record that/)).toBeVisible();
  });

  it("waits for an answer given while the first ones are still settling", async () => {
    const user = userEvent.setup();
    let acceptEnable!: (accepted: boolean) => void;
    const onSetProviderEnabled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acceptEnable = resolve;
        }),
    );
    const onSelectModel = vi.fn(async () => false);
    const props = mount({ ...readyHandoff(), onSelectModel, onSetProviderEnabled });

    await user.click(screen.getByRole("switch", { name: "Enable Ollama" }));
    await openHandoff(user);
    await user.click(screen.getByRole("button", { name: "Start a task" }));

    // Only the footer is disabled while this settles, so the rail and the
    // picker still answer. A choice made here is written after the wait
    // started, and completing without it would lose it for good.
    await user.click(railStep("Model"));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));
    acceptEnable(true);

    await waitFor(() => expect(onSelectModel).toHaveBeenCalledOnce());
    expect(props.controller.complete).not.toHaveBeenCalled();
  });

  it("offers Start a task only after the setup steps, and opens that Project's composer", async () => {
    const user = userEvent.setup();
    const props = mount(readyHandoff());

    expect(screen.queryByRole("button", { name: "Start a task" })).toBeNull();

    await openHandoff(user);
    expect(screen.getByText("octant")).toBeVisible();
    expect(screen.getByText("Llama Test on Ollama")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start a task" }));

    await waitFor(() => expect(props.controller.complete).toHaveBeenCalledOnce());
    expect(props.onStartThread).toHaveBeenCalledWith({ mode: "code", projectId: codeProjectId });
  });

  it("releases the modal when it sends the user to provider settings", async () => {
    const user = userEvent.setup();
    const onOpenProviderSettings = vi.fn();
    const resolve = vi.fn(async () => true);

    function Harness() {
      const [concealed, setConcealed] = useState(false);
      const live = useFirstRunOnboardingController({
        onboarding: "pending",
        shellStatus: "ready",
        resolve,
        concealed,
      });
      return (
        <FirstRunOnboarding
          {...baseProps()}
          controller={live}
          onOpenProviderSettings={() => {
            onOpenProviderSettings();
            setConcealed(true);
          }}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Set up a provider" }));

    expect(onOpenProviderSettings).toHaveBeenCalledOnce();
    // The dialog is modal, so leaving it open traps focus over the provider
    // settings this very action opened.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Concealing answers nothing on the user's behalf: the host still reports
    // first run as pending, so backing out of Settings does not lose it.
    expect(resolve).not.toHaveBeenCalled();
    // Focus is released to a live element rather than stranded on the removed
    // dialog.
    expect(document.activeElement?.isConnected).toBe(true);
  });

  it("returns to the same readiness draft after a missing prerequisite's setup closes", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [concealed, setConcealed] = useState(false);
      const live = useFirstRunOnboardingController({
        onboarding: "pending",
        shellStatus: "ready",
        resolve: vi.fn(async () => true),
        concealed,
      });
      return (
        <>
          <FirstRunOnboarding
            {...baseProps()}
            controller={live}
            onCreateProject={() => setConcealed(true)}
            onOpenProviderSettings={() => setConcealed(true)}
          />
          {concealed ? (
            <button onClick={() => setConcealed(false)} type="button">
              Close setup
            </button>
          ) : null}
        </>
      );
    }
    render(<Harness />);

    await openHandoff(user);
    expect(screen.getByText("No Code folder yet. A task starts in a Project.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Close setup" }));
    expect(screen.getByRole("dialog", { name: "Welcome to Octant" })).toBeVisible();
    expect(screen.getByText("No Code folder yet. A task starts in a Project.")).toBeVisible();
  });

  it("titles the readiness view and does not count it as a fourth setup step", async () => {
    const user = userEvent.setup();
    mount(readyHandoff());

    await user.click(railStep("Model"));
    expect(screen.getByText("Step 3 of 3")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Your first task" })).toBeVisible();
    expect(screen.queryByText(/^Step \d of \d$/)).toBeNull();
  });

  it("does not start a task or fabricate readiness when first run is skipped", async () => {
    const user = userEvent.setup();
    const props = mount(readyHandoff());

    await openHandoff(user);
    await user.click(screen.getByRole("button", { name: "Skip setup" }));

    await waitFor(() => expect(props.controller.skip).toHaveBeenCalledOnce());
    expect(props.controller.complete).not.toHaveBeenCalled();
    expect(props.onStartThread).not.toHaveBeenCalled();
  });

  describe("against a host that keeps the outcome it is sent", () => {
    function renderAgainstHost() {
      const recorded: Array<"completed" | "skipped"> = [];
      const onStartThread = vi.fn();
      function Harness() {
        const [onboarding, setOnboarding] = useState<"pending" | "completed" | "skipped">(
          "pending",
        );
        const live = useFirstRunOnboardingController({
          onboarding,
          shellStatus: "ready",
          resolve: async (outcome) => {
            recorded.push(outcome);
            setOnboarding(outcome);
            return true;
          },
        });
        return (
          <FirstRunOnboarding
            {...baseProps()}
            {...readyHandoff()}
            controller={live}
            onStartThread={onStartThread}
          />
        );
      }
      render(<Harness />);
      return { recorded, onStartThread };
    }

    it("closes and records completion when Start a task opens the first task", async () => {
      const user = userEvent.setup();
      const { recorded, onStartThread } = renderAgainstHost();

      await openHandoff(user);
      await user.click(screen.getByRole("button", { name: "Start a task" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(recorded).toEqual(["completed"]);
      expect(onStartThread).toHaveBeenCalledWith({ mode: "code", projectId: codeProjectId });
    });

    it("closes and records the skip from the final step", async () => {
      const user = userEvent.setup();
      const { recorded, onStartThread } = renderAgainstHost();

      await openHandoff(user);
      await user.click(screen.getByRole("button", { name: "Skip setup" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(recorded).toEqual(["skipped"]);
      expect(onStartThread).not.toHaveBeenCalled();
    });
  });

  it("blocks answering while the host cannot record it and says so", async () => {
    const user = userEvent.setup();
    mount({
      controller: controller({ blockedMessage: "Octant cannot reach the host right now." }),
    });

    expect(screen.getByRole("alert")).toHaveTextContent("cannot reach the host");
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeDisabled();

    await openHandoff(user);
    expect(screen.getByRole("button", { name: "Set up a provider" })).toBeDisabled();
  });

  it("shows which answer is in flight without offering a second one", async () => {
    const user = userEvent.setup();
    mount({ controller: controller({ submitting: "completed" }) });

    await openHandoff(user);

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeDisabled();
  });

  it("marks a step configured only once the host holds a real answer", async () => {
    const user = userEvent.setup();
    mount({ ...readyHandoff(), codeModel: undefined, projects: [] });

    expect(railStep("Providers")).toHaveAttribute("data-configured", "true");
    // Walking past a step is not the same fact as answering it.
    await user.click(railStep("Project"));
    await user.click(railStep("Model"));
    expect(railStep("Project")).toHaveAttribute("data-configured", "false");
    expect(railStep("Model")).toHaveAttribute("data-configured", "false");
  });

  it("marks the current setup step and leaves unanswered steps pending", async () => {
    const user = userEvent.setup();
    mount(readyHandoff());

    const providers = railStep("Providers");
    const project = railStep("Project");
    expect(providers).toHaveAttribute("data-progress", "current");
    expect(providers).toHaveAttribute("aria-current", "step");
    expect(providers.querySelector(".sr-only")).toBeNull();

    await user.click(project);

    expect(providers).toHaveAttribute("data-progress", "completed");
    expect(project).toHaveAttribute("data-progress", "current");
    expect(project).toHaveAttribute("aria-current", "step");
    expect(providers).not.toHaveAttribute("aria-current");
    expect(providers.querySelector(".sr-only")).toHaveTextContent("Configured");
  });

  it("reports provider, Project, and model separately on a clean host", async () => {
    const user = userEvent.setup();
    const props = mount();

    await openHandoff(user);

    expect(screen.getByText("No provider is ready yet")).toBeVisible();
    expect(screen.getByText("No Code folder yet. A task starts in a Project.")).toBeVisible();
    expect(screen.getByText("No model this host can use in Code yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Set up a provider" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Project" }));
    expect(props.onCreateProject).toHaveBeenCalledWith("code");
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("heading", { name: "Model" })).toBeVisible();
    expect(props.controller.complete).not.toHaveBeenCalled();
    expect(props.onStartThread).not.toHaveBeenCalled();
  });
});
