import {
  decodeProviderInstanceId,
  type HiddenProviderModelRef,
  type ProviderInstanceId,
  type ProviderObservedState,
} from "@octant/contracts";
import type { SubscriptionOAuthOffer } from "@octant/contracts/host-oauth";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { boundSubscriptionOffer } from "../providers/configuration/HttpConfigurationForms";
import { isModelEndpointDriverKind } from "../providers/providerSettingsPresentation";
import type { ProviderSettingsViewProps } from "../providers/ProviderSettingsView";
import type { ProviderProbeFailure } from "../providers/useProviderController";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingsSection } from "./primitives";
import { AddEndpointDialog, EndpointChoices, SIGN_IN_ENDPOINTS } from "./harness/AddModelEndpoint";
import {
  endpointModelCount,
  endpointStatus,
  endpointSubLine,
  type EndpointFixKind,
  type EndpointStatus,
  type ModelEndpointInstance,
} from "./harness/endpointStatus";
import { ModelEndpointDetail, type EndpointDetailFocus } from "./harness/ModelEndpointDetail";
import { ModelEndpointRow } from "./harness/ModelEndpointRow";
import { useEndpointSignIns } from "./harness/useEndpointSignIns";

export type ModelEndpointSettingsViewProps = Omit<ProviderSettingsViewProps, "discovery"> & {
  /** A deep link landed on Model endpoints: the first way in takes focus. */
  readonly focused?: boolean;
  /** The last failed check per endpoint, as the probe command answered it. */
  readonly probeFailures?: ReadonlyMap<ProviderInstanceId, ProviderProbeFailure>;
  /** The model roles that name an endpoint's models, for the Remove confirmation. */
  readonly onRolesUsing?: (instanceId: string) => Promise<ReadonlyArray<string>>;
  /** Told when an endpoint's detail sub-page opens (with its name) or closes. */
  readonly onDetailChange?: (endpointName: string | undefined) => void;
};

interface OpenDetail {
  readonly id: ProviderInstanceId;
  readonly startSignIn: boolean;
  readonly consentShown: boolean;
  readonly focus: EndpointDetailFocus | undefined;
}

/**
 * Octant Harness › Model endpoints: the chat-model endpoints Octant calls over
 * an API itself, as rows in one card. A row says whether the endpoint works
 * and, when it doesn't, why and its one fix; everything else is on the
 * endpoint's detail sub-page. These are the same provider instances, commands,
 * and credential handling Providers & Models uses; only where Settings lists
 * them differs.
 */
