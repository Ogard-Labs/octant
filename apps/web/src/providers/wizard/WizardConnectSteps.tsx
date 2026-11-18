import {
  acpAgentProfile,
  isAcpAgentKind,
  type ProviderInstance,
  type ProviderObservedState,
} from "@octant/contracts";
import {
  CLAUDE_ACCOUNT_PROFILE,
  CODEX_ACCOUNT_PROFILE,
  formatProviderAccountSignInCommand,
  formatProviderAccountStatusCommand,
} from "@octant/domain";
import { Check, Copy } from "../../ui/icons";
import { useState } from "react";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { providerRefusalGuidance } from "../providerSettingsPresentation";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";

/** The command the host shows for this account's sign-in, or the guidance text. */
function signInFor(instance: ProviderInstance): {
  readonly command?: string;
  readonly status?: string;
  readonly guidance: string;
} {
  const configuration = instance.configuration;
  if (instance.driverKind === "claude" || instance.driverKind === "codex") {
    const claude = instance.driverKind === "claude";
    const profile = claude ? CLAUDE_ACCOUNT_PROFILE : CODEX_ACCOUNT_PROFILE;
    if (claude && "authentication" in configuration && configuration.authentication === "api-key") {
      return { guidance: "This account signs in with the API key you gave. Check the connection." };
    }
    if (claude && "authentication" in configuration && configuration.authentication === "gateway") {
      return {
        guidance:
          "This account signs in to your gateway with the token you gave. Check the connection.",
      };
    }
    const binaryPath = "binaryPath" in configuration ? configuration.binaryPath : "";
    const stateDirectory =
      "configDirectory" in configuration && configuration.configDirectory !== undefined
        ? configuration.configDirectory
        : "codexHome" in configuration
          ? configuration.codexHome
          : undefined;
    const directory = stateDirectory === undefined ? {} : { stateDirectory };
    return {
      command: formatProviderAccountSignInCommand({ profile, binaryPath, ...directory }),
      status: formatProviderAccountStatusCommand({ profile, binaryPath, ...directory }),
      guidance:
        "Run this unmodified command in a terminal. Octant never reads, stores, or injects the login.",
    };
  }
  if (isAcpAgentInstance(instance)) {
    const profile = acpAgentProfile(instance.driverKind);
    return {
      guidance:
        "authentication" in configuration && configuration.authentication === "api-key"
          ? "This account signs in with the API key you gave. Check the connection."
          : profile.signInGuidance,
    };
  }
  return {
    guidance: "Sign in with the provider's own CLI in a terminal, then check the connection.",
  };
}

function isAcpAgentInstance(instance: ProviderInstance): instance is ProviderInstance & {
  readonly driverKind: Parameters<typeof acpAgentProfile>[0];
} {
  return isAcpAgentKind(instance.driverKind);
}

interface ConnectProps {
  readonly instance: ProviderInstance | undefined;
  readonly observed: ProviderObservedState | undefined;
  readonly providerName: string;
}

/** What the last check found, in the host's own words. */
function ConnectionResult(props: ConnectProps & { readonly probing: boolean }) {
  if (props.probing) return <p role="status">Checking the connection…</p>;
  if (props.observed === undefined || props.instance === undefined) {
    return <p className="add-provider-wizard__hint">Not checked yet.</p>;
  }
  if (props.observed.readiness === "ready") {
    const count = props.observed.models.length;
    return (
      <OctantAlert tone="success">
        Connected{count === 0 ? "" : `, ${count} ${count === 1 ? "model" : "models"} found`}.
      </OctantAlert>
    );
  }
  const refusal = providerRefusalGuidance(props.instance, props.observed);
  return (
    <OctantAlert tone="warning">
      {refusal === undefined
        ? (props.observed.message ?? `${props.providerName} is not ready yet.`)
        : `${refusal.reason} ${refusal.nextStep}`}
    </OctantAlert>
  );
}

export function WizardConnectStep(
  props: ConnectProps & {
    readonly probing: boolean;
    readonly onProbe: ProviderSettingsViewProps["onProbe"];
  },
) {
  const [copied, setCopied] = useState<"sign-in" | "status" | undefined>(undefined);
  const instance = props.instance;
  if (instance === undefined) {
    return <p role="status">Adding the account…</p>;
  }
  const signIn = signInFor(instance);
  const copy = (which: "sign-in" | "status", text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(which))
      .catch(() => setCopied(undefined));
  };
  return (
    <section>
      <p className="add-provider-wizard__lead">
        {instance.displayName} is added. Sign in, then check the connection.
      </p>
      {signIn.command === undefined ? null : (
        <div className="add-provider-wizard__field">
          <span>Sign-in command</span>
          <div className="add-provider-wizard__command">
            <OctantInput aria-label="Account sign-in command" readOnly value={signIn.command} />
            <OctantButton
              aria-label="Copy sign-in command"
              onClick={() => copy("sign-in", signIn.command ?? "")}
              size="sm"
              type="button"
              variant="secondary"
            >
              {copied === "sign-in" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "sign-in" ? "Copied" : "Copy"}
            </OctantButton>
          </div>
        </div>
      )}
      <p className="add-provider-wizard__hint">{signIn.guidance}</p>
      <div className="add-provider-wizard__check">
        <OctantButton
          disabled={props.probing}
          onClick={() => void props.onProbe(instance.id)}
          type="button"
          variant="secondary"
        >
          {props.probing ? "Checking…" : "Check connection"}
        </OctantButton>
        <div aria-live="polite" className="add-provider-wizard__result">
          <ConnectionResult {...props} />
        </div>
      </div>
    </section>
  );
}

export function WizardDoneStep(props: ConnectProps) {
  const instance = props.instance;
  const ready = props.observed?.readiness === "ready";
  return (
    <section>
      <p className="add-provider-wizard__lead">
        {instance?.displayName ?? props.providerName} is set up.
      </p>
      <dl className="add-provider-wizard__summary">
        <dt>Provider</dt>
        <dd>{props.providerName}</dd>
        <dt>Connection</dt>
        <dd>
          {ready
            ? "Connected"
            : "Not confirmed yet. Check the connection from its row in Providers."}
        </dd>
        {instance !== undefined && "binaryPath" in instance.configuration ? (
          <>
            <dt>Binary</dt>
            <dd>
              <code>{instance.configuration.binaryPath}</code>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
