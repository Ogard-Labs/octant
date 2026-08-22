import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  loadMobileCodeThread,
  MobileInboxFailure,
  observeMobilePullRequest,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { CodePullRequestReview } from "@octant/contracts";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";

export interface PullRequestReviewPanelProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
}

export function PullRequestReviewPanel(props: PullRequestReviewPanelProps) {
  const { colors } = useTheme();
  const [review, setReview] = useState<CodePullRequestReview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const thread = await loadMobileCodeThread(props.transport, props.threadId);
      const next = await observeMobilePullRequest({
        transport: props.transport,
        threadId: thread.id,
        checkoutId: thread.checkoutId,
      });
      setReview(next);
    } catch (cause) {
      setError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not observe the linked pull request.",
      );
    } finally {
      setBusy(false);
    }
  }, [props.threadId, props.transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        block: {
          marginTop: mobileSpacing.md,
          gap: mobileSpacing.sm,
          flex: 1,
        },
        title: {
          ...mobileTypography.title,
          color: colors.textPrimary,
        },
        section: {
          ...mobileTypography.body,
          color: colors.textPrimary,
          fontWeight: "600",
          marginTop: mobileSpacing.sm,
        },
        meta: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        help: {
          ...mobileTypography.body,
          color: colors.textSecondary,
        },
        error: {
          ...mobileTypography.body,
          color: colors.danger,
        },
        link: {
          ...mobileTypography.body,
          color: colors.accent,
        },
        fileList: {
          maxHeight: 160,
        },
        file: {
          ...mobileTypography.caption,
          color: colors.textPrimary,
          fontFamily: "monospace",
        },
      }),
    [colors],
  );

  if (busy && review === undefined) {
    return <ActivityIndicator color={colors.accent} />;
  }

  if (error !== undefined && review === undefined) {
    return (
      <View style={styles.block}>
        <Text style={styles.error}>{error}</Text>
        <Pressable onPress={() => void refresh()} testID="mobile-pr-retry">
          <Text style={styles.link}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (review === undefined) return null;

  if (review.state !== "observed") {
    if (review.state === "none") {
      return (
        <Text style={styles.help} testID="mobile-pr-none">
          No linked pull request for this delivery branch.
        </Text>
      );
    }
    return (
      <Text style={styles.error} testID="mobile-pr-unavailable">
        Pull request observation is unavailable on this host.
      </Text>
    );
  }

  const truncated = review.files.length > 12;
  const files = review.files.slice(0, 12);

  return (
    <View style={styles.block} testID="mobile-pr-review">
      <Text style={styles.title}>
        #{review.number} {formatScreenshotSafeLabel(review.title)}
      </Text>
      <Text style={styles.meta}>
        {review.pullRequestState} · {review.baseRepository} · {review.headBranch} →{" "}
        {review.baseBranch}
      </Text>
      <Text style={styles.meta}>
        freshness {review.freshness}
        {review.ambiguous ? " · waiting on stale sections" : ""}
      </Text>
      <Text style={styles.section}>Changed files</Text>
      <ScrollView style={styles.fileList}>
        {files.map((file) => (
          <Text key={file.path} style={styles.file}>
            {file.path} (+{file.additions}/−{file.deletions})
          </Text>
        ))}
      </ScrollView>
      {truncated ? (
        <Text style={styles.help}>More files — open the full review on the desktop host.</Text>
      ) : null}
      <Text style={styles.section}>Checks</Text>
      {review.checks.length === 0 ? (
        <Text style={styles.help}>No checks reported.</Text>
      ) : (
        review.checks.slice(0, 8).map((check) => (
          <Text key={check.name} style={styles.file}>
            {check.name}: {check.state}
          </Text>
        ))
      )}
      <Text style={styles.help}>
        Focused review on the phone. Conflict resolution stays on the desktop host.
      </Text>
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
