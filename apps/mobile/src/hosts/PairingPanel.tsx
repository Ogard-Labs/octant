import { mobileRemoteFetch } from "../runtime/mobileRemoteFetch";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  createRemotePairingClient,
  isRemotePairingFailure,
  openAppPairingCode,
  type RemoteDeviceKeyStore,
  type RemotePairingClaim,
  type RemotePairingClient,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import { mobilePinnedListenerTransport } from "../runtime/mobilePinnedListenerTransport";
import { PairingCodeScanner } from "./PairingCodeScanner";
import {
  pairingFailureMessage,
  pairingPollDelayMs,
  pairingStatusFailureKeepsClaim,
} from "./pairingStatusPolicy";
import { MOBILE_COPY, MOBILE_PRODUCT_NAME } from "../copy";
import { GlassSurface, useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { finishLiveMobilePairing } from "../session/mobileSessionLifecycle";
import type { MobileHostRegistry } from "./HostRegistry";

export interface PairingPanelProps {
  readonly registry: MobileHostRegistry;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly bridge: RemoteSessionBridge;
  readonly deviceLabel?: string;
  readonly onPaired?: () => void;
  /** Focused mockup layout (headline + card). Default true. */
  readonly focused?: boolean;
  /** Open the QR scanner as soon as the screen appears (the first-run path). */
  readonly openScanner?: boolean;
}

interface PendingPhase {
  readonly kind: "pending";
  readonly claim: RemotePairingClaim;
  readonly ticketProof: string;
  /** The client a pairing code opened, held to the code's pin. */
  readonly client?: RemotePairingClient;
  /** Why the last check did not settle; the claim stays pending so the ticket is not lost. */
  readonly notice?: string;
  /** The host refused a check for speed, so the next one waits longer. */
  readonly rateLimited?: boolean;
}

type PairingPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly message: string }
  | PendingPhase
  | { readonly kind: "approved"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export function PairingPanel(props: PairingPanelProps) {
  const { colors } = useTheme();
  const focused = props.focused !== false;
  const [pairingCode, setPairingCode] = useState("");
  const [scanning, setScanning] = useState(props.openScanner === true);
  const [showCode, setShowCode] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [originInput, setOriginInput] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [ticketProof, setTicketProof] = useState("");
  const [phase, setPhase] = useState<PairingPhase>({ kind: "idle" });
  const deviceKeyStore = props.deviceKeyStore;
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController();
    lifetime.current = current;
    return () => current.abort();
  }, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.md },
        headline: {
          color: colors.textPrimary,
          fontSize: 28,
          fontWeight: "500",
          letterSpacing: -0.3,
        },
        subhead: {
          color: colors.textSecondary,
          fontSize: mobileTypography.body.fontSize,
          lineHeight: 20,
          marginBottom: mobileSpacing.sm,
        },
        title: {
          color: colors.textPrimary,
          fontSize: mobileTypography.title.fontSize,
          fontWeight: mobileTypography.title.fontWeight,
        },
        help: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
          lineHeight: 18,
        },
        card: {
          padding: mobileSpacing.md,
          gap: mobileSpacing.md,
        },
        field: { gap: 6 },
        label: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
          fontWeight: "500",
        },
        inputRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: mobileSpacing.sm,
          backgroundColor: colors.surfaceElevated,
          borderRadius: mobileRadii.sm,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: 12,
        },
        input: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: mobileTypography.body.fontSize,
          padding: 0,
        },
        button: {
          backgroundColor: colors.accent,
          paddingVertical: 14,
          alignItems: "center",
          borderRadius: mobileRadii.pill,
        },
        buttonLabel: {
          color: colors.sendLabel,
          fontWeight: "500",
          fontSize: mobileTypography.body.fontSize,
        },
        buttonSecondary: {
          marginTop: mobileSpacing.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.accent,
          paddingVertical: mobileSpacing.sm,
          alignItems: "center",
          borderRadius: mobileRadii.pill,
        },
        buttonSecondaryLabel: {
          color: colors.accent,
          fontWeight: "500",
        },
        link: { alignItems: "center", paddingVertical: mobileSpacing.xs },
        linkLabel: {
          color: colors.accent,
          fontWeight: "500",
          fontSize: mobileTypography.body.fontSize,
        },
        linkLabelSmall: {
          color: colors.accent,
          fontSize: mobileTypography.caption.fontSize,
        },
        note: {
          color: colors.textTertiary,
          fontSize: 12,
          textAlign: "center",
          lineHeight: 16,
        },
        statusBox: {
          gap: mobileSpacing.sm,
          padding: mobileSpacing.md,
          backgroundColor: colors.surface,
          borderRadius: mobileRadii.md,
        },
        statusTitle: {
          color: colors.textPrimary,
          fontWeight: "500",
        },
        statusBody: {
          color: colors.textSecondary,
        },
        success: {
          color: colors.success,
        },
        error: {
          color: colors.danger,
        },
      }),
    [colors],
  );

  const startPairingFromCode = async (code: string) => {
    setPhase({ kind: "working", message: "Contacting host…" });
    try {
      const opened = await openAppPairingCode({
        code,
        transport: mobilePinnedListenerTransport,
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/0.1.0`,
        deviceKeyStore,
      });
      if (opened.status !== "opened") {
        setPhase({ kind: "failed", message: opened.message });
        return;
      }
      const claimed = await opened.claim(props.deviceLabel ?? `${MOBILE_PRODUCT_NAME} Mobile`);
      if (claimed.status !== "claimed") {
        setPhase({ kind: "failed", message: claimed.message });
        return;
      }
      setPhase({
        kind: "pending",
        claim: claimed.claim,
        ticketProof: opened.ticket.ticketProof,
        client: opened.client,
      });
    } catch (error) {
      // Without this a network failure leaves the "Contacting host" spinner up for good.
      setPhase({ kind: "failed", message: pairingFailureMessage(error) });
    }
  };

  const startPairing = async () => {
    if (pairingCode.trim().length > 0) {
      await startPairingFromCode(pairingCode);
      return;
    }
    const origin = originInput.trim().replace(/\/$/, "");
    if (!origin.startsWith("https://")) {
      setPhase({ kind: "failed", message: MOBILE_COPY.pairAddressInvalid });
      return;
    }
    if (ticketId.trim().length === 0 || ticketProof.trim().length === 0) {
      setPhase({ kind: "failed", message: MOBILE_COPY.pairTicketRequired });
      return;
    }

    setPhase({ kind: "working", message: "Contacting host…" });
    try {
      const client = createRemotePairingClient({
        baseUrl: `${origin}/`,
        fetch: mobileRemoteFetch,
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/0.1.0`,
        deviceKeyStore,
      });
      const hostHello = await client.requestHostHello();
      const claim = await client.claimPairing({
        ticket: { ticketId: ticketId.trim(), ticketProof: ticketProof.trim() },
        deviceLabel: props.deviceLabel ?? `${MOBILE_PRODUCT_NAME} Mobile`,
        hostHello,
      });
      setPhase({ kind: "pending", claim, ticketProof: ticketProof.trim() });
    } catch (error) {
      setPhase({
        kind: "failed",
        message: isRemotePairingFailure(error) ? error.message : MOBILE_COPY.pairFailedGeneric,
      });
    }
  };

  const checking = useRef(false);
  const pollStatus = async (current: PendingPhase) => {
    // A manual check and the timer can coincide; one request at a time keeps the host's rate limit.
    if (checking.current) return;
    checking.current = true;
    const signal = lifetime.current.signal;
    const keepPending = (notice: string, rateLimited: boolean) => {
      if (!signal.aborted) setPhase({ ...current, notice, rateLimited });
    };
    try {
      const origin = current.claim.origin;
      const client =
        current.client ??
        createRemotePairingClient({
          baseUrl: `${origin}/`,
          fetch: mobileRemoteFetch,
          webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/0.1.0`,
          deviceKeyStore,
        });
      const status = await client.pollPairingStatus({
        ticket: { ticketId: current.claim.ticketId, ticketProof: current.ticketProof },
        claim: current.claim,
      });
      if (signal.aborted) return;
      if (status.kind === "pending") {
        // Keep the client a code opened, so the next check stays on its pin.
        setPhase({
          kind: "pending",
          claim: status.claim,
          ticketProof: current.ticketProof,
          ...(current.client === undefined ? {} : { client: current.client }),
        });
        return;
      }
      if (status.kind === "failed") {
        if (pairingStatusFailureKeepsClaim(status)) {
          keepPending(status.message, status.category === "rate-limited");
          return;
        }
        setPhase({ kind: "failed", message: status.message });
        return;
      }
      const connected = await finishLiveMobilePairing({
        registry: props.registry,
        bridge: props.bridge,
        approval: status.approval,
        signal,
        registration: {
          hostId: status.approval.hostId,
          origin: status.approval.origin,
          label: current.claim.hostDisplayName,
          keyId: status.approval.deviceKeyId,
          credentialGeneration: status.approval.credentialGeneration,
          hostKeyFingerprint: current.claim.hostKeyFingerprint,
        },
      });
      if (!connected || signal.aborted) return;
      setPhase({
        kind: "approved",
        message: `Paired with ${current.claim.hostDisplayName}.`,
      });
      props.onPaired?.();
    } catch (error) {
      keepPending(
        isRemotePairingFailure(error)
          ? error.message
          : "Couldn't reach the computer yet. Still waiting for approval.",
        isRemotePairingFailure(error) && error.category === "rate-limited",
      );
    } finally {
      checking.current = false;
    }
  };

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      setAppActive(next === "active");
    });
    return () => subscription.remove();
  }, []);

  // Each check replaces the phase, which re-arms this timer; approval, failure
  // and unmount end the loop.
  useEffect(() => {
    if (phase.kind !== "pending" || !appActive) return;
    const timer = setTimeout(
      () => {
        void pollStatus(phase);
      },
      pairingPollDelayMs(phase.rateLimited === true ? "rate-limited" : "ok"),
    );
    return () => clearTimeout(timer);
  }, [phase, appActive]);

  const textField = (input: {
    readonly label: string;
    readonly icon: "key-outline" | "globe-outline" | "ticket-outline" | "shield-checkmark-outline";
    readonly placeholder: string;
    readonly value: string;
    readonly onChangeText: (value: string) => void;
    readonly testID: string;
    readonly secure?: boolean;
  }) => (
    <View style={styles.field}>
      <Text style={styles.label}>{input.label}</Text>
      <View style={styles.inputRow}>
        <Ionicons color={colors.textTertiary} name={input.icon} size={18} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={input.onChangeText}
          placeholder={input.placeholder}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={input.secure === true}
          style={styles.input}
          testID={input.testID}
          value={input.value}
        />
      </View>
    </View>
  );

  const fields = (
    <>
      <Text style={styles.help}>{MOBILE_COPY.pairCodeHint}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setScanning(true)}
        style={styles.button}
        testID="mobile-pairing-scan"
      >
        <Text style={styles.buttonLabel}>Scan QR code</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => setShowCode((open) => !open)}
        style={styles.link}
        testID="mobile-pairing-enter-code"
      >
        <Text style={styles.linkLabel}>{MOBILE_COPY.pairEnterCode}</Text>
      </Pressable>
      {showCode
        ? textField({
            label: "Pairing code",
            icon: "key-outline",
            placeholder: "Paste the octant-pair-1 code",
            value: pairingCode,
            onChangeText: setPairingCode,
            testID: "mobile-pairing-code",
          })
        : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => setShowDetails((open) => !open)}
        style={styles.link}
        testID="mobile-pairing-type-details"
      >
        <Text style={styles.linkLabelSmall}>{MOBILE_COPY.pairTypeDetails}</Text>
      </Pressable>
      {showDetails ? (
        <>
          {textField({
            label: "Computer address",
            icon: "globe-outline",
            placeholder: "Computer address (https://…)",
            value: originInput,
            onChangeText: setOriginInput,
            testID: "mobile-pairing-origin",
          })}
          {textField({
            label: "Pairing ticket",
            icon: "ticket-outline",
            placeholder: "Pairing ticket",
            value: ticketId,
            onChangeText: setTicketId,
            testID: "mobile-pairing-ticket-id",
          })}
          {textField({
            label: "Ticket secret",
            icon: "shield-checkmark-outline",
            placeholder: "Ticket secret",
            value: ticketProof,
            onChangeText: setTicketProof,
            testID: "mobile-pairing-ticket-proof",
            secure: true,
          })}
        </>
      ) : null}
      {showCode || showDetails ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void startPairing();
          }}
          style={styles.buttonSecondary}
          testID="mobile-pairing-start"
        >
          <Text style={styles.buttonSecondaryLabel}>Start pairing</Text>
        </Pressable>
      ) : null}
    </>
  );

  const scanner = (
    <PairingCodeScanner
      onClose={() => setScanning(false)}
      onScanned={(code) => {
        setScanning(false);
        setPairingCode(code);
        void startPairingFromCode(code);
      }}
      visible={scanning}
    />
  );

  const status = (
    <>
      {phase.kind === "pending" ? (
        <View style={styles.statusBox}>
          <Text style={styles.statusTitle}>Approve on the host</Text>
          <Text style={styles.statusBody}>{MOBILE_COPY.pairCompareHint}</Text>
          <Text style={styles.statusBody}>
            Comparison code {phase.claim.comparisonCode} · {phase.claim.hostDisplayName}
          </Text>
          {phase.notice !== undefined ? (
            <Text style={styles.error} testID="mobile-pairing-notice">
              {phase.notice}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void pollStatus(phase);
            }}
            style={styles.buttonSecondary}
            testID="mobile-pairing-poll"
          >
            <Text style={styles.buttonSecondaryLabel}>{MOBILE_COPY.pairCheckNow}</Text>
          </Pressable>
        </View>
      ) : null}
      {phase.kind === "working" ? (
        <View style={styles.statusBox}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.statusBody}>{phase.message}</Text>
        </View>
      ) : null}
      {phase.kind === "approved" ? (
        <Text style={styles.success} testID="mobile-pairing-approved">
          {phase.message}
        </Text>
      ) : null}
      {phase.kind === "failed" ? (
        <View style={styles.statusBox}>
          <Text style={styles.error} testID="mobile-pairing-failed">
            {phase.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPhase({ kind: "idle" })}
            style={styles.buttonSecondary}
            testID="mobile-pairing-retry"
          >
            <Text style={styles.buttonSecondaryLabel}>{MOBILE_COPY.pairTryAgain}</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );

  const body = (
    <>
      {phase.kind === "idle" ? fields : null}
      {status}
    </>
  );

  return (
    <View style={styles.panel} testID="mobile-pairing-panel">
      {focused ? (
        <>
          <Text style={styles.headline}>{MOBILE_COPY.pairHostHeadline}</Text>
          <Text style={styles.subhead}>{MOBILE_COPY.pairHostSubhead}</Text>
          <GlassSurface contentStyle={styles.card} material="regular" radius={mobileRadii.lg}>
            {body}
          </GlassSurface>
          <Text style={styles.note}>{MOBILE_COPY.pairRevokeNote}</Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>{MOBILE_COPY.pairHostTitle}</Text>
          <Text style={styles.help}>{MOBILE_COPY.hostsHint}</Text>
          {body}
        </>
      )}
      {scanner}
    </View>
  );
}
