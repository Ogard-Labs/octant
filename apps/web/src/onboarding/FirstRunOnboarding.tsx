import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { NavigatorAssistantModelRef } from "@octant/contracts/navigator-assistant";
import type { UserProfile } from "@octant/contracts/user-profile";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { isProfileConfigured } from "@octant/domain";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { ProfileEditor } from "../profile/ProfileEditor";
import type { AvatarImageEnvironment } from "../profile/avatarImage";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { FirstRunModelStep } from "./FirstRunModelStep";
import { FirstRunProviderStep } from "./FirstRunProviderStep";
import type { FirstRunDiscoveryNotice, FirstRunReadinessSummary } from "./firstRunReadinessModel";
import { FirstRunWorkspaceStep } from "./FirstRunWorkspaceStep";
import {
  buildFirstRunSteps,
  isLastFirstRunStep,
  isWorkspaceConfigured,
  nextFirstRunStep,
  previousFirstRunStep,
  type FirstRunStepId,
  type WorkspaceChoices,
} from "./firstRunStepModel";
import type { FirstRunOnboardingController } from "./useFirstRunOnboardingController";
import "./first-run.css";

export interface FirstRunChatDefault {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

export interface FirstRunOnboardingProps {
  readonly controller: FirstRunOnboardingController;
  readonly readiness: FirstRunReadinessSummary;
  readonly discoveryNotice?: FirstRunDiscoveryNotice;
  readonly onOpenProviderSettings: () => void;
  readonly onRescan: () => void;
  readonly scanning: boolean;

  /** The profile the host currently holds. The step edits a draft of it. */
  readonly profile: UserProfile;
  /** Persist the edited profile. Called when the profile step is left, not per keystroke. */
  readonly onSaveProfile: (profile: UserProfile) => void;
  readonly avatarEnvironment?: AvatarImageEnvironment;

  readonly chatModelGroups: ReadonlyArray<PickerGroup>;
  readonly chatDefault?: FirstRunChatDefault | undefined;
  readonly onSelectChatDefault: (selection: ModelPickerSelection) => void;

  readonly navigatorModelGroups: ReadonlyArray<PickerGroup>;
  readonly navigatorDefault?: NavigatorAssistantModelRef | undefined;
  readonly onSelectNavigatorDefault: (selection: ModelPickerSelection) => void;
  readonly onClearNavigatorDefault: () => void;

