import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  loadMobileCodeThread,
  loadMobilePullRequestDiff,
  MobileInboxFailure,
  observeMobilePullRequest,
  type MobileDiffFile,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { loadMobilePullRequestGuide } from "@octant/client-runtime/pull-request-guide-client";
import type { CodePullRequestReview, CodePullRequestReviewObserved } from "@octant/contracts";
import type {
  PullRequestGuideAnchor,
  PullRequestGuideView,
} from "@octant/contracts/pull-request-guide";
import { numberedDiffLines } from "../panes/threadPanesPresentation";
import { mergeConfirmationCopy } from "./pullRequestMergePresentation";
import { usePullRequestMerge } from "./usePullRequestMerge";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system/theme";

const RUNNING_GUIDE_REFRESH_MS = 3_000;

export interface PullRequestReviewPanelProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
}

interface OpenedFileTarget {
  readonly path: string;
  readonly anchor?: PullRequestGuideAnchor;
}

type DiffLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly operationId: string }
  | {
      readonly status: "ready";
      readonly operationId: string;
      readonly files: ReadonlyArray<MobileDiffFile>;
      readonly truncated: boolean;
    }
  | { readonly status: "error"; readonly operationId: string; readonly message: string };

function anchorLabel(anchor: PullRequestGuideAnchor): string {
  return anchor.startLine === anchor.endLine
    ? `${String(anchor.path)}:${anchor.startLine}`
    : `${String(anchor.path)}:${anchor.startLine}–${anchor.endLine}`;
}

function anchorRangeLabel(anchor: PullRequestGuideAnchor): string {
  return anchor.startLine === anchor.endLine
    ? `Line ${anchor.startLine}`
    : `Lines ${anchor.startLine}–${anchor.endLine}`;
}