export function ModelEndpointSettingsView(props: ModelEndpointSettingsViewProps): ReactNode {
  const [detail, setDetail] = useState<OpenDetail>();
  const [returnFocusTo, setReturnFocusTo] = useState<ProviderInstanceId>();
  const [adding, setAdding] = useState(false);
  // Set once the add form has submitted; the endpoint it made, if any, is the
  // one the registry lists that it did not list when the dialog opened.
  const [addSubmitted, setAddSubmitted] = useState(false);
  const idsWhenAddOpened = useRef<ReadonlySet<string>>(new Set());
  const probedAdded = useRef<string | undefined>(undefined);
  const section = useRef<HTMLDivElement>(null);
  const endpoints = useMemo(
    () =>
      props.instances.filter((instance): instance is ModelEndpointInstance =>
        isModelEndpointDriverKind(instance.driverKind),
      ),
    [props.instances],
  );
  const signInTargets = useMemo(
    () =>
      endpoints.flatMap((instance) => {
        const offer = signInOfferOf(instance);
        return offer === undefined
          ? []
          : [{ instanceId: String(instance.id), descriptorId: offer.descriptor.descriptorId }];
      }),
    [endpoints],
  );
  const { signIns, record } = useEndpointSignIns(signInTargets, props.onProviderOAuth);
  const presentation = props.presentationObservedByInstance ?? props.observedByInstance;
  const hiddenModels = props.defaults.hiddenModels ?? [];
  const busy = props.busy || props.status !== "ready";

  const describe = (instance: ModelEndpointInstance) => {
    const offer = signInOfferOf(instance);
    const presentationOffer =
      offer === undefined
        ? undefined
        : {
            accountLabel: offer.accountLabel,
            action: SIGN_IN_ENDPOINTS[offer.descriptor.descriptorId]?.action ?? "Sign in",
          };
    const signIn = offer === undefined ? undefined : signIns.get(String(instance.id));
    // The last observed facts keep a row's count while it is checked again;
    // its state reads only the authoritative observation.
    const observed: ProviderObservedState | undefined = presentation.get(instance.id);
    const failure = props.probeFailures?.get(instance.id);
    const checking =
      props.probingIds.has(instance.id) || props.updatingIds?.has(instance.id) === true;
    const status = endpointStatus({
      instance,
      observed: props.observedByInstance.get(instance.id),
      checking,
      ...(failure === undefined ? {} : { failure }),
      ...(signIn === undefined ? {} : { signIn }),
      ...(presentationOffer === undefined ? {} : { signInOffer: presentationOffer }),
    });
    return { offer, presentationOffer, signIn, observed, failure, status, checking };
  };

  const openEndpoint = (
    id: ProviderInstanceId,
    options: {
      readonly startSignIn?: boolean;
      readonly consentShown?: boolean;
      readonly focus?: EndpointDetailFocus;
    } = {},
  ) => {
    setAdding(false);
    setAddSubmitted(false);
    setDetail({
      id,
      startSignIn: options.startSignIn === true,
      consentShown: options.consentShown === true,
      focus: options.focus,
    });
  };
  const closeDetail = () => {
    if (detail !== undefined) setReturnFocusTo(detail.id);
    setDetail(undefined);
  };

  const fixRow = (instance: ModelEndpointInstance, kind: EndpointFixKind) => {
    if (kind === "try-again" || kind === "check-now") {
      void props.onProbe(instance.id, { quiet: true });
    } else if (kind === "sign-in") {
      // The row shows the consent line exactly when the host says the terms
      // still need acknowledging; without it the page asks before signing in.
      const signIn = signIns.get(String(instance.id));
      openEndpoint(instance.id, {
        startSignIn: true,
        consentShown: signIn?.kind === "signed-out" && signIn.termsRequired,
      });
    } else if (kind === "sign-in-again") {
      openEndpoint(instance.id, { startSignIn: true });
    } else if (kind === "replace-key" || kind === "add-key") {
      openEndpoint(instance.id, { focus: "key" });
    } else if (kind === "edit-address") {
      openEndpoint(instance.id, { focus: "address" });
    } else {
      openEndpoint(instance.id, { focus: "model-ids" });
    }
  };

  async function addSignInEndpoint(offer: SubscriptionOAuthOffer): Promise<void> {
    const entry = SIGN_IN_ENDPOINTS[offer.descriptor.descriptorId];
    if (entry === undefined) return;
    const instanceId = decodeProviderInstanceId(crypto.randomUUID());
    // The base URL is the offer's own endpoint and there is no key: the
    // sign-in is the credential. The host refuses a sign-in, and any use of
    // its token, on an endpoint whose origin is not the offer's.
    const created = await props.onCreateOpenAiCompatible(
      entry.displayName,
      {
        kind: "openai-compatible-http",
        baseUrl: offer.allowedEndpoint,
        authentication: "bearer",
        protocol: entry.protocol,
        manualModelIds: [],
        oauthDescriptorId: offer.descriptor.descriptorId,
      },
      { value: "", clear: () => undefined },
      instanceId,
    );
    // The first-run and dialog choices carry the consent line under their buttons.
    if (created) openEndpoint(instanceId, { startSignIn: true, consentShown: true });
  }

  const openInstance =
    detail === undefined
      ? undefined
      : endpoints.find((instance) => String(instance.id) === String(detail.id));
  const { onDetailChange } = props;
  const openName = openInstance?.displayName;
  useEffect(() => {
    onDetailChange?.(openName);
  }, [onDetailChange, openName]);
  useEffect(() => () => onDetailChange?.(undefined), [onDetailChange]);

  // A removed endpoint closes its own page. One just created by a sign-in is
  // opened before the registry lists it, so only an endpoint the page has
  // already shown counts as removed.
  const shownOpen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (openInstance !== undefined) {
      shownOpen.current = String(openInstance.id);
      return;
    }
    if (detail !== undefined && shownOpen.current === String(detail.id)) {
      shownOpen.current = undefined;
      setDetail(undefined);
    }
  }, [detail, openInstance]);

  // Back returns focus to the row the page was opened from.
  useEffect(() => {
    if (detail !== undefined || returnFocusTo === undefined) return;
    const row = section.current?.querySelector<HTMLElement>(
      `[data-endpoint-id="${String(returnFocusTo)}"]`,
    );
    (row ?? section.current?.querySelector<HTMLElement>("button"))?.focus();
    setReturnFocusTo(undefined);
  }, [detail, returnFocusTo]);

  // A deep link to Model endpoints lands on the first way to add one.
  const empty = endpoints.length === 0;
  useEffect(() => {
    if (props.focused !== true || detail !== undefined) return;
    const target = section.current?.querySelector<HTMLElement>("button:not(:disabled)");
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  }, [props.focused, detail, empty]);

  // The endpoint the add dialog just created, checked once so its result
  // shows in the dialog.
  const addedInstance = !addSubmitted
    ? undefined
    : endpoints.find((instance) => !idsWhenAddOpened.current.has(String(instance.id)));
  const { onProbe } = props;
  useEffect(() => {
    if (addedInstance === undefined || probedAdded.current === String(addedInstance.id)) return;
    probedAdded.current = String(addedInstance.id);
    void onProbe(addedInstance.id, { quiet: true });
  }, [addedInstance, onProbe]);

  const message =
    props.message === undefined ? null : (
      <OctantAlert className="provider-settings__alert" tone="warning">
        {props.message}
      </OctantAlert>
    );

  if (openInstance !== undefined && detail !== undefined) {
    const described = describe(openInstance);
    return (
      <div className="provider-settings" id="settings-model-endpoints" ref={section}>
        <div aria-live="polite" className="provider-settings__message-slot">
          {message}
        </div>
        <ModelEndpointDetail
          {...props}
          busy={busy}
          checking={described.checking}
          failure={described.failure}
          focusOnOpen={detail.focus}
          hiddenModels={hiddenModels}
          instance={openInstance}
          key={String(openInstance.id)}
          observed={described.observed}
          onBack={closeDetail}
          onSignInState={(state) => {
            const prior = signIns.get(String(openInstance.id));
            record(String(openInstance.id), state);
            // A sign-in that just finished is checked straight away, so the
            // row says Ready without a separate check.
            if (state.kind === "signed-in" && prior?.kind !== "signed-in") {
              void props.onProbe(openInstance.id, { quiet: true });
            }
          }}
          signIn={described.signIn}
          signInOffer={described.presentationOffer}
          signInConsentShown={detail.consentShown}
          startSignIn={detail.startSignIn}
          status={described.status}
        />
      </div>
    );
  }

  // The new endpoint's check, shown in the add dialog. Opening it to fix lands
  // on the field the fix names, as the row's fix would.
  const addedResult = (instance: ModelEndpointInstance) => {
    const { status } = describe(instance);
    const fix = status.fix;
    return {
      name: instance.displayName,
      status,
      onOpen: () =>
        fix === undefined || fix.kind === "try-again" || fix.kind === "check-now"
          ? openEndpoint(instance.id)
          : fixRow(instance, fix.kind),
    };
  };
  const openAdd = () => {
    idsWhenAddOpened.current = new Set(endpoints.map((instance) => String(instance.id)));
    probedAdded.current = undefined;
    setAddSubmitted(false);
    setAdding(true);
  };
  // A keyed endpoint can exist even when its create reports failure, because
  // the host makes it before the key is stored; the dialog then goes on to the
  // endpoint that was made rather than inviting a duplicate.
  const afterSubmit =
    <Args extends ReadonlyArray<unknown>>(create: (...args: Args) => Promise<boolean>) =>
    async (...args: Args): Promise<boolean> => {
      try {
        return await create(...args);
      } finally {
        setAddSubmitted(true);
      }
    };
  const addDialog = (
    <AddEndpointDialog
      {...props}
      busy={busy}
      onClose={() => {
        setAdding(false);
        setAddSubmitted(false);
      }}
      onCreateAnthropicCompatible={afterSubmit(props.onCreateAnthropicCompatible)}
      onCreateAzureFoundry={afterSubmit(props.onCreateAzureFoundry)}
      onCreateOllama={afterSubmit(props.onCreateOllama)}
      onCreateOpenAiCompatible={afterSubmit(props.onCreateOpenAiCompatible)}
      onSignIn={(offer) => void addSignInEndpoint(offer)}
      open={adding}
      {...(addedInstance === undefined ? {} : { added: addedResult(addedInstance) })}
    />
  );

  if (empty) {
    return props.status !== "ready" ? null : (
      <div className="provider-settings" id="settings-model-endpoints" ref={section}>
        <div aria-live="polite" className="provider-settings__message-slot">
          {message}
        </div>
        <SettingsSection
          description="Octant's agent needs at least one. You can add more later."
          title="Connect a model endpoint"
        >
          <EndpointChoices
            credentialManagementAvailable={props.credentialManagementAvailable}
            disabled={busy}
            onAddEndpoint={openAdd}
            onSignIn={(offer) => void addSignInEndpoint(offer)}
          />
        </SettingsSection>
        {addDialog}
      </div>
    );
  }

  const rows = endpoints.map((instance) => ({ instance, ...describe(instance) }));
  return (
    <div className="provider-settings" id="settings-model-endpoints" ref={section}>
      <div aria-live="polite" className="provider-settings__message-slot">
        {message}
      </div>
      <SettingsSection
        actions={
          <OctantButton disabled={busy} onClick={openAdd} size="sm" type="button" variant="ghost">
            <Plus aria-hidden="true" size={14} />
            Add endpoint
          </OctantButton>
        }
        description={
          <>
            Services Octant sends requests to itself. Their models appear under Octant in the model
            picker.{" "}
            <span aria-label="Endpoint summary" className="endpoint-list__summary" role="status">
              {summarize(rows.map((row) => row.status))}
            </span>
          </>
        }
        title="Model endpoints"
      >
        <ul aria-label="Model endpoints" className="endpoint-list">
          {rows.map((row) => (
            <ModelEndpointRow
              disabled={busy}
              instance={row.instance}
              key={String(row.instance.id)}
              {...rowMeta(row.status, row.instance, row.observed, hiddenModels)}
              onFix={(kind) => fixRow(row.instance, kind)}
              onOpen={() => openEndpoint(row.instance.id)}
              {...(row.offer !== undefined &&
              row.signIn?.kind === "signed-out" &&
              row.signIn.termsRequired
                ? { signInTerms: row.offer.termsSummary }
                : {})}
              status={row.status}
              subLine={endpointSubLine(row.instance, row.signIn, row.presentationOffer)}
            />
          ))}
        </ul>
      </SettingsSection>
      {addDialog}
    </div>
  );
}

