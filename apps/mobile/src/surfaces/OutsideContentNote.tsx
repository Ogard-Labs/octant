import { approvalOutsideContentLines } from "@octant/domain";
import type { ApprovalOutsideContent } from "@octant/contracts";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

function readTime(at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleString();
}

/** Why a marked thread asks for this one call and what marked it, ahead of the choices. */
export function OutsideContentNote(props: { readonly outsideContent: ApprovalOutsideContent }) {
  const { colors } = useTheme();
  const { reason, rows, more } = approvalOutsideContentLines(props.outsideContent, readTime);
  return (
    <View
      accessibilityRole="alert"
      style={[styles.note, { borderLeftColor: colors.warning }]}
      testID="mobile-native-harness-approval-outside-content"
    >
      <View style={styles.lead}>
        <Ionicons color={colors.warning} name="warning-outline" size={16} />
        <Text style={[mobileTypography.section, styles.leadText, { color: colors.textPrimary }]}>
          {MOBILE_COPY.outsideContentLead}
        </Text>
      </View>
      <Text style={[mobileTypography.caption, { color: colors.textPrimary }]}>{reason}</Text>
      {rows.map((row) => (
        <Text
          key={row.sourceLabel}
          style={[mobileTypography.caption, { color: colors.textSecondary }]}
        >
          {row.name} · {row.reads}
        </Text>
      ))}
      {more === undefined ? null : (
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>{more}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    borderLeftWidth: 3,
    paddingLeft: mobileSpacing.sm,
    gap: 2,
  },
  lead: {
    flexDirection: "row",
    alignItems: "center",
    gap: mobileSpacing.xs,
  },
  leadText: {
    flex: 1,
    fontWeight: "700",
  },
});
