import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import {
  createMobileServiceOfferClient,
  imageOfferModelChoices,
  type ServiceOfferClient,
} from "@octant/client-runtime/service-offer-client";
import {
  decodeImageGenerationScopeId,
  type ServiceOffer,
  type ServiceOfferDecision,
  type ServiceOffersResponse,
} from "@octant/contracts";
import { useTheme } from "../../design-system";
import { ApprovalDecisionButtons } from "../approvals/ApprovalDecisionButtons";
import { MOBILE_COPY } from "../copy";
import { usePolledResource } from "../runtime/usePolledResource";
import { decideWithConfirmation, type BiometricAuthenticator } from "../security/BiometricGate";
import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { ModelPickerSheet } from "../ui/ModelPickerSheet";

export function ServiceOfferCard(props: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly threadKind: ServiceOffer["threadKind"];
  readonly inProject: boolean;
  readonly authenticator?: BiometricAuthenticator;
}) {
  const { transport, threadId, threadKind, inProject, authenticator } = props;
  const client = useMemo(() => createMobileServiceOfferClient(transport), [transport]);
  const load = useCallback(
    () => client.offers({ threadKind, scopeId: decodeImageGenerationScopeId(threadId) }),
    [client, threadKind, threadId],
  );
  const resource = usePolledResource(load, { intervalMs: 2_000 });
  const offer = resource.value?.offers[0];
  if (offer === undefined) return null;
  return (
    <OfferCard
      key={String(offer.offerId)}
      authenticator={authenticator}
      client={client}
      inProject={inProject}
      offer={offer}
      profiles={resource.value?.imageProfiles}
      reload={resource.reload}
      stale={resource.error !== undefined}
    />
  );
}

function OfferCard(props: {
  readonly authenticator?: BiometricAuthenticator | undefined;
  readonly client: ServiceOfferClient;
  readonly inProject: boolean;
  readonly offer: ServiceOffer;
  readonly profiles: ServiceOffersResponse["imageProfiles"];
  readonly reload: () => Promise<void>;
  readonly stale: boolean;
}) {
  const { offer } = props;
  const { colors } = useTheme();
  const deviceAuthenticator = useMemo(() => createExpoBiometricAuthenticator(), []);
  const [remember, setRemember] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [selecting, setSelecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [settled, setSettled] = useState(false);
  const [note, setNote] = useState<string>();
  const references = offer.kind === "generate" ? offer.references : undefined;
  const choices =
    offer.kind === "generate"
      ? imageOfferModelChoices(props.profiles ?? [], offer.suggested, references !== undefined)
      : [];
  const choice = choices.find((candidate) => candidate.id === selected) ?? choices[0];
  const unavailable = props.stale || busy;

  async function decide(answer: ServiceOfferDecision) {
    if (inFlight.current || props.stale) return;
    inFlight.current = true;
    setBusy(true);
    setNote(undefined);
    try {
      const send = () => props.client.decide(answer);
      const result =
        answer.decision === "generate" ||
        answer.decision === "save" ||
        answer.decision === "transcribe"
          ? await decideWithConfirmation({
              authenticator: props.authenticator ?? deviceAuthenticator,
              reason: "approve",
              send,
            })
          : { status: "sent" as const, value: await send() };
      if (result.status === "blocked") setNote(result.message);
      else if (result.value.kind === "offer-refused") setNote(result.value.reason);
      else setSettled(true);
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      void props.reload();
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (settled) return null;
  const text = { ...mobileTypography.caption, color: colors.textSecondary };
  const cancel = () => void decide({ offerId: offer.offerId, decision: "cancel" });
  const approve = () => {
    if (offer.kind === "transcribe")
      void decide({ offerId: offer.offerId, decision: "transcribe", rememberForThread: remember });
    else if (offer.kind === "save") void decide({ offerId: offer.offerId, decision: "save" });
    else if (choice !== undefined) {
      void decide({
        offerId: offer.offerId,
        decision: "generate",
        profileInstanceId: choice.profileInstanceId,
        modelId: choice.modelId,
        rememberForThread: references === undefined && remember,
        ...(references === undefined ? {} : { referenceImagesConfirmed: true }),
      });
    }
  };
  const rememberLabel =
    "Don't ask again in this " +
    (offer.kind === "generate" && props.inProject ? "Project" : "thread");
  return (
    <View style={[styles.card, { borderColor: colors.border }]} testID="mobile-service-offer">
      <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>
        {offer.kind === "transcribe"
          ? "Transcribe this recording?"
          : offer.kind === "save"
            ? "Save this image as a new file?"
            : "Generate this image?"}
      </Text>
      <Text style={text}>{offer.kind === "generate" ? offer.prompt : offer.relativePath}</Text>
      {offer.kind === "transcribe" ? (
        <Text style={text}>
          {offer.sizeBytes.toLocaleString()} bytes · Sent to {offer.endpointName} ({offer.modelId}).
          Your provider may charge for transcription.
        </Text>
      ) : offer.kind === "save" ? (
        <Text style={text}>
          The image saves under the thread’s folder without replacing a file.
        </Text>
      ) : (
        <>
          <Text style={text}>
            {offer.variantCount} {offer.variantCount === 1 ? "image" : "images"} · Uses the selected
            provider
          </Text>
          {references === undefined ? null : (
            <>
              <Text style={text}>These images will be sent to the selected image provider:</Text>
              {references.map((reference, index) => (
                <Text key={index} style={text}>
                  {reference.label}
                  {reference.signedIn === true ? " (signed-in page)" : ""}
                </Text>
              ))}
            </>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={unavailable}
            onPress={() => setSelecting(true)}
            style={styles.choice}
          >
            <Text style={[mobileTypography.body, { color: colors.textPrimary }]}>
              {choice?.label ?? "Choose an image model"}
            </Text>
          </Pressable>
          <ModelPickerSheet
            visible={selecting}
            onClose={() => setSelecting(false)}
            options={choices}
            selectedId={choice?.id}
            onSelect={(id) => {
              setSelected(id);
              setSelecting(false);
            }}
          />
        </>
      )}
      {offer.kind !== "save" && references === undefined ? (
        <View style={styles.remember}>
          <Text style={[text, styles.rememberLabel]}>{rememberLabel}</Text>
          <Switch
            accessibilityLabel={rememberLabel}
            disabled={unavailable}
            onValueChange={setRemember}
            value={remember}
          />
        </View>
      ) : null}
      <ApprovalDecisionButtons
        allowDisabled={offer.kind === "generate" && choice === undefined}
        allowLabel={
          offer.kind === "transcribe" ? "Transcribe" : offer.kind === "save" ? "Save" : "Generate"
        }
        busy={unavailable}
        denyLabel={
          offer.kind === "transcribe"
            ? "Don't transcribe"
            : offer.kind === "save"
              ? "Don't save"
              : "Cancel"
        }
        onAllow={approve}
        onDeny={cancel}
        narrower={
          offer.kind !== "generate"
            ? undefined
            : {
                label: "Let the agent draw it",
                onPress: () => void decide({ offerId: offer.offerId, decision: "agent-draws" }),
              }
        }
      />
      {props.stale || note !== undefined ? (
        <Text accessibilityLiveRegion="polite" style={text}>
          {props.stale ? MOBILE_COPY.approvalReconnecting : note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: mobileSpacing.md,
    marginBottom: mobileSpacing.sm,
    padding: mobileSpacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    gap: mobileSpacing.xs,
  },
  choice: { minHeight: 44, justifyContent: "center" },
  remember: { flexDirection: "row", alignItems: "center", gap: mobileSpacing.sm },
  rememberLabel: { flex: 1 },
});