  readonly workspace: WorkspaceChoices;
  readonly onSelectColorScheme: (scheme: "system" | "light" | "dark") => void;
  readonly onToggleChat: (enabled: boolean) => void;
  readonly onToggleWork: (enabled: boolean) => void;
  readonly onSelectModeSwitcher: (presentation: "buttons" | "dropdown") => void;
}

/**
 * Octant's first-run surface (`BOOT-01`).
 *
 * It exists to get a new user from a clean launch to an ordinary Chat composer
 * without a hidden prerequisite. Four steps — profile, providers, default
 * model, Navigator — and not one of them is a gate: any of them can be walked
 * past, and the surface states what stays unavailable rather than refusing to
 * continue. The steps are freely navigable in both directions, because a user
 * who sets up a provider on step two must be able to go back to step three's
 * model list without restarting.
 *
 * Answers are recorded as they are made, so quitting mid-way keeps what was
 * already chosen; only the first-run *outcome* is recorded at the end.
 * Dismissing the dialog records the same durable "skipped" outcome as the
 * button, so first run never silently repeats.
 *
 * Sending the user to provider settings closes this surface. A modal that
 * stays open over the destination it just opened traps focus away from the
 * action it advertised, and the only alternative — recording an answer the
 * user did not give — would hide first run from someone who simply backed out
 * of Settings.
 */
export function FirstRunOnboarding(props: FirstRunOnboardingProps) {
  const { controller } = props;
  const [step, setStep] = useState<FirstRunStepId>("profile");
  const [profileDraft, setProfileDraft] = useState<UserProfile>(props.profile);
  const [profileEdited, setProfileEdited] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const providerAction = useRef<HTMLButtonElement>(null);
  const busy = controller.submitting !== undefined;
  const blocked = controller.blockedMessage !== undefined;

  if (!controller.visible) return null;

  const steps = buildFirstRunSteps({
    current: step,
    profileConfigured: isProfileConfigured(profileDraft),
    workspaceConfigured: isWorkspaceConfigured(props.workspace),
    providersReady: props.readiness.overall === "ready",
    chatDefaultConfigured: props.chatDefault !== undefined,
    navigatorConfigured: props.navigatorDefault !== undefined,
  });

  /**
   * Commit the draft, once, if there is anything to commit.
   *
   * Writing on every keystroke would journal a settings replacement per
   * character; writing only at the very end would lose the name of someone who
   * quits on step three. So the draft is flushed whenever the profile step is
   * left and whenever first run is answered — including when it is *skipped*,
   * because a name the user typed is a name they gave, and dropping it would
   * make skipping the rest destroy an answer they already made.
   */
  function flushProfile() {
    if (!profileEdited) return;
    setProfileEdited(false);
    props.onSaveProfile(profileDraft);
  }

  function goTo(target: FirstRunStepId) {
    if (step === "profile" && target !== "profile") flushProfile();
    setStep(target);
  }

  function finish() {
    flushProfile();
    controller.complete();
  }

  function skip() {
    flushProfile();
    controller.skip();
  }

  const back = previousFirstRunStep(step);
  const forward = nextFirstRunStep(step);

  return (
    <OctantDialog
      className="first-run"
      initialFocus={step === "profile" ? nameField : providerAction}
      label="Welcome to Octant"
      onClose={skip}
      open
    >
      <div className="first-run__body">
        <nav aria-label="Setup steps" className="first-run__rail">
          <h2 className="first-run__title">Welcome to Octant</h2>
          <ol className="first-run__rail-list">
            {steps.map((descriptor) => (
              <li key={descriptor.id}>
                <button
                  aria-current={descriptor.current ? "step" : undefined}
                  className="first-run__rail-step"
                  data-configured={descriptor.configured}
                  onClick={() => goTo(descriptor.id)}
                  type="button"
                >
                  <span className="first-run__rail-marker" aria-hidden>
                    {descriptor.configured ? <Check size={13} /> : null}
                  </span>
                  <span className="first-run__rail-title">{descriptor.title}</span>
                  <span className="first-run__rail-summary">{descriptor.summary}</span>
                  {descriptor.configured ? <span className="sr-only">Configured</span> : null}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <div className="first-run__panel">
          {step === "profile" ? (
            <div className="first-run__step">
              <p className="first-run__intro">
                Octant has no account and signs you in to nothing. This is only how you want to be
                shown inside the app, and all of it is optional.
              </p>
              <ProfileEditor
                nameRef={nameField}
                onChange={(next) => {
                  setProfileEdited(true);
                  setProfileDraft(next);
                }}
                profile={profileDraft}
                {...(props.avatarEnvironment === undefined
                  ? {}
                  : { environment: props.avatarEnvironment })}
              />
            </div>
          ) : null}

          {step === "workspace" ? (
            <FirstRunWorkspaceStep
              choices={props.workspace}
              onSelectColorScheme={props.onSelectColorScheme}
              onSelectModeSwitcher={props.onSelectModeSwitcher}
              onToggleChat={props.onToggleChat}
              onToggleWork={props.onToggleWork}
            />
          ) : null}

          {step === "providers" ? (
            <FirstRunProviderStep
              onOpenProviderSettings={() => {
                props.onOpenProviderSettings();
                // This modal must not stay over the settings it just opened,
                // and it must not answer for the user either: deferring leaves
                // the host's status `pending`, so someone who backs out of
                // Settings still meets first run on the next launch.
                controller.defer();
              }}
              onRescan={props.onRescan}
              readiness={props.readiness}
              ref={providerAction}
              scanning={props.scanning}
              {...(props.discoveryNotice === undefined
                ? {}
                : { discoveryNotice: props.discoveryNotice })}
            />
          ) : null}

          {step === "default-model" ? (
            <FirstRunModelStep
              ariaLabel="Default model for new Chat threads"
              groups={props.chatModelGroups}
              intro="New Chat threads start with this model. Existing threads always keep whatever they were given."
              onOpenProviderSettings={() => {
                props.onOpenProviderSettings();
                controller.defer();
              }}
              onSelect={props.onSelectChatDefault}
              unsetNote="No default is set. Octant will pick a ready model for each new thread and show you which one it chose."
              {...(props.chatDefault === undefined
                ? {}
                : {
                    selectedModelId: props.chatDefault.modelId,
                    selectedProviderInstanceId: props.chatDefault.providerInstanceId,
                  })}
            />
          ) : null}

          {step === "navigator" ? (
            <FirstRunModelStep
              ariaLabel="Navigator default model"
              clearLabel="Leave Navigator off"
              groups={props.navigatorModelGroups}
              intro="Navigator is the optional assistant in the sidebar. It answers questions about Octant itself and never changes anything without asking you first."
              onClear={props.onClearNavigatorDefault}
              onOpenProviderSettings={() => {
                props.onOpenProviderSettings();
                controller.defer();
              }}
              onSelect={props.onSelectNavigatorDefault}
              unsetNote="Navigator stays unavailable until a model is chosen. Nothing else is affected, and you can turn it on later in Settings."
              {...(props.navigatorDefault === undefined
                ? {}
                : {
                    selectedModelId: props.navigatorDefault.modelId,
                    selectedProviderInstanceId: props.navigatorDefault.providerInstanceId,
                  })}
            />
          ) : null}
        </div>

        {controller.blockedMessage === undefined ? null : (
          <p className="first-run__notice" data-tone="attention" role="alert">
            {controller.blockedMessage}
          </p>
        )}

        <footer className="first-run__actions">
          <div className="first-run__buttons">
            {back === undefined ? null : (
              <OctantButton onClick={() => goTo(back)} type="button" variant="ghost">
                Back
              </OctantButton>
            )}
            <OctantButton disabled={busy || blocked} onClick={skip} type="button" variant="ghost">
              {controller.submitting === "skipped" ? "Skipping…" : "Skip for now"}
            </OctantButton>
            {isLastFirstRunStep(step) || forward === undefined ? (
              <OctantButton disabled={busy || blocked} onClick={finish} type="button">
                {controller.submitting === "completed" ? "Saving…" : "Start using Octant"}
              </OctantButton>
            ) : (
              <OctantButton onClick={() => goTo(forward)} type="button">
                Continue
              </OctantButton>
            )}
          </div>
        </footer>
      </div>
    </OctantDialog>
  );
}
