import {
  OutsideHarnessEndpointProviderConfiguration,
  type ProviderInstance,
} from "@octant/contracts";
import { normalizeOpenAiCompatibleBaseUrl } from "@octant/domain";
import { Schema } from "effect";
import { useRef, useState } from "react";
import { hostCredentialStore, useHostPlatform } from "../../platform";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { SettingRow } from "../../settings/primitives";
import { transientCredential } from "../ProviderSettingsCredentials";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";

type KeyChoice = "none" | "bearer" | "header";

const decodeConfiguration = Schema.decodeUnknownEither(OutsideHarnessEndpointProviderConfiguration);

type OutsideInstance = Extract<ProviderInstance, { driverKind: "outside-harness-endpoint" }>;

function savedKeyChoice(instance: OutsideInstance): KeyChoice {
  const key = instance.configuration.key;
  if (key === undefined) return "none";
  return key.header === "authorization" && key.scheme === "Bearer" ? "bearer" : "header";
}

function sameAddress(left: string, right: string): boolean {
  try {
    return normalizeOpenAiCompatibleBaseUrl(left) === normalizeOpenAiCompatibleBaseUrl(right);
  } catch {
    return false;
  }
}

/**
 * Changes where an outside driver provider sends its requests, how its key is
 * sent, and which models it lists. The driver itself is not editable here: a
 * different driver is a new provider. The host stops the driver and forgets
 * the saved key when the address changes, so the form asks for the key again
 * then; the host's own refusals (an active session, an address it won't use)
 * appear in the Settings message.
 */
