import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  decideScreenshotPrivacyMode,
  evaluateDeviceIntegrityHeuristic,
  presentStaleHostSecurity,
  type DeviceIntegrityPresentation,
  type HostSessionHealthKind,
  type ScreenshotPrivacyDecision,
  type ScreenshotPrivacyMode,
  type StaleHostSecurityPresentation,
} from "@octant/domain";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import type { MobileDeviceIntegrityPort } from "./deviceIntegrityPort";
import type { MobileScreenshotPrivacyPort } from "./screenshotPrivacyPort";

export interface PrivacySecurityPanelProps {
  readonly hostHealth: HostSessionHealthKind;
  readonly integrity: MobileDeviceIntegrityPort;
  readonly screenshotPrivacy: MobileScreenshotPrivacyPort;
}

export function PrivacySecurityPanel(props: PrivacySecurityPanelProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [integrityView, setIntegrityView] = useState<DeviceIntegrityPresentation>();
  const [privacyDecision, setPrivacyDecision] = useState<ScreenshotPrivacyDecision>();
  const [nativeApply, setNativeApply] = useState<"applied" | "unavailable" | undefined>();
  const [staleView, setStaleView] = useState<StaleHostSecurityPresentation>(() =>
    presentStaleHostSecurity(props.hostHealth),
  );
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    setStaleView(presentStaleHostSecurity(props.hostHealth));
  }, [props.hostHealth]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const signal = await props.integrity.probe();
      if (cancelled) return;
      setIntegrityView(evaluateDeviceIntegrityHeuristic(signal));
      const mode = await props.screenshotPrivacy.getMode();
      if (cancelled) return;
      setPrivacyDecision(decideScreenshotPrivacyMode(mode));
    })();
    return () => {
      cancelled = true;
    };
  }, [props.integrity, props.screenshotPrivacy]);

  const setMode = async (mode: ScreenshotPrivacyMode) => {
    setBusy(true);
    setMessage(undefined);
    try {
      await props.screenshotPrivacy.setMode(mode);
      const decision = decideScreenshotPrivacyMode(mode);
      setPrivacyDecision(decision);
      const applied = await props.screenshotPrivacy.apply(mode);
      setNativeApply(applied);
      setMessage(
        applied === "applied"
          ? decision.summary
          : `${decision.summary} Native capture blocking is not available on this build.`,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not update screenshot privacy.");
    } finally {
      setBusy(false);
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: {
          marginTop: mobileSpacing.lg,
          gap: mobileSpacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingTop: mobileSpacing.md,
        },
        title: {
          ...mobileTypography.title,
          color: colors.textPrimary,
        },
        subtitle: {
          ...mobileTypography.body,
          color: colors.textPrimary,
          fontWeight: "600",
          marginTop: mobileSpacing.sm,
        },
        help: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        status: {
          ...mobileTypography.body,
          color: colors.textPrimary,
        },
        warn: {
          color: colors.textPrimary,
          fontWeight: "600",
        },
        button: {
          backgroundColor: colors.accent,
          paddingVertical: mobileSpacing.md,
          borderRadius: 8,
          alignItems: "center",
        },
        buttonDisabled: { opacity: 0.45 },
        buttonLabel: {
          ...mobileTypography.body,
          color: colors.sendLabel,
          fontWeight: "600",
        },
        secondary: { alignItems: "center", paddingVertical: mobileSpacing.sm },
        secondaryLabel: { color: colors.accent, fontWeight: "600" },
        meta: { ...mobileTypography.body, color: colors.textSecondary },
        message: { ...mobileTypography.body, color: colors.textPrimary },
      }),
    [colors],
  );

  return (
    <View style={styles.panel} testID="mobile-privacy-security-panel">
      <Text style={styles.title}>{MOBILE_COPY.privacySecurityTitle}</Text>
      <Text style={styles.help}>{MOBILE_COPY.privacySecurityHelp}</Text>

      {integrityView !== undefined ? (
        <Text
          style={[styles.status, integrityView.severity === "soft-warn" ? styles.warn : null]}
          testID="mobile-integrity-status"
        >
          {integrityView.message}
        </Text>
      ) : null}

      <Text style={styles.status} testID="mobile-stale-security-status">
        {staleView.message}
      </Text>

      <Text style={styles.subtitle}>Screenshot privacy</Text>
      <Text style={styles.help}>
        {privacyDecision?.summary ?? MOBILE_COPY.screenshotPrivacyHint}
      </Text>
      <Pressable
        disabled={busy}
        onPress={() => void setMode("hide-in-recents")}
        style={[styles.button, busy ? styles.buttonDisabled : null]}
        testID="mobile-screenshot-hide-recents"
      >
        {busy ? (
          <ActivityIndicator color={colors.sendLabel} />
        ) : (
          <Text style={styles.buttonLabel}>Hide in recents</Text>
        )}
      </Pressable>
      <Pressable
        disabled={busy}
        onPress={() => void setMode("standard")}
        style={styles.secondary}
        testID="mobile-screenshot-standard"
      >
        <Text style={styles.secondaryLabel}>Use standard capture</Text>
      </Pressable>
      {nativeApply !== undefined ? (
        <Text style={styles.meta} testID="mobile-screenshot-native-apply">
          Native apply: {nativeApply}
        </Text>
      ) : null}
      {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}
