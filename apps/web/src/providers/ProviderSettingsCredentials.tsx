import type {
  ClaudeAuthentication,
  GrokAuthentication,
  MistralVibeAuthentication,
  ProviderCredentialStatus,
  ProviderInstanceId,
  ProviderObservedState,
} from "@octant/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import type { TransientProviderCredential } from "./useProviderController";

export function ClaudeCreateAuthenticationFields(props: {
  readonly authentication: ClaudeAuthentication;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (authentication: ClaudeAuthentication) => void;
}) {
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label="Claude authentication"
          className="settings-view__select window-no-drag"
          onChange={(event) =>
            props.onAuthenticationChange(event.currentTarget.value as ClaudeAuthentication)
          }
          value={props.authentication}
        >
          <option value="subscription">Claude subscription</option>
          <option value="api-key">Anthropic API key</option>
        </OctantNativeSelect>
      </label>
      {props.authentication === "api-key" ? (
        <>
          <label>
            <span>Anthropic API key</span>
            <OctantInput
              aria-label="Anthropic API key"
              autoComplete="new-password"
              className="settings-view__text-input window-no-drag"
              disabled={!props.credentialManagementAvailable}
              ref={props.credentialInput}
              spellCheck={false}
              type="password"
            />
          </label>
          {!props.credentialManagementAvailable ? (
            <p className="provider-settings__field-guidance">
              Claude API-key providers can only be created in the Octant host app. Claude
              subscription providers remain available in this browser.
            </p>
          ) : null}
        </>
      ) : (
        <p className="provider-settings__field-guidance">
          Authenticate with the official Claude Code app or CLI, then check the connection.
        </p>
      )}
    </>
  );
}

export function VibeCreateAuthenticationFields(props: {
  readonly authentication: MistralVibeAuthentication;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (authentication: MistralVibeAuthentication) => void;
}) {
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label="Mistral Vibe authentication"
          className="settings-view__select window-no-drag"
          onChange={(event) =>
            props.onAuthenticationChange(event.currentTarget.value as MistralVibeAuthentication)
          }
          value={props.authentication}
        >
          <option value="subscription">Mistral subscription</option>
          <option value="api-key">Mistral API key</option>
        </OctantNativeSelect>
      </label>
      {props.authentication === "api-key" ? (
        <label>
          <span>Mistral API key</span>
          <OctantInput
            aria-label="Mistral API key"
            autoComplete="new-password"
            className="settings-view__text-input window-no-drag"
            disabled={!props.credentialManagementAvailable}
            ref={props.credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Create the provider, then use its browser sign-in action. Octant never receives the
          resulting OAuth credential.
        </p>
      )}
    </>
  );
}

export function GrokCreateAuthenticationFields(props: {
  readonly authentication: GrokAuthentication;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialManagementAvailable: boolean;
  readonly onAuthenticationChange: (authentication: GrokAuthentication) => void;
}) {
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label="Grok Build authentication"
          className="settings-view__select window-no-drag"
          onChange={(event) =>
            props.onAuthenticationChange(event.currentTarget.value as GrokAuthentication)
          }
          value={props.authentication}
        >
          <option value="subscription">xAI subscription</option>
          <option value="api-key">xAI API key</option>
        </OctantNativeSelect>
      </label>
      {props.authentication === "api-key" ? (
        <label>
          <span>xAI API key</span>
          <OctantInput
            aria-label="xAI API key"
            autoComplete="new-password"
            className="settings-view__text-input window-no-drag"
            disabled={!props.credentialManagementAvailable}
            ref={props.credentialInput}
            spellCheck={false}
            type="password"
          />
        </label>
      ) : (
        <p className="provider-settings__field-guidance">
          Create the provider, then use its browser sign-in action. Octant never receives the
          resulting OAuth credential.
        </p>
      )}
    </>
  );
}

interface HttpCredentialFieldsProps {
  readonly authentication: "api-key" | "bearer" | "none";
  readonly authenticationLabel: string;
  readonly controlClassName?: string;
  readonly credentialInput: RefObject<HTMLInputElement | null>;
  readonly credentialLabel: string;
  readonly credentialManagementAvailable: boolean;
  readonly supportsApiKey?: boolean;
  readonly fixedAuthentication?: boolean;
}

