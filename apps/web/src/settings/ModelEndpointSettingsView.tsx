import {
  decodeProviderInstanceId,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";
import { subscriptionOAuthOffers } from "@octant/domain";
import { useState, type ReactNode } from "react";
import { ProviderCreateForm } from "../providers/ProviderSettingsConfiguration";
import { ProviderSettingsList } from "../providers/ProviderSettingsList";
import {
  isModelEndpointDriverKind,
  MODEL_ENDPOINT_DRIVER_KINDS,
} from "../providers/providerSettingsPresentation";
import type { ProviderSettingsViewProps } from "../providers/ProviderSettingsView";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingRow } from "./primitives";

/**
 * How Settings names each sign-in it offers as a new endpoint. A catalog offer
 * with no entry here is still honoured on an endpoint that already points at
 * its URL, but is not offered as a one-step sign-in.
 */
const SIGN_IN_ENDPOINTS: Readonly<
  Record<
    string,
    {
      readonly action: string;
      readonly displayName: string;
      readonly protocol: OpenAiCompatibleProviderConfiguration["protocol"];
    }
  >
> = {
  // The plan route speaks only the Responses protocol; the driver refuses a
  // Chat Completions request under it before anything leaves the host.
  "chatgpt-plan": {
    action: "Sign in with ChatGPT",
    displayName: "ChatGPT plan",
    protocol: "responses",
  },
  openrouter: { action: "Sign in with OpenRouter", displayName: "OpenRouter", protocol: "auto" },
};

export type ModelEndpointSettingsViewProps = Omit<ProviderSettingsViewProps, "discovery"> & {
  /** A deep link landed on the add-endpoint row. */
  readonly focused?: boolean;
};

/**
 * Octant Harness › Model endpoints: the chat-model endpoints Octant calls over
 * an API itself. These are the same provider instances, commands, and
 * credential handling as Providers & Models uses; only where Settings lists
 * them differs.
 */
export function ModelEndpointSettingsView(props: ModelEndpointSettingsViewProps): ReactNode {
  const [signInStartingId, setSignInStartingId] = useState<ProviderInstanceId | undefined>(
    undefined,
  );
  const endpoints = props.instances.filter((instance) =>
    isModelEndpointDriverKind(instance.driverKind),
  );
  // Offered in this list's order, ChatGPT first, whatever order the catalog
  // keeps.
  const offers = subscriptionOAuthOffers();
  const signInOffers = Object.keys(SIGN_IN_ENDPOINTS).flatMap((descriptorId) =>
    offers.filter(
      (offer) =>
        String(offer.descriptor.descriptorId) === descriptorId &&
        offer.driverKinds.includes("openai-compatible"),
    ),
  );

  async function addSignInEndpoint(offer: SubscriptionOAuthOffer): Promise<void> {
    const presentation = SIGN_IN_ENDPOINTS[offer.descriptor.descriptorId];
    if (presentation === undefined) return;
    const instanceId = decodeProviderInstanceId(crypto.randomUUID());
    // The base URL is the offer's own endpoint and there is no key: the
    // sign-in is the credential. The host refuses a sign-in, and any use of
    // its token, on an endpoint whose origin is not the offer's.
    const created = await props.onCreateOpenAiCompatible(
      presentation.displayName,
      {
        kind: "openai-compatible-http",
        baseUrl: offer.allowedEndpoint,
        authentication: "bearer",
        protocol: presentation.protocol,
        manualModelIds: [],
        oauthDescriptorId: offer.descriptor.descriptorId,
      },
      { value: "", clear: () => undefined },
      instanceId,
    );
    if (created) setSignInStartingId(instanceId);
  }

  return (
    <div className="provider-settings" id="settings-model-endpoints">
      <div aria-live="polite" className="provider-settings__message-slot">
        {props.message === undefined ? null : (
          <OctantAlert className="provider-settings__alert" tone="warning">
            {props.message}
          </OctantAlert>
        )}
      </div>
      <ProviderSettingsList
        {...props}
        createForm={
          <div className="model-endpoints__add">
            <div className="setgroup">
              <SettingRow
                description="Sign in with a subscription, or add an endpoint by its base URL."
                focused={props.focused === true}
                label="Add a model endpoint"
                scope="host"
                settingId="model-endpoints"
              >
                <div className="model-endpoints__sign-ins">
                  {signInOffers.map((offer) => (
                    <OctantButton
                      disabled={props.busy || props.status !== "ready"}
                      key={offer.descriptor.descriptorId}
                      onClick={() => void addSignInEndpoint(offer)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {SIGN_IN_ENDPOINTS[offer.descriptor.descriptorId]?.action}
                    </OctantButton>
                  ))}
                </div>
                {props.credentialManagementAvailable ? null : (
                  // A browser cannot tell whether the host reads it as local
                  // or as a paired device, so this states the host's rule
                  // rather than telling a local browser it may not sign in.
                  <p className="provider-settings__field-guidance">
                    Sign-in starts from the Octant app or a browser on the host; the host refuses
                    one started from a paired device.
                  </p>
                )}
              </SettingRow>
            </div>
            <ProviderCreateForm
              {...props}
              allowedProviderTypes={MODEL_ENDPOINT_DRIVER_KINDS}
              heading="Model endpoint"
              hint="Connect an OpenAI-compatible, Anthropic-compatible, Ollama, or Azure AI Foundry endpoint by its base URL. Keys stay in the host's secure store."
              initialProviderType="openai-compatible"
              triggerLabel="Add endpoint"
            />
          </div>
        }
        discoverySnapshot={props.discoverySnapshot}
        emptyLabel="No model endpoints yet."
        heading="Model endpoints"
        instances={endpoints}
        note="Endpoints Octant calls over an API itself. Their models appear under Octant in the model picker."
        showAgentEligibleModels={false}
        showReorder={false}
        {...(signInStartingId === undefined ? {} : { signInStartingId })}
      />
    </div>
  );
}
