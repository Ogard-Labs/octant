import type { MobileRemoteTransport } from "@octant/client-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { readNewDevicesAcross, type NewDevicesReading } from "./newDevices";

export interface NewDevicesPanelProps {
  readonly transports: ReadonlyArray<MobileRemoteTransport>;
  readonly computerName: (hostId: string) => string;
}

/**
 * Every paired computer's new devices, which a new-device notification opens.
 * The phone shows them; Remove stays with a window on that computer or an
 * owner device (maintainer decision, 2026-11-19).
 */
export function NewDevicesPanel(props: NewDevicesPanelProps) {
  const { colors } = useTheme();
  const { transports, computerName } = props;
  const [reading, setReading] = useState<NewDevicesReading>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      try {
        const next = await readNewDevicesAcross({
          transports,
          computerName,
          ...(signal === undefined ? {} : { signal }),
        });
        if (signal?.aborted !== true) setReading(next);
      } finally {
        if (signal?.aborted !== true) setBusy(false);
      }
    },
    [transports, computerName],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.sm, marginTop: mobileSpacing.lg },
        title: {
          color: colors.textPrimary,
          fontSize: mobileTypography.title.fontSize,
          fontWeight: mobileTypography.title.fontWeight,
        },
        help: { color: colors.textSecondary, fontSize: mobileTypography.caption.fontSize },
        box: {
          gap: mobileSpacing.sm,
          padding: mobileSpacing.md,
          backgroundColor: colors.surface,
          borderRadius: mobileRadii.md,
        },
        boxTitle: { color: colors.textPrimary, fontWeight: "500" },
        body: { color: colors.textSecondary },
        mono: { color: colors.textSecondary, fontFamily: "Menlo", fontSize: 11 },
      }),
    [colors],
  );

  if (transports.length === 0) return null;
  if (reading !== undefined && reading.rows.length === 0 && reading.unanswered.length === 0) {
    return null;
  }

  return (
    <View style={styles.panel} testID="mobile-new-devices">
      <Text style={styles.title}>New devices</Text>
      <Text style={styles.help}>
        If you did not add a device, remove it from a window on that computer or an owner device.
      </Text>
      {busy ? <ActivityIndicator color={colors.accent} /> : null}
      {reading?.unanswered.length ? (
        <Text style={styles.help}>No answer from {reading.unanswered.join(", ")}.</Text>
      ) : null}
      {reading?.rows.map((row) => (
        <View key={row.key} style={styles.box} testID="mobile-new-device">
          <Text style={styles.boxTitle}>{row.title}</Text>
          {row.detail.length === 0 ? null : <Text style={styles.body}>{row.detail}</Text>}
          <Text style={styles.mono} selectable>
            {row.fingerprint}
          </Text>
        </View>
      ))}
    </View>
  );
}
