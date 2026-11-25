import {
  OutsideHarnessEndpointProviderConfiguration,
  OutsideImageProviderConfiguration,
  type OutsideProviderDriverListing,
} from "@octant/contracts";
import { Schema } from "effect";
import { useId, useRef, useState, type FormEvent } from "react";
import { hostCredentialStore, thisComputerName, useHostPlatform } from "../../platform";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import type { TransientProviderCredential } from "../useProviderController";

type KeyChoice = "none" | "bearer" | "header";

const decodeConfiguration = Schema.decodeUnknownEither(OutsideHarnessEndpointProviderConfiguration);
const decodeImageConfiguration = Schema.decodeUnknownEither(OutsideImageProviderConfiguration);

/** A declared per-image price as a person reads it, from integer micro-dollars. */
function perImagePrice(usdMicros: number | undefined): string {
  if (usdMicros === undefined) return "No published price";
  const dollars = usdMicros / 1_000_000;
  return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)} per image`;
}

export interface OutsideDriverAddFormProps {
  readonly listing: OutsideProviderDriverListing;
  readonly disabled: boolean;
  readonly pending: boolean;
  /** Whether this window can put a key in the host's keychain. */
  readonly credentialManagementAvailable: boolean;
  readonly onAdd: (
    displayName: string,
    configuration: OutsideHarnessEndpointProviderConfiguration | OutsideImageProviderConfiguration,
    credential: TransientProviderCredential,
  ) => void;
}

/**
 * Adds a provider from one admitted outside driver: its name, the address of
 * the service the driver speaks to, how the key is sent, the key, and the
 * models to offer. The host checks every field again and creates the provider
 * off; the driver itself only ever learns the address and the model IDs.
 *
 * For an image driver the models are not typed: the person chooses among the
 * ones its package declares, each shown with the price the package publishes,
 * since only a declared model has a price the host can hold a spend limit to.
 */
export function OutsideDriverAddForm(props: OutsideDriverAddFormProps) {
  const ids = useId();
  const hostPlatform = useHostPlatform();
  const [name, setName] = useState(props.listing.displayName);
  const [address, setAddress] = useState("");
  const [keyChoice, setKeyChoice] = useState<KeyChoice>("bearer");
  const [header, setHeader] = useState("x-api-key");
  const [models, setModels] = useState("");
  const declaredImageModels = props.listing.imageGeneration?.models;
  const [chosenImageModels, setChosenImageModels] = useState<ReadonlyArray<string>>(() =>
    (declaredImageModels ?? []).map((model) => String(model.modelId)),
  );
  const [problem, setProblem] = useState<string>();
  const credentialInput = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key =
      keyChoice === "none"
        ? undefined
        : keyChoice === "bearer"
          ? { header: "authorization", scheme: "Bearer" }
          : { header: header.trim().toLowerCase() };
    const decoded =
      declaredImageModels === undefined
        ? decodeConfiguration({
            kind: "outside-harness-endpoint",
            driver: props.listing.driver,
            baseUrl: address.trim(),
            ...(key === undefined ? {} : { key }),
            modelIds: [
              ...new Set(
                models
                  .split(/[\s,]+/)
                  .map((id) => id.trim())
                  .filter((id) => id.length > 0),
              ),
            ],
          })
        : decodeImageConfiguration({
            kind: "outside-image",
            driver: props.listing.driver,
            baseUrl: address.trim(),
            ...(key === undefined ? {} : { key }),
            modelAllowlist: chosenImageModels,
            defaultModel: chosenImageModels[0],
          });
    if (name.trim().length === 0 || decoded._tag === "Left") {
      setProblem(
        declaredImageModels === undefined
          ? "Give it a name, an address, at least one model ID, and a key header other than proxy-authorization, cookie, or host."
          : "Give it a name, an address, at least one model, and a key header other than proxy-authorization, cookie, or host.",
      );
      return;
    }
    setProblem(undefined);
    const input = credentialInput.current;
    props.onAdd(name.trim(), decoded.right, {
      value: key === undefined ? "" : (input?.value ?? ""),
      clear: () => {
        if (input !== null) input.value = "";
      },
    });
  };

  return (
    <form
      aria-label={`Add a provider from ${props.listing.displayName}`}
      className="provider-catalog__form"
      noValidate
      onSubmit={submit}
    >
      <label className="endpoint-flow__field">
        <span>Name</span>
        <OctantInput
          className="settings-view__text-input"
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
      </label>
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-address`}>Address</label>
        <OctantInput
          aria-describedby={`${ids}-address-hint`}
          className="settings-view__text-input"
          id={`${ids}-address`}
          inputMode="url"
          onChange={(event) => setAddress(event.currentTarget.value)}
          placeholder="https://models.example.com/v1"
          spellCheck={false}
          value={address}
        />
        <span className="endpoint-flow__hint" id={`${ids}-address-hint`}>
          HTTPS, or HTTP on this computer. Octant sends the driver&apos;s requests only here.
        </span>
      </div>
      <div className="endpoint-flow__field">
        <span>How the key is sent</span>
        <OctantSelectField
          aria-label="How the key is sent"
          className="settings-view__select"
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
      </div>
      {keyChoice === "header" ? (
        <label className="endpoint-flow__field">
          <span>Key header</span>
          <OctantInput
            className="settings-view__text-input"
            onChange={(event) => setHeader(event.currentTarget.value)}
            spellCheck={false}
            value={header}
          />
        </label>
      ) : null}
      {keyChoice === "none" ? null : props.credentialManagementAvailable ? (
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-key`}>API key</label>
          <OctantInput
            aria-describedby={`${ids}-key-hint`}
            autoComplete="new-password"
            className="settings-view__text-input"
            id={`${ids}-key`}
            ref={credentialInput}
            spellCheck={false}
            type="password"
          />
          <span className="endpoint-flow__hint" id={`${ids}-key-hint`}>
            Saved in {hostCredentialStore(hostPlatform)}. Octant adds it to each request itself; the
            driver never sees it.
          </span>
        </div>
      ) : (
        <p className="endpoint-flow__note">
          This browser can&apos;t store keys. Add the provider here, then add its key in the Octant
          desktop app on {thisComputerName(hostPlatform)}.
        </p>
      )}
      {declaredImageModels === undefined ? null : (
        <fieldset className="endpoint-flow__field">
          <legend>Models</legend>
          {declaredImageModels.map((model) => {
            const id = String(model.modelId);
            return (
              <label className="endpoint-flow__check" key={id}>
                <OctantCheckbox
                  checked={chosenImageModels.includes(id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setChosenImageModels((current) =>
                      checked
                        ? declaredImageModels
                            .map((declared) => String(declared.modelId))
                            .filter((declared) => declared === id || current.includes(declared))
                        : current.filter((chosen) => chosen !== id),
                    );
                  }}
                />
                <span>
                  <span>{id}</span>
                  <span className="endpoint-flow__hint">
                    {perImagePrice(model.usdMicrosPerImage)}
                  </span>
                </span>
              </label>
            );
          })}
          <span className="endpoint-flow__hint">
            The first one chosen is the default. Octant estimates each image from the price the
            driver&apos;s package publishes; a model with none is refused while a spend limit is
            set.
          </span>
        </fieldset>
      )}
      {declaredImageModels !== undefined ? null : (
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-models`}>Model IDs</label>
          <OctantTextarea
            aria-describedby={`${ids}-models-hint`}
            className="settings-view__text-input"
            id={`${ids}-models`}
            onChange={(event) => setModels(event.currentTarget.value)}
            rows={2}
            spellCheck={false}
            value={models}
          />
          <span className="endpoint-flow__hint" id={`${ids}-models-hint`}>
            Separated by commas or spaces. Octant offers only the ones the driver also reports.
          </span>
        </div>
      )}
      {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
      <div className="provider-catalog__actions">
        <OctantButton disabled={props.disabled} size="sm" type="submit" variant="default">
          {props.pending ? "Adding…" : "Add provider"}
        </OctantButton>
      </div>
    </form>
  );
}
