import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";

export interface ApprovalDecisionButtonsProps {
  readonly busy: boolean;
  readonly onAllow: () => void;
  readonly onDeny: () => void;
  /** Absent when the host would ignore a session-wide choice. */
  readonly onAllowSession?: (() => void) | undefined;
}

/**
 * The answers to an approval, stacked so a thumb cannot hit the wrong one:
 * Allow is the filled primary, Deny is outlined, and the broader "this session"
 * choice is a quiet text button last, away from the single-use answers.
 */
export function ApprovalDecisionButtons(props: ApprovalDecisionButtonsProps) {
  const { colors } = useTheme();
  const state = { disabled: props.busy, busy: props.busy };
  return (
    <View style={styles.stack} testID="mobile-approval-decisions">
      <Pressable
        accessibilityLabel={MOBILE_COPY.approvalAllow}
        accessibilityRole="button"
        accessibilityState={state}
        disabled={props.busy}
        onPress={props.onAllow}
        style={[styles.button, { backgroundColor: colors.send }, props.busy ? styles.busy : null]}
      >
        <Text style={[mobileTypography.section, { color: colors.sendLabel }]}>
          {MOBILE_COPY.approvalAllow}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={MOBILE_COPY.approvalDeny}
        accessibilityRole="button"
        accessibilityState={state}
        disabled={props.busy}
        onPress={props.onDeny}
        style={[
          styles.button,
          { borderColor: colors.textSecondary, borderWidth: 1 },
          props.busy ? styles.busy : null,
        ]}
      >
        <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
          {MOBILE_COPY.approvalDeny}
        </Text>
      </Pressable>
      {props.onAllowSession === undefined ? null : (
        <Pressable
          accessibilityLabel={MOBILE_COPY.approvalAllowSession}
          accessibilityRole="button"
          accessibilityState={state}
          disabled={props.busy}
          hitSlop={8}
          onPress={props.onAllowSession}
          style={[styles.button, styles.secondary, props.busy ? styles.busy : null]}
        >
          <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
            {MOBILE_COPY.approvalAllowSession}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: mobileSpacing.xs,
    marginTop: mobileSpacing.xs,
  },
  button: {
    minHeight: 44,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: mobileSpacing.md,
    borderRadius: 10,
  },
  secondary: {
    marginTop: mobileSpacing.xs,
  },
  busy: {
    opacity: 0.5,
  },
});
