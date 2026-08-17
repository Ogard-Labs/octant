import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderModel,
  ProviderModelId,
  ProviderObservedState,
  UtcTimestamp,
} from "@octant/contracts";
import type { UserProfile } from "@octant/contracts/user-profile";
import { buildModelPickerGroups, type PickerGroup } from "@octant/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AvatarImageEnvironment } from "../profile/avatarImage";
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

function readyGroups(): ReadonlyArray<PickerGroup> {
  const model = {
    id: modelId,
    displayName: "Llama Test",
    orderHint: undefined,
    reasoning: "unavailable",
    inputModalities: ["text"],
    options: [],
    source: "discovered",
    verification: "verified",
  } as ProviderModel;
  const observed = {
    instanceId,
    readiness: "ready",
    processState: "running",
    models: [model],
    capabilities: {},
    observedAt: now,
  } as unknown as ProviderObservedState;
  return buildModelPickerGroups({
    instances: [instance],
    observedByInstance: new Map([[instanceId, observed]]),
    mode: "chat",
  });
}

function controller(
  overrides: Partial<FirstRunOnboardingController> = {},
): FirstRunOnboardingController {
  return {
    visible: true,
    submitting: undefined,
    blockedMessage: undefined,
    complete: vi.fn(),
    skip: vi.fn(),
    defer: vi.fn(),
    ...overrides,
  };
}

const emptyProfile: UserProfile = { accent: "indigo", avatar: { kind: "initials" } };
const encodedAvatar = "data:image/webp;base64,AAAA";
const defaultWorkspace = {
  colorScheme: "system",
  chatEnabled: true,
  workEnabled: true,
  modeSwitcher: "buttons",
} as const;

function mount(overrides: Partial<FirstRunOnboardingProps> = {}) {
  const props: FirstRunOnboardingProps = {
    controller: controller(),
    readiness: summarizeFirstRunReadiness({
      providerStatus: "ready",
      instances: [instance],
      observedByInstance: new Map(),
    }),
    onOpenProviderSettings: vi.fn(),
    onRescan: vi.fn(),
    scanning: false,
    profile: emptyProfile,
    onSaveProfile: vi.fn(),
    chatModelGroups: [],
    onSelectChatDefault: vi.fn(),
    navigatorModelGroups: [],
    onSelectNavigatorDefault: vi.fn(),
    onClearNavigatorDefault: vi.fn(),
    workspace: defaultWorkspace,
    onSelectColorScheme: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleWork: vi.fn(),
    onSelectModeSwitcher: vi.fn(),
    ...overrides,
  };
  const view = render(<FirstRunOnboarding {...props} />);
  return {
    ...props,
    rerender: (next: Partial<FirstRunOnboardingProps>) =>
      view.rerender(<FirstRunOnboarding {...props} {...next} />),
  };
}

function avatarEnvironment(
  overrides: Partial<AvatarImageEnvironment> = {},
): AvatarImageEnvironment {
  return {
    decode: vi.fn(async () => ({ width: 200, height: 200 })),
    encode: vi.fn(async () => ({ dataUrl: encodedAvatar })),
    fetch: vi.fn(async () => new Response("binary", { status: 200 })),
    digest: vi.fn(async () => "hashed"),
    ...overrides,
  };
}

async function goToStep(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(name) }));
}

