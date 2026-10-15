import { approvalOutsideContentLines } from "@octant/domain";
import type { ApprovalOutsideContent } from "@octant/contracts";
import { Text, View } from "react-native";
import { useTheme } from "../../design-system";
import { mobileTypography } from "../theme/tokens";

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
    <View testID="mobile-native-harness-approval-outside-content">
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
