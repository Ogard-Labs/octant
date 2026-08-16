import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  createRemotePairingClient,
  isRemotePairingFailure,
  type RemoteDeviceKeyStore,
  type RemotePairingClaim,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import { MOBILE_COPY, MOBILE_PRODUCT_NAME } from "../copy";
import { GlassSurface, useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import type { MobileHostRegistry } from "./HostRegistry";

export interface PairingPanelProps {
  readonly registry: MobileHostRegistry;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly bridge: RemoteSessionBridge;
  readonly deviceLabel?: string;
  readonly onPaired?: () => void;
  /** Focused mockup layout (headline + card). Default true. */
  readonly focused?: boolean;
}

type PairingPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly message: string }
  | { readonly kind: "pending"; readonly claim: RemotePairingClaim; readonly ticketProof: string }
  | { readonly kind: "approved"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export function PairingPanel(props: PairingPanelProps) {
  const { colors } = useTheme();
  const focused = props.focused !== false;
  const [originInput, setOriginInput] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [ticketProof, setTicketProof] = useState("");
  const [phase, setPhase] = useState<PairingPhase>({ kind: "idle" });
  const deviceKeyStore = props.deviceKeyStore;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.md },
        headline: {
          color: colors.textPrimary,
          fontSize: 28,
          fontWeight: "700",
          letterSpacing: -0.3,
        },
        subhead: {
          color: colors.textSecondary,
          fontSize: mobileTypography.body.fontSize,
          lineHeight: 22,
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
          fontWeight: "600",
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
          fontWeight: "700",
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
          fontWeight: "600",
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
          fontWeight: "600",
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

  const startPairing = async () => {
    const origin = originInput.trim().replace(/\/$/, "");
    if (!origin.startsWith("https://")) {
      setPhase({ kind: "failed", message: "Host origin must be an https:// URL." });
      return;
    }
    if (ticketId.trim().length === 0 || ticketProof.trim().length === 0) {
      setPhase({ kind: "failed", message: "Pairing ticket id and proof are required." });
      return;
    }

    setPhase({ kind: "working", message: "Contacting host…" });
    try {
      const client = createRemotePairingClient({
        baseUrl: `${origin}/`,
        fetch: globalThis.fetch.bind(globalThis),
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
        message: isRemotePairingFailure(error)
          ? error.message
          : "Pairing failed. Check the host origin and ticket.",
      });
    }
  };

  const pollStatus = async () => {
    if (phase.kind !== "pending") return;
    setPhase({ kind: "working", message: "Checking approval…" });
    try {
      const origin = phase.claim.origin;
      const client = createRemotePairingClient({
        baseUrl: `${origin}/`,
        fetch: globalThis.fetch.bind(globalThis),
        webBuildVersion: `${MOBILE_PRODUCT_NAME}-mobile/0.1.0`,
        deviceKeyStore,
      });
      const status = await client.pollPairingStatus({
        ticket: { ticketId: phase.claim.ticketId, ticketProof: phase.ticketProof },
        claim: phase.claim,
      });
      if (status.kind === "pending") {
        setPhase({ kind: "pending", claim: status.claim, ticketProof: phase.ticketProof });
        return;
      }
      if (status.kind === "failed") {
        setPhase({ kind: "failed", message: status.message });
        return;
      }
      await props.registry.upsert({
        hostId: status.approval.hostId,
        origin: status.approval.origin,
        label: phase.claim.hostDisplayName,
        keyId: status.approval.deviceKeyId,
        credentialGeneration: status.approval.credentialGeneration,
        hostKeyFingerprint: phase.claim.hostKeyFingerprint,
      });
      props.bridge.connect(status.approval);
      setPhase({
        kind: "approved",
        message: `Paired with ${phase.claim.hostDisplayName}.`,
      });
      props.onPaired?.();
    } catch (error) {
      setPhase({
        kind: "failed",
        message: isRemotePairingFailure(error) ? error.message : "Could not read pairing status.",
      });
    }
  };

  const fields = (
    <>
      <View style={styles.field}>
        <Text style={styles.label}>Origin</Text>
        <View style={styles.inputRow}>
          <Ionicons color={colors.textTertiary} name="globe-outline" size={18} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setOriginInput}
            placeholder="https://host.tailnet:8443"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="mobile-pairing-origin"
            value={originInput}
          />
        </View>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Ticket ID</Text>
        <View style={styles.inputRow}>
          <Ionicons color={colors.textTertiary} name="ticket-outline" size={18} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setTicketId}
            placeholder="Enter ticket ID"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="mobile-pairing-ticket-id"
            value={ticketId}
          />
        </View>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Ticket proof</Text>
        <View style={styles.inputRow}>
          <Ionicons color={colors.textTertiary} name="shield-checkmark-outline" size={18} />
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setTicketProof}
            placeholder="Enter ticket proof"
            placeholderTextColor={colors.textTertiary}
            secureTextEntry
            style={styles.input}
            testID="mobile-pairing-ticket-proof"
            value={ticketProof}
          />
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void startPairing();
        }}
        style={styles.button}
        testID="mobile-pairing-start"
      >
        <Text style={styles.buttonLabel}>Start pairing</Text>
      </Pressable>
    </>
  );

  return (
    <View style={styles.panel} testID="mobile-pairing-panel">
      {focused ? (
        <>
          <Text style={styles.headline}>{MOBILE_COPY.pairHostHeadline}</Text>
          <Text style={styles.subhead}>{MOBILE_COPY.pairHostSubhead}</Text>
          <GlassSurface contentStyle={styles.card} material="regular" radius={mobileRadii.lg}>
            {fields}
          </GlassSurface>
          <Text style={styles.note}>{MOBILE_COPY.pairRevokeNote}</Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>{MOBILE_COPY.pairHostTitle}</Text>
          <Text style={styles.help}>{MOBILE_COPY.hostsHint}</Text>
          {fields}
        </>
      )}
      {phase.kind === "pending" ? (
        <View style={styles.statusBox}>
          <Text style={styles.statusTitle}>Approve on the host</Text>
          <Text style={styles.statusBody}>
            Comparison code {phase.claim.comparisonCode} · {phase.claim.hostDisplayName}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void pollStatus();
            }}
            style={styles.buttonSecondary}
            testID="mobile-pairing-poll"
          >
            <Text style={styles.buttonSecondaryLabel}>Check approval</Text>
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
        <Text style={styles.error} testID="mobile-pairing-failed">
          {phase.message}
        </Text>
      ) : null}
    </View>
  );
}