export function PullRequestReviewPanel(props: PullRequestReviewPanelProps) {
  const { colors } = useTheme();
  const [review, setReview] = useState<CodePullRequestReview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [guideView, setGuideView] = useState<PullRequestGuideView | undefined>();
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState<string | undefined>();
  const [openedFile, setOpenedFile] = useState<OpenedFileTarget | undefined>();
  const [diffState, setDiffState] = useState<DiffLoadState>({ status: "idle" });
  const refreshRunRef = useRef(0);
  const diffRunRef = useRef(0);

  const refresh = useCallback(async () => {
    const run = (refreshRunRef.current += 1);
    setBusy(true);
    setError(undefined);
    setGuideView(undefined);
    setGuideError(undefined);
    setOpenedFile(undefined);
    setDiffState({ status: "idle" });
    try {
      const thread = await loadMobileCodeThread(props.transport, props.threadId);
      const next = await observeMobilePullRequest({
        transport: props.transport,
        threadId: thread.id,
        checkoutId: thread.checkoutId,
      });
      if (refreshRunRef.current !== run) return;
      const nextProjectId = String(thread.projectId);
      setProjectId(nextProjectId);
      setReview(next);
      if (next.state === "observed") {
        setGuideBusy(true);
        const headSha = next.headSha;
        try {
          const guide = await loadMobilePullRequestGuide({
            transport: props.transport,
            target: {
              projectId: nextProjectId,
              baseRepository: next.baseRepository,
              number: next.number,
            },
            ...(headSha === undefined ? {} : { headSha }),
          });
          if (refreshRunRef.current !== run) return;
          setGuideView(guide);
          setGuideError(undefined);
        } catch (caught) {
          if (refreshRunRef.current !== run) return;
          setGuideError(
            caught instanceof Error ? caught.message : "The review guide is unavailable.",
          );
        } finally {
          if (refreshRunRef.current === run) setGuideBusy(false);
        }
      }
    } catch (cause) {
      if (refreshRunRef.current !== run) return;
      setError(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not observe the linked pull request.",
      );
    } finally {
      if (refreshRunRef.current === run) setBusy(false);
    }
  }, [props.threadId, props.transport]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshRunRef.current += 1;
      diffRunRef.current += 1;
    };
  }, [refresh]);

  const guideRunning = guideView?.running === true;
  const observedReview = review?.state === "observed" ? review : undefined;
  useEffect(() => {
    if (!guideRunning || observedReview === undefined || projectId === undefined) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadMobilePullRequestGuide({
        transport: props.transport,
        target: {
          projectId,
          baseRepository: observedReview.baseRepository,
          number: observedReview.number,
        },
        ...(observedReview.headSha === undefined ? {} : { headSha: observedReview.headSha }),
      })
        .then((nextGuide) => {
          if (cancelled) return;
          setGuideView(nextGuide);
          setGuideError(undefined);
        })
        .catch(() => undefined);
    }, RUNNING_GUIDE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [guideRunning, guideView, observedReview, projectId, props.transport]);

  const openChangedFile = useCallback(
    (observed: CodePullRequestReviewObserved, target: OpenedFileTarget) => {
      setOpenedFile(target);
      const operationId = String(observed.operationId);
      if (
        (diffState.status === "ready" || diffState.status === "loading") &&
        diffState.operationId === operationId
      ) {
        return;
      }
      const run = (diffRunRef.current += 1);
      setDiffState({ status: "loading", operationId });
      void loadMobilePullRequestDiff(props.transport, {
        threadId: props.threadId,
        operationId,
        diff: {
          contentId: String(observed.diff.contentId),
          byteLength: observed.diff.byteLength,
          ...(observed.diff.truncated === undefined ? {} : { truncated: observed.diff.truncated }),
        },
      }).then((result) => {
        if (diffRunRef.current !== run) return;
        if (result.status === "ready") {
          setDiffState({
            status: "ready",
            operationId,
            files: result.value.files,
            truncated: result.value.truncated,
          });
        } else {
          setDiffState({ status: "error", operationId, message: result.message });
        }
      });
    },
    [diffState, props.threadId, props.transport],
  );

  const mergeTarget =
    review?.state === "observed" && projectId !== undefined
      ? { projectId, baseRepository: review.baseRepository, number: review.number }
      : undefined;

  const merge = usePullRequestMerge({
    transport: props.transport,
    target: mergeTarget,
    onMerged: () => void refresh(),
  });
  const mergeStep = merge.step;
  const mergeNotice = merge.notice;

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
        warning: {
          ...mobileTypography.body,
          color: colors.warning,
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
        fileRow: {
          paddingVertical: 4,
        },
        guideStops: {
          gap: mobileSpacing.sm,
        },
        stop: {
          gap: 4,
          paddingVertical: 6,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.separator,
        },
        stopHeader: {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        },
        stopTitle: {
          ...mobileTypography.body,
          color: colors.textPrimary,
          fontWeight: "500",
        },
        decisionBadge: {
          ...mobileTypography.caption,
          color: colors.warning,
          fontWeight: "600",
        },
        anchors: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 2,
        },
        anchorLink: {
          ...mobileTypography.caption,
          color: colors.accent,
          fontFamily: "monospace",
        },
        diffScroll: {
          maxHeight: 320,
        },
        diffLine: {
          ...mobileTypography.caption,
          color: colors.textPrimary,
          fontFamily: "monospace",
        },
        diffAdded: {
          color: colors.success,
        },
        diffRemoved: {
          color: colors.danger,
        },
        diffHunk: {
          color: colors.textSecondary,
        },
        diffAnchorLine: {
          backgroundColor: colors.control,
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

  if (openedFile !== undefined) {
    const summaryFile = review.files.find((file) => file.path === openedFile.path);
    const parsedFile =
      diffState.status === "ready"
        ? diffState.files.find((file) => file.path === openedFile.path)
        : undefined;
    const numbered = parsedFile === undefined ? [] : numberedDiffLines(parsedFile.lines);
    const anchor = openedFile.anchor;
    const anchorVerified =
      anchor !== undefined && guideView?.stale === false && review.headSha !== undefined;
    return (
      <View style={styles.block} testID="mobile-pr-file-view">
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpenedFile(undefined)}
          testID="mobile-pr-file-back"
        >
          <Text style={styles.link}>← Back to pull request</Text>
        </Pressable>
        <Text style={styles.title} testID="mobile-pr-file-path">
          {openedFile.path}
        </Text>
        <Text style={styles.meta}>
          {summaryFile === undefined
            ? "Changed file"
            : `+${summaryFile.additions}/−${summaryFile.deletions}`}
          {anchor === undefined ? "" : ` · ${anchorRangeLabel(anchor)}`}
        </Text>
        {anchor !== undefined && !anchorVerified ? (
          <Text style={styles.warning} testID="mobile-pr-file-anchor-stale">
            {guideView?.stale === true
              ? `Written for an older push (${anchorRangeLabel(anchor)} may have moved), so no lines are highlighted here.`
              : `Guide freshness is unknown (${anchorRangeLabel(anchor)} may have moved), so no lines are highlighted here.`}
          </Text>
        ) : null}
        {diffState.status === "ready" && diffState.truncated ? (
          <Text style={styles.warning} testID="mobile-pr-file-truncated">
            The pull request diff hit the phone&apos;s diff limit; later changes or anchor lines may
            be missing. Open the desktop host for the full patch.
          </Text>
        ) : null}
        {diffState.status === "loading" ? (
          <ActivityIndicator color={colors.accent} />
        ) : diffState.status === "error" ? (
          <Text style={styles.error}>{diffState.message}</Text>
        ) : parsedFile === undefined ? (
          <Text style={styles.help} testID="mobile-pr-file-no-diff">
            {diffState.status === "ready" && diffState.truncated
              ? "This file's patch was cut off at the phone's diff limit. Open the desktop host to read it."
              : "No diff lines are available for this file on the phone."}
          </Text>
        ) : parsedFile.binary ? (
          <Text style={styles.help}>Binary file.</Text>
        ) : (
          <ScrollView style={styles.diffScroll}>
            {numbered.map((line, index) => {
              const inAnchor =
                anchorVerified &&
                line.newNumber !== undefined &&
                line.newNumber >= anchor.startLine &&
                line.newNumber <= anchor.endLine;
              const prefix =
                line.newNumber !== undefined
                  ? `${String(line.newNumber).padStart(4, " ")} `
                  : line.oldNumber !== undefined
                    ? `${String(line.oldNumber).padStart(4, " ")} `
                    : "     ";
              return (
                <Text
                  key={`${index}:${line.text}`}
                  style={[
                    styles.diffLine,
                    line.kind === "added"
                      ? styles.diffAdded
                      : line.kind === "removed"
                        ? styles.diffRemoved
                        : line.kind === "hunk" || line.kind === "meta"
                          ? styles.diffHunk
                          : null,
                    inAnchor ? styles.diffAnchorLine : null,
                  ]}
                  testID={inAnchor ? `mobile-pr-file-anchor-line-${line.newNumber}` : undefined}
                >
                  {prefix}
                  {line.text}
                </Text>
              );
            })}
          </ScrollView>
        )}
      </View>
    );
  }

  const truncated = review.files.length > 12;
  const files = review.files.slice(0, 12);
  const guide = guideView?.guide;
  const stops = guide?.stops ?? [];

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
      <View style={styles.guideStops} testID="mobile-pr-guide">
        <Text style={styles.section}>Review guide</Text>
        {guideBusy && guideView === undefined ? (
          <Text style={styles.help}>Reading the guide…</Text>
        ) : guideError !== undefined && guideView === undefined ? (
          <Text style={styles.help}>{guideError}</Text>
        ) : guideView === undefined ? null : (
          <>
            {guideView.stale ? (
              <Text style={styles.warning} testID="mobile-pr-guide-stale">
                Written for an older push.
              </Text>
            ) : guide !== undefined && review.headSha === undefined ? (
              <Text style={styles.help} testID="mobile-pr-guide-freshness-unknown">
                Guide freshness could not be checked against the latest push.
              </Text>
            ) : null}
            {guideView.running ? (
              <Text style={styles.help}>Writing a guide for this push…</Text>
            ) : null}
            {guide === undefined ? (
              <Text style={styles.help} testID="mobile-pr-guide-empty">
                No guide for this push yet.
              </Text>
            ) : (
              <>
                <Text style={styles.meta}>
                  {stops.length} {stops.length === 1 ? "stop" : "stops"} · {String(guide.modelId)}{" "}
                  on {guide.headSha.slice(0, 7)}
                </Text>
                {stops.map((stop, stopIndex) => (
                  <View
                    key={stop.id}
                    style={styles.stop}
                    testID={`mobile-pr-guide-stop-${stopIndex}`}
                  >
                    <View style={styles.stopHeader}>
                      <Text style={styles.stopTitle}>
                        {stopIndex + 1}. {stop.title}
                      </Text>
                      {stop.needsDecision ? (
                        <Text
                          style={styles.decisionBadge}
                          testID={`mobile-pr-guide-decision-${stop.id}`}
                        >
                          Needs your decision
                        </Text>
                      ) : null}
                    </View>
                    {stop.why.length === 0 ? null : <Text style={styles.help}>{stop.why}</Text>}
                    {stop.anchors.length === 0 ? (
                      <Text style={styles.help}>Not anchored to the diff.</Text>
                    ) : (
                      <View style={styles.anchors}>
                        {stop.anchors.map((anchor, anchorIndex) => (
                          <Pressable
                            accessibilityRole="button"
                            key={anchorLabel(anchor)}
                            onPress={() =>
                              openChangedFile(review, { path: String(anchor.path), anchor })
                            }
                            testID={`mobile-pr-guide-anchor-${stop.id}-${anchorIndex}`}
                          >
                            <Text style={styles.anchorLink}>{anchorLabel(anchor)}</Text>
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              </>
            )}
          </>
        )}
      </View>
      <Text style={styles.section}>Changed files</Text>
      <ScrollView style={styles.fileList}>
        {files.map((file) => (
          <Pressable
            accessibilityRole="button"
            key={file.path}
            onPress={() => openChangedFile(review, { path: file.path })}
            style={styles.fileRow}
            testID={`mobile-pr-changed-file-${file.path}`}
          >
            <Text style={styles.file}>
              {file.path} (+{file.additions}/−{file.deletions})
            </Text>
          </Pressable>
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
                  onPress={merge.cancel}
                  testID="mobile-pr-merge-cancel"
                >
                  <Text style={styles.link}>Cancel</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void merge.confirm()}
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
                onPress={() => void merge.begin("merge")}
                testID="mobile-pr-merge-open"
              >
                <Text style={styles.link}>Merge…</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void merge.begin("when-ready")}
                testID="mobile-pr-merge-when-ready-open"
              >
                <Text style={styles.link}>Merge when ready…</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void merge.turnOffMergeWhenReady()}
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
