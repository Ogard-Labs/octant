import type { OpenAiCompatibleProviderConfiguration } from "@octant/contracts";
import type { SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";
import { subscriptionOAuthOffers } from "@octant/domain";
import { Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ProviderGlyph } from "../../providers/ProviderGlyph";
import { signInConsent } from "../../providers/ProviderOAuthSignIn";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import {
  AddEndpointFlow,
  type AddEndpointFlowProps,
  type AddEndpointStep,
} from "./AddEndpointFlow";

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

export interface AddEndpointDialogProps extends AddEndpointFlowProps {
  readonly open: boolean;
  readonly onSignIn: (offer: SubscriptionOAuthOffer) => void;
  /** A page-level message, repeated here because the page sits behind the dialog. */
  readonly message?: string;
}

/**
 * Add endpoint: the sign-ins, then the guided flow that connects an endpoint
 * by its address. The flow starts again each time the dialog opens.
 */
export function AddEndpointDialog(props: AddEndpointDialogProps) {
  const titleId = useId();
  const [step, setStep] = useState<AddEndpointStep>("kind");
  // Each opening starts the flow again from its first step.
  useEffect(() => {
    if (props.open) setStep("kind");
  }, [props.open]);
  // The page alert speaks for creating the endpoint; once it exists, each
  // step says what happened next to the model it is about.
  const showMessage = props.message !== undefined && (step === "kind" || step === "connect");
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
      {showMessage ? (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {props.message}
        </OctantAlert>
      ) : null}
      {props.open ? (
        <AddEndpointFlow
          {...props}
          onStepChange={(next) => {
            setStep(next);
            props.onStepChange?.(next);
          }}
          signIns={
            <EndpointChoices
              credentialManagementAvailable={props.credentialManagementAvailable}
              disabled={props.busy}
              onSignIn={props.onSignIn}
            />
          }
        />
      ) : null}
    </OctantDialog>
  );
}