function rowMeta(
  status: EndpointStatus,
  instance: ModelEndpointInstance,
  observed: ProviderObservedState | undefined,
  hiddenModels: ReadonlyArray<HiddenProviderModelRef>,
): { readonly meta?: string } {
  if (status.tone === "off") return { meta: "kept, not offered" };
  if (status.tone === "failed") return {};
  const meta = endpointModelCount(instance, observed, hiddenModels);
  return meta === undefined ? {} : { meta };
}

function signInOfferOf(instance: ModelEndpointInstance): SubscriptionOAuthOffer | undefined {
  if (instance.driverKind !== "openai-compatible" && instance.driverKind !== "anthropic-compatible")
    return undefined;
  return boundSubscriptionOffer(instance);
}

/** "2 ready · 1 needs you · 1 off", leaving out what is zero. */
function summarize(statuses: ReadonlyArray<EndpointStatus>): string {
  let ready = 0;
  let needsYou = 0;
  let off = 0;
  for (const status of statuses) {
    if (status.tone === "ready") ready += 1;
    else if (status.tone === "off") off += 1;
    else if (status.tone !== "checking") needsYou += 1;
  }
  return [
    ready === 0 ? undefined : `${ready} ready`,
    needsYou === 0 ? undefined : `${needsYou} ${needsYou === 1 ? "needs" : "need"} you`,
    off === 0 ? undefined : `${off} off`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}
