import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { DESKTOP_APPROVAL_DEFER_COPY, desktopApprovalImpactSummary } from "./approvalPresentation";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface ApprovalDeferralSheetProps {
  readonly hostLabel?: string;
  readonly mode?: "chat" | "work" | "code";
  readonly threadTitle?: string;
  readonly executionPolicy?: string;
  readonly operationSummary?: string;
}

/**
 * Honest deferral when the host requires a local approval challenge.
 * Does not offer a phone-side approve/reject control for local-host-only receipts.
 */
export function ApprovalDeferralSheet(props: ApprovalDeferralSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        sheet: {
          marginTop: mobileSpacing.md,
          gap: mobileSpacing.sm,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          paddingTop: mobileSpacing.md,
        },
        title: {
          ...mobileTypography.title,
          color: colors.textPrimary,
        },
        body: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        impact: {
          ...mobileTypography.caption,
          color: colors.textPrimary,
        },
      }),
    [colors],
  );

  const impact = desktopApprovalImpactSummary({
    ...(props.hostLabel === undefined ? {} : { hostLabel: props.hostLabel }),
    ...(props.mode === undefined ? {} : { mode: props.mode }),
    ...(props.threadTitle === undefined ? {} : { threadTitle: props.threadTitle }),
    ...(props.executionPolicy === undefined ? {} : { executionPolicy: props.executionPolicy }),
    ...(props.operationSummary === undefined ? {} : { operationSummary: props.operationSummary }),
  });

  return (
    <View style={styles.sheet} testID="mobile-approval-deferral">
      <Text style={styles.title}>Approval on desktop</Text>
      <Text style={styles.body}>{DESKTOP_APPROVAL_DEFER_COPY}</Text>
      <Text style={styles.impact} testID="mobile-approval-impact">
        {impact}
      </Text>
    </View>
  );
}
