import {
  OutsideHarnessEndpointProviderConfiguration,
  OutsideImageProviderConfiguration,
  OutsideVideoProviderConfiguration,
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
const decodeVideoConfiguration = Schema.decodeUnknownEither(OutsideVideoProviderConfiguration);

/** A declared per-image price as a person reads it, from integer micro-dollars. */
function perImagePrice(usdMicros: number | undefined): string {
  if (usdMicros === undefined) return "No published price";
  const dollars = usdMicros / 1_000_000;
  return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)} per image`;
}

interface DeclaredModel {
  readonly id: string;
  readonly label: string;
  readonly price: string;
}

/** The models a media driver's package declares, as the person chooses among them. */
function declaredMediaModels(
  listing: OutsideProviderDriverListing,
):
  | { readonly media: "image" | "video"; readonly models: ReadonlyArray<DeclaredModel> }
  | undefined {
  if (listing.imageGeneration !== undefined) {
    return {
      media: "image",
      models: listing.imageGeneration.models.map((model) => ({
        id: String(model.modelId),
        label: String(model.modelId),
        price: perImagePrice(model.usdMicrosPerImage),
      })),
    };
  }
  if (listing.videoGeneration !== undefined) {
    return {
      media: "video",
      models: listing.videoGeneration.models.map((model) => ({
        id: String(model.modelId),
        label: model.displayName,
        price: model.publishesPrice ? "Price shown on each card" : "No published price",
      })),
    };
  }
  return undefined;
}

export interface OutsideDriverAddFormProps {
  readonly listing: OutsideProviderDriverListing;
  readonly disabled: boolean;
  readonly pending: boolean;
  /** Whether this window can put a key in the host's keychain. */
  readonly credentialManagementAvailable: boolean;
  readonly onAdd: (
    displayName: string,
    configuration:
      | OutsideHarnessEndpointProviderConfiguration
      | OutsideImageProviderConfiguration
      | OutsideVideoProviderConfiguration,
    credential: TransientProviderCredential,
  ) => void;
}

/**
 * Adds a provider from one admitted outside driver: its name, the address of
 * the service the driver speaks to, how the key is sent, the key, and the
 * models to offer. The host checks every field again and creates the provider
 * off; the driver itself only ever learns the address and the model IDs.
 *
 * For an image or video driver the models are not typed: the person chooses
 * among the ones its package declares, since only a declared model has a price
 * the host can hold a spend limit to.
 */
export function OutsideDriverAddForm(props: OutsideDriverAddFormProps) {
  const ids = useId();
  const hostPlatform = useHostPlatform();
  const [name, setName] = useState(props.listing.displayName);
  const [address, setAddress] = useState("");
  const [keyChoice, setKeyChoice] = useState<KeyChoice>("bearer");
  const [header, setHeader] = useState("x-api-key");
  const [models, setModels] = useState("");
  const declared = declaredMediaModels(props.listing);
  const [chosenModels, setChosenModels] = useState<ReadonlyArray<string>>(() =>
    (declared?.models ?? []).map((model) => model.id),
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
    const common = {
      driver: props.listing.driver,
      baseUrl: address.trim(),
      ...(key === undefined ? {} : { key }),
    };
    const media = {
      ...common,
      modelAllowlist: chosenModels,
      defaultModel: chosenModels[0],
    };
    const decoded =
      declared === undefined
        ? decodeConfiguration({
            kind: "outside-harness-endpoint",
            ...common,
            modelIds: [
              ...new Set(
                models
                  .split(/[\s,]+/)
                  .map((id) => id.trim())
                  .filter((id) => id.length > 0),
              ),
            ],
          })
        : declared.media === "image"
          ? decodeImageConfiguration({ kind: "outside-image", ...media })
          : decodeVideoConfiguration({ kind: "outside-video", ...media });
    if (name.trim().length === 0 || decoded._tag === "Left") {
      setProblem(
        declared === undefined
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
      {declared === undefined ? null : (
        <fieldset className="endpoint-flow__field">
          <legend>Models</legend>
          {declared.models.map((model) => (
            <label className="endpoint-flow__check" key={model.id}>
              <OctantCheckbox
                checked={chosenModels.includes(model.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setChosenModels((current) =>
                    checked
                      ? declared.models
                          .map((entry) => entry.id)
                          .filter((id) => id === model.id || current.includes(id))
                      : current.filter((chosen) => chosen !== model.id),
                  );
                }}
              />
              <span>
                <span>{model.label}</span>
                <span className="endpoint-flow__hint">{model.price}</span>
              </span>
            </label>
          ))}
          <span className="endpoint-flow__hint">
            The first one chosen is the default. Octant estimates each{" "}
            {declared.media === "image" ? "image" : "clip"} from the price the driver&apos;s package
            publishes; a model with none is refused while a spend limit is set.
          </span>
        </fieldset>
      )}
      {declared !== undefined ? null : (
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