export function HttpCredentialFields(props: HttpCredentialFieldsProps) {
  const [authentication, setAuthentication] = useState(props.authentication);
  const fixed = props.fixedAuthentication === true;
  // When auth is fixed (e.g. Azure AI Foundry), always derive the effective
  // value from the prop so a stale internal `none` state from a prior form
  // cannot disable the API-key input. The selector is also disabled so the
  // user cannot change it away from the fixed value.
  const effectiveAuthentication = fixed
    ? props.authentication
    : !props.supportsApiKey && authentication === "api-key"
      ? "bearer"
      : authentication;
  return (
    <>
      <label>
        <span>Authentication</span>
        <OctantNativeSelect
          aria-label={props.authenticationLabel}
          className={`settings-view__select ${props.controlClassName ?? ""}`}
          disabled={fixed}
          name="authentication"
          onChange={(event) => {
            const next = event.currentTarget.value as "api-key" | "bearer" | "none";
            if (next === "none" && props.credentialInput.current !== null) {
              props.credentialInput.current.value = "";
            }
            setAuthentication(next);
          }}
          value={effectiveAuthentication}
        >
          {props.supportsApiKey ? (
            <option value="api-key">
              API key ({fixed ? "api-key header" : "x-api-key header"})
            </option>
          ) : null}
          {fixed ? null : (
            <>
              <option value="bearer">Bearer API key</option>
              <option value="none">No authentication (trusted loopback only)</option>
            </>
          )}
        </OctantNativeSelect>
      </label>
      <label>
        <span>API key (leave blank to preserve)</span>
        <OctantInput
          aria-label={props.credentialLabel}
          autoComplete="new-password"
          className={`settings-view__text-input ${props.controlClassName ?? ""}`}
          disabled={!props.credentialManagementAvailable || effectiveAuthentication === "none"}
          name="credential"
          ref={props.credentialInput}
          spellCheck={false}
          type="password"
        />
      </label>
    </>
  );
}

export function transientCredential(input: HTMLInputElement | null): TransientProviderCredential {
  return {
    value: input?.value ?? "",
    clear: () => {
      if (input !== null) input.value = "";
    },
  };
}

export function emptyTransientCredential(
  credential: TransientProviderCredential,
): TransientProviderCredential {
  credential.clear();
  return { value: "", clear: credential.clear };
}

export type CredentialStatusView = ProviderCredentialStatus | "checking";

export interface CredentialStatusController {
  readonly status: CredentialStatusView;
  readonly beginMutation: () => number;
  readonly finishMutation: (
    generation: number,
    succeeded: boolean,
    successStatus: ProviderCredentialStatus,
  ) => void;
}

export function useCredentialStatus(
  props: {
    readonly instance: { readonly id: ProviderInstanceId };
    readonly observed?: Pick<ProviderObservedState, "credentialStatus">;
    readonly credentialManagementAvailable: boolean;
    readonly onProviderCredentialStatus: (
      instanceId: ProviderInstanceId,
    ) => Promise<ProviderCredentialStatus>;
  },
  credentialless: boolean,
): CredentialStatusController {
  const requestGeneration = useRef(0);
  const [status, setStatus] = useState<CredentialStatusView>(
    props.observed?.credentialStatus ??
      (props.credentialManagementAvailable ? "checking" : "unavailable"),
  );

  const requestStatus = (expectedGeneration: number) => {
    if (requestGeneration.current !== expectedGeneration) return;
    const generation = ++requestGeneration.current;
    setStatus("checking");
    void props.onProviderCredentialStatus(props.instance.id).then(
      (nextStatus) => {
        if (requestGeneration.current === generation) setStatus(nextStatus);
      },
      () => {
        if (requestGeneration.current === generation) setStatus("unavailable");
      },
    );
  };

  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );
  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (credentialless) return undefined;
    if (!props.credentialManagementAvailable) {
      setStatus("unavailable");
      return undefined;
    }
    if (props.observed?.credentialStatus !== undefined) {
      setStatus(props.observed.credentialStatus);
      return undefined;
    }
    setStatus("checking");
    void props.onProviderCredentialStatus(props.instance.id).then(
      (nextStatus) => {
        if (requestGeneration.current === generation) setStatus(nextStatus);
      },
      () => {
        if (requestGeneration.current === generation) setStatus("unavailable");
      },
    );
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [
    credentialless,
    props.credentialManagementAvailable,
    props.instance.id,
    props.observed?.credentialStatus,
    props.onProviderCredentialStatus,
  ]);

  return {
    status,
    beginMutation: () => {
      const generation = ++requestGeneration.current;
      setStatus("checking");
      return generation;
    },
    finishMutation: (generation, succeeded, successStatus) => {
      if (requestGeneration.current !== generation) return;
      if (succeeded) setStatus(successStatus);
      else requestStatus(generation);
    },
  };
}

export function credentialStatusLabel(status: CredentialStatusView): string {
  if (status === "checking") return "Checking Keychain…";
  if (status === "stored") return "Stored in Keychain";
  if (status === "missing") return "Not configured";
  return "Unavailable";
}