export function OutsideDriverConfigurationForm(props: {
  readonly instance: OutsideInstance;
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onChange: NonNullable<
    ProviderSettingsViewProps["onChangeOutsideHarnessEndpointConfiguration"]
  >;
}) {
  const saved = props.instance.configuration;
  const hostPlatform = useHostPlatform();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(saved.baseUrl);
  const [keyChoice, setKeyChoice] = useState<KeyChoice>(savedKeyChoice(props.instance));
  const [header, setHeader] = useState(
    saved.key !== undefined && savedKeyChoice(props.instance) === "header"
      ? saved.key.header
      : "x-api-key",
  );
  const [models, setModels] = useState(saved.modelIds.join(", "));
  const [problem, setProblem] = useState<string>();
  const credentialInput = useRef<HTMLInputElement>(null);
  const id = `provider-${props.instance.id}-outside`;
  const name = props.instance.displayName;

  const close = () => {
    setOpen(false);
    setProblem(undefined);
  };

  if (!open) {
    return (
      <div className="provider-card__edit-actions">
        <OctantButton
          aria-label={`Edit connection for ${name}`}
          disabled={props.disabled}
          onClick={() => setOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Edit
        </OctantButton>
      </div>
    );
  }

  const addressChanged = !sameAddress(address.trim(), saved.baseUrl);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key =
      keyChoice === "none"
        ? undefined
        : keyChoice === "bearer"
          ? { header: "authorization", scheme: "Bearer" as const }
          : {
              header: header.trim().toLowerCase(),
              ...(saved.key?.header === header.trim().toLowerCase() && saved.key.scheme
                ? { scheme: saved.key.scheme }
                : {}),
            };
    const decoded = decodeConfiguration({
      kind: "outside-harness-endpoint",
      driver: saved.driver,
      baseUrl: address.trim(),
      ...(key === undefined ? {} : { key }),
      modelIds: [
        ...new Set(
          models
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      ],
    });
    if (decoded._tag === "Left") {
      setProblem(
        "Give it an address, at least one model ID, and a key header other than proxy-authorization, cookie, or host.",
      );
      return;
    }
    const entered = credentialInput.current?.value ?? "";
    const forgotten = key !== undefined && (addressChanged || saved.key === undefined);
    if (forgotten && entered.length === 0 && props.credentialManagementAvailable) {
      setProblem(
        addressChanged
          ? "The address changed, so Octant forgets the saved key. Enter the key again."
          : "Enter the key this provider now sends.",
      );
      return;
    }
    setProblem(undefined);
    const credential = transientCredential(credentialInput.current);
    void props
      .onChange(
        props.instance.id,
        decoded.right,
        key === undefined ? { value: "", clear: credential.clear } : credential,
      )
      .then((updated) => {
        if (updated) close();
      });
  };

  return (
    <form
      aria-label={`Edit connection for ${name}`}
      className="provider-card__edit"
      noValidate
      onSubmit={submit}
    >
      <SettingRow
        htmlFor={`${id}-address`}
        description="HTTPS, or HTTP on this computer. Octant sends the driver's requests only here."
        label="Address"
        scope="host"
        settingId={`provider-${props.instance.id}-base-url`}
      >
        <OctantInput
          aria-label={`Address for ${name}`}
          className="settings-view__text-input"
          id={`${id}-address`}
          inputMode="url"
          onChange={(event) => setAddress(event.currentTarget.value)}
          spellCheck={false}
          value={address}
        />
      </SettingRow>
      <SettingRow
        htmlFor={`${id}-key-choice`}
        label="How the key is sent"
        scope="host"
        settingId={`provider-${props.instance.id}-authentication`}
      >
        <OctantSelectField
          aria-label={`How the key is sent for ${name}`}
          className="settings-view__select"
          id={`${id}-key-choice`}
          onValueChange={(value) =>
            setKeyChoice(value === "none" ? "none" : value === "header" ? "header" : "bearer")
          }
          options={[
            { id: "bearer", label: "Bearer token" },
            { id: "header", label: "A header of its own" },
            { id: "none", label: "No key (this computer only)" },
          ]}
          value={keyChoice}
        />
      </SettingRow>
      {keyChoice === "header" ? (
        <SettingRow
          htmlFor={`${id}-header`}
          label="Key header"
          scope="host"
          settingId={`provider-${props.instance.id}-key-header`}
        >
          <OctantInput
            aria-label={`Key header for ${name}`}
            className="settings-view__text-input"
            id={`${id}-header`}
            onChange={(event) => setHeader(event.currentTarget.value)}
            spellCheck={false}
            value={header}
          />
        </SettingRow>
      ) : null}
      {keyChoice === "none" ? null : props.credentialManagementAvailable ? (
        <SettingRow
          htmlFor={`${id}-key`}
          description={
            addressChanged
              ? `Required: a new address means the saved key is forgotten. Saved in ${hostCredentialStore(hostPlatform)}.`
              : "Leave empty to keep the saved key."
          }
          label="API key"
          scope="host"
          settingId={`provider-${props.instance.id}-api-key`}
        >
          <OctantInput
            aria-label={`API key for ${name}`}
            autoComplete="new-password"
            className="settings-view__text-input"
            id={`${id}-key`}
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
        </SettingRow>
      ) : (
        <p className="endpoint-flow__note">
          This browser can&apos;t store keys. Save the change here, then add the key in the Octant
          desktop app.
        </p>
      )}
      <SettingRow
        htmlFor={`${id}-models`}
        description="Separated by commas or spaces. Octant offers only the ones the driver also reports."
        label="Model IDs"
        scope="host"
        settingId={`provider-${props.instance.id}-manual-model-ids`}
      >
        <OctantTextarea
          aria-label={`Model IDs for ${name}`}
          className="settings-view__text-input"
          id={`${id}-models`}
          onChange={(event) => setModels(event.currentTarget.value)}
          rows={2}
          spellCheck={false}
          value={models}
        />
      </SettingRow>
      {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
      <div className="provider-card__edit-actions">
        <OctantButton
          aria-label={`Save connection for ${name}`}
          disabled={props.disabled}
          size="sm"
          type="submit"
          variant="outline"
        >
          Save
        </OctantButton>
        <OctantButton onClick={close} size="sm" type="button" variant="ghost">
          Cancel
        </OctantButton>
      </div>
    </form>
  );
}
