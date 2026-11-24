import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PROVIDER_GLYPH_COLOR_FALLBACKS } from "@octant/theme";
import { radii, space, typography, useTheme } from "../../design-system";
import type {
  MobileHandoffEndpoint,
  MobileTranscriptHandoffEntry,
  MobileTranscriptHandoffKind,
} from "./transcriptHandoffPresentation";

type LeadIconName = "swap-horizontal-outline" | "git-branch-outline" | "return-up-back-outline";

function leadIconFor(kind: MobileTranscriptHandoffKind): LeadIconName {
  switch (kind) {
    case "context-handoff":
    case "model-switch":
      return "swap-horizontal-outline";
    case "fork":
    case "branch":
      return "git-branch-outline";
    case "rewind":
      return "return-up-back-outline";
  }
}

function ProviderBadge(props: { readonly endpoint: MobileHandoffEndpoint }) {
  const { colors } = useTheme();
  const accent =
    props.endpoint.driverKind === undefined
      ? undefined
      : PROVIDER_GLYPH_COLOR_FALLBACKS[props.endpoint.driverKind];
  if (props.endpoint.monogram === undefined) return null;
  return (
    <View
      accessible={false}
      style={{
        width: 15,
        height: 15,
        borderRadius: radii.sm / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: accent ?? colors.glassStroke,
        backgroundColor: colors.glassFillThin,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          fontSize: 8,
          fontWeight: "600",
          color: accent ?? colors.textSecondary,
          includeFontPadding: false,
        }}
      >
        {props.endpoint.monogram}
      </Text>
    </View>
  );
}

/**
 * Shared inline handoff boundary for the phone's Chat, Work, and Code
 * transcripts: a full-width hairline with the transition icon, label, and
 * source-to-target models with provider marks, followed by the host's
 * disclosure note when context was carried.
 */
export function TranscriptHandoffDivider(props: {
  readonly entry: MobileTranscriptHandoffEntry;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          alignItems: "center",
          gap: space.xs,
          paddingVertical: space.xs,
          width: "100%",
        },
        ruleRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          width: "100%",
        },
        hairline: {
          flex: 1,
          minWidth: 12,
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.hairline,
        },
        content: {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          gap: space.xs,
          flexShrink: 1,
        },
        lead: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
        },
        leadText: {
          fontSize: typography.meta.fontSize,
          lineHeight: 16,
          color: colors.textTertiary,
        },
        route: {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          gap: space.xs,
          flexShrink: 1,
        },
        endpoint: {
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          maxWidth: 160,
        },
        fromModel: {
          fontSize: typography.meta.fontSize,
          lineHeight: 16,
          color: colors.textSecondary,
          flexShrink: 1,
        },
        toModel: {
          fontSize: typography.meta.fontSize,
          lineHeight: 16,
          fontWeight: "500",
          color: colors.textPrimary,
          flexShrink: 1,
        },
        note: {
          fontSize: typography.meta.fontSize,
          lineHeight: 16,
          color: colors.textTertiary,
          textAlign: "center",
          paddingHorizontal: space.sm,
        },
      }),
    [colors],
  );

  const { entry } = props;
  const route = entry.route;

  return (
    <View style={styles.container} testID={props.testID ?? "mobile-transcript-handoff"}>
      <View
        accessibilityLabel={entry.accessibleLabel}
        accessible
        style={styles.ruleRow}
        testID={`${props.testID ?? "mobile-transcript-handoff"}-rule`}
      >
        <View style={styles.hairline} />
        <View style={styles.content}>
          <View style={styles.lead}>
            <Ionicons color={colors.textTertiary} name={leadIconFor(entry.kind)} size={12} />
            <Text style={styles.leadText}>{entry.heading}</Text>
          </View>
          {route === undefined ? null : (
            <View style={styles.route}>
              <View style={styles.endpoint}>
                <ProviderBadge endpoint={route.from} />
                <Text numberOfLines={1} style={styles.fromModel}>
                  {route.from.label}
                </Text>
              </View>
              <Ionicons color={colors.textTertiary} name="arrow-forward" size={11} />
              <View style={styles.endpoint}>
                {route.showToMark ? <ProviderBadge endpoint={route.to} /> : null}
                <Text numberOfLines={1} style={styles.toModel}>
                  {route.to.label}
                </Text>
              </View>
            </View>
          )}
        </View>
        <View style={styles.hairline} />
      </View>
      {entry.disclosure === undefined ? null : (
        <Text style={styles.note} testID={`${props.testID ?? "mobile-transcript-handoff"}-note`}>
          {entry.disclosure}
        </Text>
      )}
    </View>
  );
}