describe("FirstRunOnboarding", () => {
  it("stays out of the way once the host has recorded an answer", () => {
    mount({ controller: controller({ visible: false }) });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the profile step with the first field focused", async () => {
    mount();

    expect(screen.getByRole("dialog", { name: "Welcome to Octant" })).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
    // No account, no sign-in: the surface has to say so, because every other
    // app that asks for a name and an address is asking for an account.
    expect(screen.getByText(/no account and signs you in to nothing/)).toBeVisible();
  });

  it("saves the profile when the step is left, not on every keystroke", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.type(screen.getByLabelText("Name"), "Ada");
    expect(props.onSaveProfile).not.toHaveBeenCalled();

    await goToStep(user, "Continue");

    expect(props.onSaveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ada" }),
    );
  });

  it("keeps a settled answer for someone who quits the app on the first step", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.tab();

    // Quitting the app is not one of this dialog's exits, so waiting for
    // Continue or Skip would lose a name the user had already finished giving.
    expect(props.onSaveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ada" }),
    );
  });

  it("never saves a name the user typed past and can no longer see", async () => {
    const user = userEvent.setup();
    const props = mount();

    // Typed one character at a time, the 64th character makes a storable name
    // and the 65th makes the field invalid.
    await user.type(screen.getByLabelText("Name"), "A".repeat(65));
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    // Skipping still records what was answered, but the 64-character prefix is
    // not an answer: the user never settled on it and the field stopped showing
    // it. Saving it here would journal a name that exists nowhere on screen.
    expect(props.onSaveProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ displayName: expect.anything() }),
    );
  });

  it("walks forward and back without losing the draft", async () => {
    const user = userEvent.setup();
    mount();

    await user.type(screen.getByLabelText("Name"), "Ada");
    await goToStep(user, "Continue");
    await goToStep(user, "Continue");
    expect(screen.getByRole("button", { name: "Set up a provider" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
  });

  it("writes each workspace choice straight through to the setting that owns it", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.click(screen.getByRole("button", { name: /Workspace/ }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(screen.getByRole("switch", { name: "Enable Work" }));

    expect(props.onSelectColorScheme).toHaveBeenCalledWith("dark");
    expect(props.onToggleWork).toHaveBeenCalledWith(false);
    // Code has no switch: it is always available, and offering one that cannot
    // be turned off would say otherwise.
    expect(screen.queryByRole("switch", { name: /Code/ })).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(
      /Turning Chat or Work off only hides the mode/,
    );
  });

  it("does not claim a colour scheme while appearance settings are still loading", async () => {
    const user = userEvent.setup();
    mount({ workspace: { ...defaultWorkspace, colorScheme: undefined } });

    await user.click(screen.getByRole("button", { name: /Workspace/ }));

    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/still loading its appearance settings/);
  });

  it("records the default Chat model from what the host actually found", async () => {
    const user = userEvent.setup();
    const props = mount({ chatModelGroups: readyGroups() });

    await user.click(screen.getByRole("button", { name: /Default model/ }));
    await user.click(screen.getByRole("option", { name: /Llama Test/ }));

    expect(props.onSelectChatDefault).toHaveBeenCalledWith({
      providerInstanceId: instanceId,
      modelId,
    });
  });

  it("points back at providers instead of showing an empty picker", async () => {
    const user = userEvent.setup();
    const props = mount({ chatModelGroups: [] });

    await user.click(screen.getByRole("button", { name: /Default model/ }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "No provider on this Mac is ready, so there is nothing to choose from yet.",
    );
    await user.click(screen.getByRole("button", { name: "Open provider settings" }));
    expect(props.onOpenProviderSettings).toHaveBeenCalledOnce();
    // Sending the user elsewhere must not answer first run for them.
    expect(props.controller.complete).not.toHaveBeenCalled();
  });

  it("says what staying without Navigator costs, and lets the user turn it off", async () => {
    const user = userEvent.setup();
    const props = mount({
      navigatorModelGroups: readyGroups(),
      navigatorDefault: { providerInstanceId: instanceId, modelId },
    });

    await user.click(screen.getByRole("button", { name: /Navigator/ }));
    await user.click(screen.getByRole("button", { name: "Leave Navigator off" }));

    expect(props.onClearNavigatorDefault).toHaveBeenCalledOnce();
  });

  it("offers completion only at the end, and saves an unsaved profile with it", async () => {
    const user = userEvent.setup();
    const props = mount();

    expect(screen.queryByRole("button", { name: "Start using Octant" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Navigator/ }));
    await user.click(screen.getByRole("button", { name: "Start using Octant" }));

    expect(props.controller.complete).toHaveBeenCalledOnce();
  });

  it("keeps a name the user typed even when they skip the rest of first run", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    // Skipping declines the remaining setup; it does not throw away an answer
    // the user already gave.
    expect(props.onSaveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ada" }),
    );
    expect(props.controller.skip).toHaveBeenCalledOnce();
  });

  it("shows the profile the host turns out to hold, not the one it started with", () => {
    const stored: UserProfile = {
      displayName: "Ada",
      accent: "indigo",
      avatar: { kind: "initials" },
    };
    const view = mount();

    // This surface can be up before the store has answered. Someone who filled
    // in a name, quit part-way, and relaunched would otherwise be shown an
    // empty field, and their next edit would overwrite the journaled answer.
    view.rerender({ profile: stored });

    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
  });

  it("waits for an avatar import before letting first run be answered", async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => undefined;
    const props = mount({
      avatarEnvironment: avatarEnvironment({
        fetch: vi.fn(
          async () => await new Promise<Response>((resolve) => (release = resolve)),
        ) as unknown as typeof fetch,
      }),
    });

    await user.type(screen.getByLabelText("Email (optional)"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Use Gravatar" }));

    // The import reports its picture as a later change. Answering first run
    // now would hide this surface before that change ever arrived.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Skip for now" })).toBeDisabled(),
    );

    // Escape reaches the same answer without touching a button, so guarding
    // only the footer would still lose the picture.
    await user.keyboard("{Escape}");
    expect(props.controller.skip).not.toHaveBeenCalled();

    // So does walking the rail to a step that hands the user to Settings: it
    // flushes the profile on the way out and unmounts the editor that was
    // about to report the picture.
    await user.click(screen.getByRole("button", { name: /Providers/ }));
    expect(screen.getByLabelText("Email (optional)")).toBeVisible();
    expect(props.controller.defer).not.toHaveBeenCalled();

    release(new Response("binary", { status: 200 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(props.onSaveProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: { kind: "image", source: "gravatar", dataUrl: encodedAvatar },
      }),
    );
  });

  it("does not write a profile the user never touched", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.click(screen.getByRole("button", { name: /Navigator/ }));
    await user.click(screen.getByRole("button", { name: "Start using Octant" }));

    expect(props.onSaveProfile).not.toHaveBeenCalled();
    expect(props.controller.complete).toHaveBeenCalledOnce();
  });

  it("releases the modal when it sends the user to provider settings", async () => {
    const user = userEvent.setup();
    const onOpenProviderSettings = vi.fn();
    const resolve = vi.fn(async () => {});

    function Harness() {
      const live = useFirstRunOnboardingController({
        onboarding: "pending",
        shellStatus: "ready",
        resolve,
      });
      return (
        <FirstRunOnboarding
          chatModelGroups={[]}
          controller={live}
          navigatorModelGroups={[]}
          onClearNavigatorDefault={vi.fn()}
          onOpenProviderSettings={onOpenProviderSettings}
          onRescan={vi.fn()}
          onSaveProfile={vi.fn()}
          onSelectChatDefault={vi.fn()}
          onSelectColorScheme={vi.fn()}
          onSelectModeSwitcher={vi.fn()}
          onSelectNavigatorDefault={vi.fn()}
          onToggleChat={vi.fn()}
          onToggleWork={vi.fn()}
          profile={emptyProfile}
          readiness={summarizeFirstRunReadiness({
            providerStatus: "ready",
            instances: [instance],
            observedByInstance: new Map(),
          })}
          scanning={false}
          workspace={defaultWorkspace}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /Providers/ }));
    await user.click(screen.getByRole("button", { name: "Set up a provider" }));

    expect(onOpenProviderSettings).toHaveBeenCalledOnce();
    // The dialog is modal, so leaving it open traps focus over the provider
    // settings this very action opened.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Deferring answers nothing on the user's behalf: the host still reports
    // first run as pending, so backing out of Settings does not lose it.
    expect(resolve).not.toHaveBeenCalled();
    // Focus is released to a live element rather than stranded on the removed
    // dialog (`SHELL-03`).
    expect(document.activeElement?.isConnected).toBe(true);
  });

  it("records the same durable skip when the dialog is dismissed", async () => {
    const user = userEvent.setup();
    const props = mount();

    await user.keyboard("{Escape}");

    expect(props.controller.skip).toHaveBeenCalledOnce();
  });

  it("blocks answering while the host cannot record it and says so", async () => {
    const user = userEvent.setup();
    mount({
      controller: controller({ blockedMessage: "Octant cannot reach the host right now." }),
    });

    expect(screen.getByRole("alert")).toHaveTextContent("cannot reach the host");
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Navigator/ }));
    expect(screen.getByRole("button", { name: "Start using Octant" })).toBeDisabled();
  });

  it("shows which answer is in flight without offering a second one", async () => {
    const user = userEvent.setup();
    mount({ controller: controller({ submitting: "completed" }) });

    await user.click(screen.getByRole("button", { name: /Navigator/ }));

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDisabled();
  });

  it("marks a step configured only once the host holds a real answer", async () => {
    const user = userEvent.setup();
    mount({ profile: { ...emptyProfile, displayName: "Ada Lovelace" } });

    const profileStep = screen.getByRole("button", { name: /About you/ });
    expect(profileStep).toHaveAttribute("data-configured", "true");
    // Walking past a step is not the same fact as answering it.
    expect(screen.getByRole("button", { name: /Navigator/ })).toHaveAttribute(
      "data-configured",
      "false",
    );

    await user.click(screen.getByRole("button", { name: /Navigator/ }));
    expect(screen.getByRole("button", { name: /Navigator/ })).toHaveAttribute(
      "data-configured",
      "false",
    );
  });
});
