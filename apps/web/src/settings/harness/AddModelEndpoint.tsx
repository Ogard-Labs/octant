import type { OpenAiCompatibleProviderConfiguration } from "@octant/contracts";
import type { SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";
import { subscriptionOAuthOffers } from "@octant/domain";
import { Plus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { ProviderGlyph } from "../../providers/ProviderGlyph";
import { signInConsent } from "../../providers/ProviderOAuthSignIn";
import {
  ProviderCreateForm,
  type ProviderCreateFormProps,
} from "../../providers/ProviderSettingsConfiguration";
import { MODEL_ENDPOINT_DRIVER_KINDS } from "../../providers/providerSettingsPresentation";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import { EndpointState } from "./ModelEndpointRow";
import type { EndpointStatus } from "./endpointStatus";

/**
 * How Settings names each sign-in it offers as a new endpoint. A catalog offer
 * with no entry here is still honoured on an endpoint that already points at
 * its URL, but is not offered as a one-step sign-in.
 */
export const SIGN_IN_ENDPOINTS: Readonly<
  Record<
    string,
    {
      readonly action: string;
      readonly displayName: string;
      readonly description: string;
      readonly glyph: string;
      readonly protocol: OpenAiCompatibleProviderConfiguration["protocol"];
    }
  >
> = {
  // The plan route speaks only the Responses protocol; the driver refuses a
  // Chat Completions request under it before anything leaves the host.
  "chatgpt-plan": {
    action: "Sign in with ChatGPT",
    displayName: "ChatGPT plan",
    description: "Use your ChatGPT subscription. No API key.",
    glyph: "openai-image",
    protocol: "responses",
  },
  openrouter: {
    action: "Sign in with OpenRouter",
    displayName: "OpenRouter",
    description: "One sign-in for many models, billed by OpenRouter.",
    glyph: "model-endpoint",
    protocol: "auto",
  },
};

/** The catalog's sign-ins Settings offers as new endpoints, ChatGPT first. */
export function offeredSignIns(): ReadonlyArray<SubscriptionOAuthOffer> {
  const offers = subscriptionOAuthOffers();
  return Object.keys(SIGN_IN_ENDPOINTS).flatMap((descriptorId) =>
    offers.filter(
      (offer) =>
        String(offer.descriptor.descriptorId) === descriptorId &&
        offer.driverKinds.includes("openai-compatible"),
    ),
  );
}

export interface EndpointChoicesProps {
  readonly disabled: boolean;
  readonly credentialManagementAvailable: boolean;
  readonly onSignIn: (offer: SubscriptionOAuthOffer) => void;
  /** Absent inside the add dialog, where the form follows the sign-ins. */
  readonly onAddEndpoint?: () => void;
}

/**
 * The ways in: one row per sign-in, each one click with its consent line
 * under the button, and Another endpoint by its address.
 */
export function EndpointChoices(props: EndpointChoicesProps) {
  const offers = offeredSignIns();
  const consentId = useId();
  return (
    <ul className="endpoint-choices">
      {offers.map((offer, index) => {
        const presentation = SIGN_IN_ENDPOINTS[offer.descriptor.descriptorId];
        if (presentation === undefined) return null;
        return (
          <li className="endpoint-choice" key={offer.descriptor.descriptorId}>
            <span aria-hidden="true" className="endpoint-mark">
              <ProviderGlyph
                displayName={presentation.displayName}
                driverKind={presentation.glyph}
                size={presentation.glyph === "model-endpoint" ? 24 : 16}
              />
            </span>
            <span className="endpoint-choice__text">
              <span className="endpoint-choice__name">{presentation.displayName}</span>
              <span className="endpoint-choice__detail">{presentation.description}</span>
            </span>
            <OctantButton
              aria-describedby={`${consentId}-${offer.descriptor.descriptorId}`}
              disabled={props.disabled}
              onClick={() => props.onSignIn(offer)}
              size="sm"
              type="button"
              variant={index === 0 ? "default" : "outline"}
            >
              {presentation.action}
            </OctantButton>
            <p
              className="endpoint-choice__consent"
              id={`${consentId}-${offer.descriptor.descriptorId}`}
            >
              {signInConsent(offer.termsSummary)}
              {props.credentialManagementAvailable
                ? null
                : " Sign-in starts from the Octant app or a browser on this Mac."}
            </p>
          </li>
        );
      })}
      {props.onAddEndpoint === undefined ? null : (
        <li className="endpoint-choice">
          <span aria-hidden="true" className="endpoint-mark">
            <Plus size={16} />
          </span>
          <span className="endpoint-choice__text">
            <span className="endpoint-choice__name">Another endpoint</span>
            <span className="endpoint-choice__detail">
              OpenAI-compatible, Anthropic-compatible, Ollama or Azure AI Foundry, by its address.
            </span>
          </span>
          <OctantButton
            disabled={props.disabled}
            onClick={props.onAddEndpoint}
            size="sm"
            type="button"
            variant="outline"
          >
            Add endpoint
          </OctantButton>
        </li>
      )}
    </ul>
  );
}

export interface AddEndpointDialogProps extends ProviderCreateFormProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSignIn: (offer: SubscriptionOAuthOffer) => void;
  /** A page-level message, repeated here because the page sits behind the dialog. */
  readonly message?: string;
  /** The new endpoint's check, once it has been added. */
  readonly added?: {
    readonly name: string;
    readonly status: EndpointStatus;
    readonly onOpen: () => void;
  };
}

/**
 * Add endpoint: the sign-ins, then the endpoint-by-address form, whose button
 * adds the endpoint and checks it. The check's result shows here, so a
 * mistyped address is corrected from the dialog rather than found later as a
 * broken row.
 */
export function AddEndpointDialog(props: AddEndpointDialogProps) {
  const titleId = useId();
  let content: ReactNode;
  if (props.added !== undefined) {
    const { status } = props.added;
    content = (
      <div aria-live="polite" className="endpoint-add__result">
        <p className="endpoint-add__result-head">
          Added {props.added.name}. <EndpointState status={status} />
        </p>
        {status.sentence === undefined ? null : <p>{status.sentence}</p>}
        <div className="endpoint-add__actions">
          {status.tone === "checking" ? null : (
            <OctantButton
              onClick={props.added.onOpen}
              size="sm"
              type="button"
              variant={status.tone === "ready" ? "outline" : "default"}
            >
              {status.tone === "ready" ? "Open details" : "Open details to fix"}
            </OctantButton>
          )}
          <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
            Done
          </OctantButton>
        </div>
      </div>
    );
  } else {
    content = (
      <>
        <EndpointChoices
          credentialManagementAvailable={props.credentialManagementAvailable}
          disabled={props.busy}
          onSignIn={props.onSignIn}
        />
        <h3 className="endpoint-add__subhead">Another endpoint, by its address</h3>
        <ProviderCreateForm
          {...props}
          allowedProviderTypes={MODEL_ENDPOINT_DRIVER_KINDS}
          embedded
          hint="OpenAI-compatible, Anthropic-compatible, Ollama or Azure AI Foundry. Keys stay in this Mac's Keychain."
          initialProviderType="openai-compatible"
          submitLabel="Check and add"
        />
      </>
    );
  }
  return (
    <OctantDialog
      className="endpoint-add"
      label="Add a model endpoint"
      labelledBy={titleId}
      onClose={props.onClose}
      open={props.open}
    >
      <h2 className="endpoint-add__title" id={titleId}>
        Add a model endpoint
      </h2>
      {props.message === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {props.message}
        </OctantAlert>
      )}
      {content}
    </OctantDialog>
  );
}
