import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MOBILE_COPY } from "../copy";
import { space, typography, useTheme, withAlpha, type ThemeColors } from "../../design-system";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { Icon } from "../ui/Icon";
import type { MobileIconName } from "../ui/IconButton";
import {
  pullRequestBadges,
  pullRequestChecks,
  pullRequestReview,
  pullRequestStateChip,
  type MobilePullRequest,
  type PullRequestTone,
} from "./pullRequestPresentation";

export function toneInk(tone: PullRequestTone, colors: ThemeColors): string {
  switch (tone) {
    case "success":
      return colors.success;
    case "danger":
      return colors.danger;
    case "warning":
      return colors.warning;
    case "merged":
      return colors.merged;
    case "neutral":
      return colors.textTertiary;
  }
}

export const CHECKS_ICON: Readonly<Record<PullRequestTone, MobileIconName>> = {
  success: "checkmark-circle-outline",
  danger: "close-circle-outline",
  warning: "ellipse-outline",
  merged: "checkmark-circle-outline",
  neutral: "ellipse-outline",
};

/**
 * One pull request in the list: its title and state, the repository, number
 * and branches under it, then its checks, review and whatever is moving it in.
 * The computer is named only when more than one is paired.
 */
export function PullRequestRow(props: {
  readonly pullRequest: MobilePullRequest;
  readonly hostLabel: string | undefined;
  readonly last: boolean;
  readonly onOpen: (pullRequest: MobilePullRequest) => void;
}) {
  const { row } = props.pullRequest;
  const { colors } = useTheme();
  const state = pullRequestStateChip(row);
  const checks = pullRequestChecks(row);
  const review = pullRequestReview(row);
  const badges = pullRequestBadges(row);
  const stateInk = toneInk(state.tone, colors);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: { minHeight: 64, flexDirection: "row", paddingLeft: space.md },
        pressed: { backgroundColor: colors.controlHover },
        glyph: { width: 20, marginTop: 9, marginRight: 10, alignItems: "center" },
        body: { flex: 1, paddingVertical: 8, paddingRight: space.md, gap: 2 },
        line: { flexDirection: "row", alignItems: "center", gap: space.sm },
        title: { flex: 1, color: colors.textPrimary, fontSize: 16, fontWeight: "500" },
        chip: {
          paddingHorizontal: 7,
          paddingVertical: 1,
          borderRadius: 999,
          overflow: "hidden",
          fontSize: typography.meta.fontSize,
          fontWeight: "600",
        },
        place: { flexShrink: 1, color: colors.textTertiary, fontSize: 13 },
        facts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 10 },
        fact: { flexDirection: "row", alignItems: "center", gap: 3 },
        factText: { fontSize: typography.detail.fontSize, fontVariant: ["tabular-nums"] },
        badge: { color: colors.accent, fontSize: typography.detail.fontSize, fontWeight: "500" },
        separator: {
          position: "absolute",
          left: space.md + 30,
          right: 0,
          bottom: 0,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.hairline,
        },
      }),
    [colors],
  );
  const title = formatScreenshotSafeLabel(row.title);
  const repository = `${row.repositoryOwner}/${row.repositoryName} #${row.number}`;
  const branches = `${row.headBranch} → ${row.baseBranch}`;
  const open = row.state === "open";
  return (
    <Pressable
      accessibilityLabel={[
        title,
        state.label,
        repository,
        open ? checks.label : "",
        open ? review.label : "",
        ...badges,
        props.hostLabel ?? "",
      ]
        .filter((part) => part.length > 0)
        .join(", ")}
      accessibilityRole="button"
      onPress={() => props.onOpen(props.pullRequest)}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
      testID={`mobile-pr-row-${row.number}`}
    >
      <View style={styles.glyph}>
        <Icon
          color={stateInk}
          name={row.state === "merged" ? "git-merge-outline" : "git-pull-request-outline"}
          size={17}
        />
      </View>
      <View style={styles.body}>
        <View style={styles.line}>
          <Text numberOfLines={2} style={styles.title}>
            {title}
          </Text>
          <Text
            style={[styles.chip, { color: stateInk, backgroundColor: withAlpha(stateInk, 0.14) }]}
          >
            {state.label}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.place}>
          {[repository, branches, props.hostLabel].filter((part) => part !== undefined).join(" · ")}
        </Text>
        {open ? (
          <View style={styles.facts}>
            <View style={styles.fact}>
              <Icon
                color={toneInk(checks.tone, colors)}
                name={CHECKS_ICON[checks.tone]}
                size={14}
              />
              <Text style={[styles.factText, { color: toneInk(checks.tone, colors) }]}>
                {checks.label}
              </Text>
            </View>
            <Text style={[styles.factText, { color: toneInk(review.tone, colors) }]}>
              {review.label}
            </Text>
            {row.mergeability === "conflicting" ? (
              <Text style={[styles.factText, { color: colors.danger }]}>
                {MOBILE_COPY.pullRequestConflicting}
              </Text>
            ) : null}
            {badges.map((badge) => (
              <Text key={badge} style={styles.badge}>
                {badge}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
      {props.last ? null : <View pointerEvents="none" style={styles.separator} />}
    </Pressable>
  );
}
