import {
  acpAgentProfile,
  isAcpAgentKind,
  type AcpAgentAuthentication,
  type ClaudeAuthentication,
  type DiscoverySnapshot,
  type ProviderInstance,
} from "@octant/contracts";
import { offeredAcpAuthentication } from "../configuration/AcpConfigurationForms";
import type { ProviderCreateProviderType } from "../configuration/ProviderCreateForm";
import { driverLabel } from "../providerSettingsPresentation";

/** The steps of the wizard, in order. The account exists from "connect" on. */
export const WIZARD_STEPS = ["provider", "sign-in", "details", "connect", "done"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_STEP_LABELS: Readonly<Record<WizardStep, string>> = {
  provider: "Provider",
  "sign-in": "Sign-in",
  details: "Details",
  connect: "Connect",
  done: "Done",
};

export interface WizardProviderCard {
  readonly type: ProviderCreateProviderType;
  readonly name: string;
  readonly description: string;
  /** Why this provider cannot be added here, when it cannot. */
  readonly unavailable?: string;
  /** What the host found: a runtime on its search path or none. */
  readonly found: boolean;
}

export interface WizardSignInChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly needsKey: boolean;
  /** What the secret field is called when it is not the choice's own label. */
  readonly keyLabel?: string;
}

/** The label a provider card and the footer's "Add <provider>" button carry. */
export function wizardProviderName(type: ProviderCreateProviderType): string {
  return driverLabel(type as ProviderInstance["driverKind"]);
}

export function wizardProviderDescription(type: ProviderCreateProviderType): string {
  if (isAcpAgentKind(type)) {
    const profile = acpAgentProfile(type);
    return `${profile.name} over the Agent Client Protocol. Octant runs your installed ${profile.executable} CLI.`;
  }
  switch (type) {
    case "claude":
      return "Anthropic's Claude through the Agent SDK. Sign in with a subscription, an API key, or a gateway.";
    case "codex":
      return "OpenAI's coding agent. Octant runs your installed codex CLI with its own sign-in.";
    case "opencode":
      return "The open-source coding agent. Octant runs your installed opencode CLI.";
    case "pi":
      return "The Pi coding agent over RPC. Octant runs your installed pi CLI with its own sign-in.";
    case "oh-my-pi":
      return "Oh My Pi (omp) over RPC, kept distinct from Pi. Uses its own sign-in.";
    default:
      return "A provider Octant runs or calls for you.";
  }
}

/** The binary Octant would start from: an existing account's, else the scan's. */
export function detectedBinaryPath(
  type: ProviderCreateProviderType,
  instances: ReadonlyArray<ProviderInstance>,
  snapshot: DiscoverySnapshot | undefined,
): string | undefined {
  const existing = instances.find(
    (instance) =>
      String(instance.driverKind) === String(type) && "binaryPath" in instance.configuration,
  );
  if (existing !== undefined && "binaryPath" in existing.configuration) {
    return existing.configuration.binaryPath;
  }
  return snapshot?.candidates.find((candidate) => String(candidate.driverKind) === String(type))
    ?.binaryPath;
}

export function wizardProviderCards(input: {
  readonly types: ReadonlyArray<ProviderCreateProviderType>;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly snapshot: DiscoverySnapshot | undefined;
  readonly credentialManagementAvailable: boolean;
}): ReadonlyArray<WizardProviderCard> {
  return input.types.map((type) => {
    const keyOnly =
      isAcpAgentKind(type) &&
      offeredAcpAuthentication(type).length > 0 &&
      offeredAcpAuthentication(type).every((posture) => posture === "api-key");
    return {
      type,
      name: wizardProviderName(type),
      description: wizardProviderDescription(type),
      found: detectedBinaryPath(type, input.instances, input.snapshot) !== undefined,
      ...(keyOnly && !input.credentialManagementAvailable
        ? {
            unavailable:
              "Needs an API key, and this browser cannot store one. Add it in the Octant desktop app.",
          }
        : {}),
    };
  });
}

/** The sign-in choices a provider offers, each saying what happens next. */
export function wizardSignInChoices(
  type: ProviderCreateProviderType,
  credentialStore: string,
): ReadonlyArray<WizardSignInChoice> {
  if (type === "claude") {
    return [
      {
        id: "subscription",
        label: "Claude subscription",
        detail:
          "You sign in with the Claude CLI in a terminal on the last step. Octant never reads or stores that login.",
        needsKey: false,
      },
      {
        id: "api-key",
        label: "Anthropic API key",
        detail: `Octant keeps the key in ${credentialStore} and never shows it again.`,
        needsKey: true,
      },
      {
        id: "gateway",
        label: "Gateway",
        detail: `Claude Code calls your gateway's address with its token. Octant keeps the token in ${credentialStore} and never shows it again.`,
        needsKey: true,
        keyLabel: "Gateway token",
      },
    ];
  }
  if (isAcpAgentKind(type)) {
    const profile = acpAgentProfile(type);
    const offered = offeredAcpAuthentication(type);
    const choices = offered.map((posture) =>
      posture === "api-key"
        ? {
            id: posture,
            label: profile.apiKeyLabel ?? "API key",
            detail: `Octant keeps the key in ${credentialStore} and never shows it again.`,
            needsKey: true,
          }
        : {
            id: posture,
            label: "Provider CLI login",
            detail: `You sign in with ${profile.name}'s own CLI. ${profile.signInGuidance}`,
            needsKey: false,
          },
    );
    if (choices.length > 0) return choices;
    return [
      {
        id: "provider-owned",
        label: `${profile.name} login`,
        detail: `You sign in with ${profile.name}'s own CLI. ${profile.signInGuidance}`,
        needsKey: false,
      },
    ];
  }
  const own = wizardProviderName(type);
  return [
    {
      id: "provider-owned",
      label: `${own} login`,
      detail: `${own} signs in with its own CLI. Octant never reads or stores that login; you sign in in a terminal on the last step.`,
      needsKey: false,
    },
  ];
}

export function wizardAuthentication(
  type: ProviderCreateProviderType,
  choice: string,
): { readonly claude?: ClaudeAuthentication; readonly acp?: AcpAgentAuthentication } {
  if (type === "claude") {
    return {
      claude: choice === "api-key" || choice === "gateway" ? choice : "subscription",
    };
  }
  if (isAcpAgentKind(type)) {
    const posture = offeredAcpAuthentication(type).find((candidate) => candidate === choice);
    return posture === undefined ? {} : { acp: posture };
  }
  return {};
}

/** The next free "<name> (n)" among the accounts of one provider. */
export function suggestedProviderName(
  type: ProviderCreateProviderType,
  instances: ReadonlyArray<ProviderInstance>,
): string {
  const base = type === "claude" ? "Claude Code" : wizardProviderName(type);
  const taken = new Set(instances.map((instance) => instance.displayName.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let number = 2;
  while (taken.has(`${base} (${number})`.toLowerCase())) number += 1;
  return `${base} (${number})`;
}
