import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
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
import { ListNote, ListRow, ListSection } from "../ui/NativeChrome";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import type { MobileDeviceIntegrityPort } from "./deviceIntegrityPort";
import {
  describeKeyStorageProtection,
  type KeyStorageProtection,
  type MobileKeyStorageProtectionPort,
} from "./keyStorageProtectionPort";
import {
  describeScreenshotProtection,
  type MobileScreenshotPrivacyPort,
} from "./screenshotPrivacyPort";

export interface PrivacySecurityPanelProps {
  readonly hostHealth: HostSessionHealthKind;
  readonly integrity: MobileDeviceIntegrityPort;
  readonly keyStorage: MobileKeyStorageProtectionPort;
  readonly screenshotPrivacy: MobileScreenshotPrivacyPort;
}

export function PrivacySecurityPanel(props: PrivacySecurityPanelProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [integrityView, setIntegrityView] = useState<DeviceIntegrityPresentation>();
  const [keyStorage, setKeyStorage] = useState<KeyStorageProtection>();
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
      const protection = await props.keyStorage.probe();
      if (cancelled) return;
      setKeyStorage(protection);
      const mode = await props.screenshotPrivacy.getMode();
      if (cancelled) return;
      setPrivacyDecision(decideScreenshotPrivacyMode(mode));
    })();
    return () => {
      cancelled = true;
    };
  }, [props.integrity, props.keyStorage, props.screenshotPrivacy]);

  const setMode = async (mode: ScreenshotPrivacyMode) => {
    if (!props.screenshotPrivacy.available) return;
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
        message: {
          color: colors.textSecondary,
          fontSize: mobileTypography.meta.fontSize,
          paddingHorizontal: mobileSpacing.xl,
          marginTop: -mobileSpacing.sm,
          marginBottom: mobileSpacing.md,
        },
      }),
    [colors],
  );
  const mode = privacyDecision?.mode;

  return (
    <View testID="mobile-privacy-security-panel">
      <ListSection
        footer={MOBILE_COPY.privacySecurityHelp}
        title={MOBILE_COPY.privacySecurityTitle}
      >
        {integrityView !== undefined ? (
          <ListNote
            testID="mobile-integrity-status"
            text={integrityView.message}
            tone={integrityView.severity === "soft-warn" ? colors.warning : undefined}
          />
        ) : null}
        {keyStorage !== undefined ? (
          <ListNote
            testID="mobile-key-storage-status"
            text={describeKeyStorageProtection(keyStorage, props.keyStorage.vault)}
          />
        ) : null}
        <ListNote last testID="mobile-stale-security-status" text={staleView.message} />
      </ListSection>

      <ListSection
        footer={
          props.screenshotPrivacy.available
            ? (privacyDecision?.summary ?? MOBILE_COPY.screenshotPrivacyHint)
            : undefined
        }
        title="Screenshot privacy"
      >
        {props.screenshotPrivacy.available ? (
          <>
            {props.screenshotPrivacy.coverage !== "none" && mode !== "standard" ? (
              <ListNote
                testID="mobile-screenshot-coverage"
                text={describeScreenshotProtection(props.screenshotPrivacy.coverage)}
              />
            ) : null}
            <ListRow
              accessory={mode === "hide-in-recents" ? "check" : "none"}
              label="Hide in recents"
              onPress={busy ? undefined : () => void setMode("hide-in-recents")}
              testID="mobile-screenshot-hide-recents"
            />
            <ListRow
              accessory={mode === "standard" ? "check" : "none"}
              label="Use standard capture"
              last={nativeApply === undefined}
              onPress={busy ? undefined : () => void setMode("standard")}
              testID="mobile-screenshot-standard"
            />
            {nativeApply !== undefined ? (
              <ListRow
                label="Native apply"
                last
                testID="mobile-screenshot-native-apply"
                value={nativeApply}
              />
            ) : null}
          </>
        ) : (
          <ListNote
            last
            testID="mobile-screenshot-unavailable"
            text="Screenshot and app-switcher protection is unavailable in this build. Avoid capturing sensitive thread content."
            tone={colors.textSecondary}
          />
        )}
      </ListSection>
      {message !== undefined ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}
