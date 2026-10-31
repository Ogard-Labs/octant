import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  loadMobileCodeThread,
  loadMobilePullRequestMergeState,
  mergeMobilePullRequest,
  MobileInboxFailure,
  observeMobilePullRequest,
  setMobileMergeWhenReady,
  type MobilePullRequestMergeState,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { CodePullRequestReview } from "@octant/contracts";
import {
  mergeConfirmationCopy,
  mergeOutcomeCopy,
  mergeWhenReadyOutcomeCopy,
} from "./pullRequestMergePresentation";
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
  const [projectId, setProjectId] = useState<string | undefined>();
  const [mergeStep, setMergeStep] = useState<
    | { readonly kind: "reading" }
    | {
        readonly kind: "confirm";
        readonly mode: "merge" | "when-ready";
        readonly state: MobilePullRequestMergeState;
      }
    | { readonly kind: "sending" }
    | undefined
  >();
  const [mergeNotice, setMergeNotice] = useState<string | undefined>();

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
      setProjectId(String(thread.projectId));
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

  const mergeTarget =
    review?.state === "observed" && projectId !== undefined
      ? { projectId, baseRepository: review.baseRepository, number: review.number }
      : undefined;

  // Re-reads the pull request first, so the head the person confirms is one the
  // host has just seen; the confirm buttons send that head and nothing older.
  async function beginMerge(mode: "merge" | "when-ready"): Promise<void> {
    if (mergeTarget === undefined) return;
    setMergeNotice(undefined);
    setMergeStep({ kind: "reading" });
    try {
      const state = await loadMobilePullRequestMergeState(props.transport, mergeTarget);
      if (!state.mergeable) {
        setMergeStep(undefined);
        setMergeNotice(
          "Not ready to merge here: the pull request must be open, fresh, and mergeable.",
        );
        return;
      }
      setMergeStep({ kind: "confirm", mode, state });
    } catch {
      setMergeStep(undefined);
      setMergeNotice("Could not read the pull request from the host. Try again.");
    }
  }

  async function confirmMerge(): Promise<void> {
    if (mergeTarget === undefined || mergeStep?.kind !== "confirm") return;
    const { mode, state } = mergeStep;
    setMergeStep({ kind: "sending" });
    try {
      if (mode === "merge") {
        const outcome = await mergeMobilePullRequest(props.transport, {
          ...mergeTarget,
          method: "squash",
          headSha: state.headSha,
        });
        setMergeNotice(mergeOutcomeCopy(outcome));
        if (outcome.status === "merged") void refresh();
      } else {
        const outcome = await setMobileMergeWhenReady(props.transport, {
          ...mergeTarget,
          enabled: true,
          method: "squash",
          headSha: state.headSha,
        });
        setMergeNotice(mergeWhenReadyOutcomeCopy(outcome));
      }
    } catch {
      setMergeNotice("The host did not answer. Nothing was confirmed; check the pull request.");
    } finally {
      setMergeStep(undefined);
    }
  }

  async function turnOffMergeWhenReady(): Promise<void> {
    if (mergeTarget === undefined) return;
    setMergeStep({ kind: "sending" });
    try {
      setMergeNotice(
        mergeWhenReadyOutcomeCopy(
          await setMobileMergeWhenReady(props.transport, { ...mergeTarget, enabled: false }),
        ),
      );
    } catch {
      setMergeNotice("The host did not answer. Merge when ready may still be on.");
    } finally {
      setMergeStep(undefined);
    }
  }

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
          fontWeight: "500",
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
        actionRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: mobileSpacing.md,
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
        Focused review on the phone. Merging asks you first. Conflict resolution stays on the
        desktop host.
      </Text>
      {mergeTarget !== undefined && review.pullRequestState === "open" ? (
        <View style={styles.block} testID="mobile-pr-merge">
          {mergeStep?.kind === "confirm" ? (
            <>
              <Text style={styles.meta}>
                {mergeConfirmationCopy(mergeStep.mode, review.number, mergeStep.state.headSha)}
              </Text>
              <View style={styles.actionRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setMergeStep(undefined)}
                  testID="mobile-pr-merge-cancel"
                >
                  <Text style={styles.link}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void confirmMerge()}
                  testID="mobile-pr-merge-confirm"
                >
                  <Text style={styles.link}>
                    {mergeStep.mode === "merge" ? "Confirm merge" : "Confirm Merge when ready"}
                  </Text>
                </Pressable>
              </View>
            </>
          ) : mergeStep === undefined ? (
            <View style={styles.actionRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void beginMerge("merge")}
                testID="mobile-pr-merge-open"
              >
                <Text style={styles.link}>Merge…</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void beginMerge("when-ready")}
                testID="mobile-pr-merge-when-ready-open"
              >
                <Text style={styles.link}>Merge when ready…</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void turnOffMergeWhenReady()}
                testID="mobile-pr-merge-when-ready-off"
              >
                <Text style={styles.link}>Turn off Merge when ready</Text>
              </Pressable>
            </View>
          ) : (
            <ActivityIndicator color={colors.accent} />
          )}
          {mergeNotice === undefined ? null : (
            <Text accessibilityRole="alert" style={styles.help} testID="mobile-pr-merge-notice">
              {mergeNotice}
            </Text>
          )}
        </View>
      ) : null}
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
