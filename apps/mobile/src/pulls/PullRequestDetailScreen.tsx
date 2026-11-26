import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  listMobilePullRequests,
  readMobilePullRequestSwitches,
  setMobilePullRequestBabysit,
  type MobileInboxRow,
} from "@octant/client-runtime";
import type {
  CodeProjectPullRequestAutoFixState,
  CodeProjectPullRequestRow,
} from "@octant/contracts";
import { MOBILE_COPY } from "../copy";
import { space, typography, useTheme } from "../../design-system";
import { useMobileThreads } from "../inbox/MobileThreadsContext";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { mergeConfirmationCopy } from "../review/pullRequestMergePresentation";
import { usePullRequestMerge } from "../review/usePullRequestMerge";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { ListNote, ListRow, ListSection } from "../ui/NativeChrome";
import { CHECKS_ICON, toneInk } from "./PullRequestRow";
import {
  babysitStatusLabel,
  pullRequestBadges,
  pullRequestChecks,
  pullRequestKey,
  pullRequestMergeability,
  pullRequestReview,
  pullRequestStateChip,
  type MobilePullRequest,
} from "./pullRequestPresentation";

function withoutAutoMerge(row: CodeProjectPullRequestRow): CodeProjectPullRequestRow {
  const { merging: _merging, ...rest } = row;
  return rest;
}

/** A pull request the computer just merged: no Merge, nothing on its way. */
export function mergedRow(row: CodeProjectPullRequestRow): CodeProjectPullRequestRow {
  const { merging: _merging, ...rest } = row;
  return { ...rest, state: "merged" };
}

/**
 * One pull request: where it stands, its failing checks, the threads that
 * work on it, and Merge. Merging re-reads the pull request on the computer
 * and asks the person to confirm the head it just saw.
 */
export function PullRequestDetailScreen(props: {
  readonly pullRequest: MobilePullRequest;
  readonly onOpenThread: (row: MobileInboxRow) => void;
}) {
  const { colors } = useTheme();
  const { transportForHost } = useMobileSession();
  const { rows } = useMobileThreads();
  const { hostId } = props.pullRequest;
  const transport = transportForHost(hostId);
  const [row, setRow] = useState<CodeProjectPullRequestRow>(props.pullRequest.row);

  // After a merge the row is read again; one no longer listed keeps what was shown.
  const reload = useCallback(async () => {
    if (transport === undefined) return;
    const list = await listMobilePullRequests(transport);
    if (list.status !== "ready") return;
    const wanted = pullRequestKey(props.pullRequest);
    const next = list.rows.find((entry) => pullRequestKey({ hostId, row: entry }) === wanted);
    if (next !== undefined) setRow(next);
  }, [hostId, props.pullRequest, transport]);

  const open = row.state === "open";
  const target = open
    ? {
        projectId: String(row.projectId),
        baseRepository: `${row.repositoryOwner}/${row.repositoryName}`,
        number: row.number,
      }
    : undefined;
  const switchTarget =
    transport === undefined
      ? undefined
      : {
          projectId: String(row.projectId),
          repositoryOwner: row.repositoryOwner,
          repositoryName: row.repositoryName,
          number: row.number,
        };
  const [autoFix, setAutoFix] = useState<CodeProjectPullRequestAutoFixState>();
  const [babysitBusy, setBabysitBusy] = useState(false);
  const [babysitNotice, setBabysitNotice] = useState<string>();
  const { projectId, repositoryOwner, repositoryName, number } = row;
  const [mergeWhenReadyConfirmed, setMergeWhenReadyOn] = useState<boolean>();
  useEffect(() => {
    if (transport === undefined || !open) return;
    let live = true;
    void readMobilePullRequestSwitches(transport, {
      projectId: String(projectId),
      repositoryOwner,
      repositoryName,
      number,
    }).then((state) => {
      if (!live || state === undefined) return;
      setAutoFix(state.autoFix);
      setMergeWhenReadyOn(state.mergeWhenReadyOn);
    });
    return () => {
      live = false;
    };
  }, [transport, open, projectId, repositoryOwner, repositoryName, number]);
  const mergeWhenReadyOn = mergeWhenReadyConfirmed ?? row.merging === "auto-merge";
  // What the page says of the pull request follows the switch the computer
  // confirmed; the row's queue place stays its own.
  const shownRow: CodeProjectPullRequestRow =
    mergeWhenReadyOn === (row.merging === "auto-merge")
      ? row
      : mergeWhenReadyOn
        ? row.merging === "queued"
          ? row
          : { ...row, merging: "auto-merge" }
        : withoutAutoMerge(row);
  const merge = usePullRequestMerge({
    transport,
    target,
    // The overview lists open pull requests only, so a merged one is marked
    // here from the computer's answer rather than read back.
    onMerged: () => setRow(mergedRow),
    // Kept apart from the row: a later read of the overview may predate the
    // switch, and the row's `merging` also says whether it sits in the queue.
    onMergeWhenReady: setMergeWhenReadyOn,
  });

  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: { paddingTop: space.sm, paddingBottom: space.xl },
        lead: { paddingHorizontal: space.md + 4, paddingBottom: space.md, gap: 4 },
        title: {
          color: colors.textPrimary,
          fontSize: typography.title.fontSize,
          fontWeight: typography.title.fontWeight,
          letterSpacing: typography.title.letterSpacing,
        },
        meta: { color: colors.textSecondary, fontSize: typography.detail.fontSize },
      }),
    [colors],
  );

  const state = pullRequestStateChip(row);
  const checks = pullRequestChecks(row);
  const review = pullRequestReview(row);
  const mergeability = pullRequestMergeability(row);
  const badges = pullRequestBadges(shownRow);
  const failing = row.failingChecks ?? [];
  const threads = row.linkedThreads.map((linked) => ({
    linked,
    row: rows.find(
      (entry) =>
        entry.hostId === hostId &&
        entry.mode === "code" &&
        entry.threadId === String(linked.threadId),
    ),
  }));

  // Babysit: one thread linked to the pull request watches it at a time.
  // Turning it on asks which checks to wait for, as the computer does.
  const babysitOffers: ReadonlyArray<{
    readonly kind: "on" | "off";
    readonly threadId: string;
    readonly title: string;
  }> =
    !open || autoFix === undefined || switchTarget === undefined
      ? []
      : autoFix.status === "on"
        ? [{ kind: "off", threadId: String(autoFix.threadId), title: "" }]
        : threads.map((thread) => ({
            kind: "on",
            threadId: String(thread.linked.threadId),
            title: thread.linked.title,
          }));
  const changeBabysit = (
    offer: { readonly kind: "on" | "off"; readonly threadId: string },
    checks: "required" | "all",
  ) => {
    if (transport === undefined || switchTarget === undefined) return;
    setBabysitBusy(true);
    setBabysitNotice(undefined);
    void setMobilePullRequestBabysit(
      transport,
      offer.kind === "on"
        ? { ...switchTarget, on: true, threadId: offer.threadId, checks }
        : { ...switchTarget, on: false, threadId: offer.threadId },
    ).then((change) => {
      setBabysitBusy(false);
      if (change.status === "applied") setAutoFix(change.autoFix);
      else setBabysitNotice(change.message);
      void reload();
    });
  };
  const askBabysit = (offer: { readonly kind: "on" | "off"; readonly threadId: string }) =>
    offer.kind === "off"
      ? Alert.alert(MOBILE_COPY.pullRequestBabysitOffTitle, MOBILE_COPY.pullRequestBabysitOffBody, [
          { text: MOBILE_COPY.pullRequestBabysitCancel, style: "cancel" },
          {
            text: MOBILE_COPY.pullRequestBabysitTurnOff,
            style: "destructive",
            onPress: () => changeBabysit(offer, "required"),
          },
        ])
      : Alert.alert(MOBILE_COPY.pullRequestBabysitOnTitle, MOBILE_COPY.pullRequestBabysitOnBody, [
          {
            text: MOBILE_COPY.pullRequestBabysitRequiredChecks,
            onPress: () => changeBabysit(offer, "required"),
          },
          {
            text: MOBILE_COPY.pullRequestBabysitAllChecks,
            onPress: () => changeBabysit(offer, "all"),
          },
          { text: MOBILE_COPY.pullRequestBabysitCancel, style: "cancel" },
        ]);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      testID="mobile-pr-detail"
    >
      <ScreenHeader
        subtitle={`${row.repositoryOwner}/${row.repositoryName}`}
        title={`#${row.number}`}
      />
      <View style={styles.lead}>
        <Text style={styles.title}>{formatScreenshotSafeLabel(row.title)}</Text>
        <Text style={styles.meta}>
          {`${row.headBranch} → ${row.baseBranch} · ${formatScreenshotSafeLabel(row.author)}`}
        </Text>
      </View>

      <ListSection title={MOBILE_COPY.pullRequestSectionStatus}>
        <ListRow
          icon={row.state === "merged" ? "git-merge-outline" : "git-pull-request-outline"}
          label={state.label}
          labelTone={toneInk(state.tone, colors)}
          last={!open && badges.length === 0}
        />
        {open ? (
          <>
            <ListRow
              icon="eye-outline"
              label={review.label}
              labelTone={toneInk(review.tone, colors)}
            />
            <ListRow
              icon="git-branch-outline"
              label={mergeability.label}
              labelTone={toneInk(mergeability.tone, colors)}
              last={badges.length === 0}
            />
          </>
        ) : null}
        {badges.map((badge, index) => (
          <ListRow
            icon="time-outline"
            key={badge}
            label={badge}
            labelTone={colors.accent}
            last={index === badges.length - 1}
          />
        ))}
      </ListSection>

      <ListSection testID="mobile-pr-checks" title={MOBILE_COPY.pullRequestSectionChecks}>
        <ListRow
          icon={CHECKS_ICON[checks.tone]}
          label={checks.label}
          labelTone={toneInk(checks.tone, colors)}
          last={failing.length === 0}
        />
        {failing.map((check, index) => (
          <ListRow
            icon="close-circle-outline"
            key={check.name}
            label={formatScreenshotSafeLabel(check.name)}
            last={index === failing.length - 1}
            value={MOBILE_COPY.pullRequestFailingCheck}
            valueTone={colors.danger}
          />
        ))}
      </ListSection>

      {threads.length === 0 ? null : (
        <ListSection testID="mobile-pr-threads" title={MOBILE_COPY.pullRequestSectionThreads}>
          {threads.map((thread, index) => {
            const found = thread.row;
            return (
              <ListRow
                detail={found === undefined ? MOBILE_COPY.pullRequestThreadElsewhere : undefined}
                icon="code-slash-outline"
                key={String(thread.linked.threadId)}
                label={formatScreenshotSafeLabel(thread.linked.title)}
                last={index === threads.length - 1}
                onPress={found === undefined ? undefined : () => props.onOpenThread(found)}
                testID={`mobile-pr-thread-${String(thread.linked.threadId)}`}
              />
            );
          })}
        </ListSection>
      )}

      <ListSection
        footer={MOBILE_COPY.pullRequestBabysitHelp}
        testID="mobile-pr-babysit-section"
        title={MOBILE_COPY.pullRequestSectionBabysit}
      >
        <ListRow
          icon="construct-outline"
          label={babysitStatusLabel(row)}
          last={babysitOffers.length === 0 && babysitNotice === undefined}
          testID="mobile-pr-babysit"
        />
        {babysitOffers.map((offer, index) => (
          <ListRow
            accessory="none"
            key={`${offer.kind}:${offer.threadId}`}
            label={
              offer.kind === "off"
                ? MOBILE_COPY.pullRequestBabysitTurnOff
                : MOBILE_COPY.pullRequestBabysitTurnOn(formatScreenshotSafeLabel(offer.title))
            }
            labelTone={offer.kind === "off" ? colors.danger : colors.accent}
            last={index === babysitOffers.length - 1 && babysitNotice === undefined}
            onPress={babysitBusy ? undefined : () => askBabysit(offer)}
            testID={`mobile-pr-babysit-${offer.kind}-${offer.threadId}`}
          />
        ))}
        {babysitNotice === undefined ? null : <ListNote text={babysitNotice} />}
      </ListSection>

      {target === undefined || transport === undefined ? null : (
        <ListSection
          footer={MOBILE_COPY.pullRequestMergeHelp}
          testID="mobile-pr-merge"
          title={MOBILE_COPY.pullRequestSectionMerge}
        >
          {merge.step?.kind === "confirm" ? (
            <>
              <ListNote
                text={mergeConfirmationCopy(merge.step.mode, row.number, merge.step.state.headSha)}
              />
              <ListRow
                accessory="none"
                label={
                  merge.step.mode === "merge"
                    ? MOBILE_COPY.pullRequestMergeConfirm
                    : MOBILE_COPY.pullRequestMergeWhenReadyConfirm
                }
                labelTone={colors.accent}
                onPress={() => void merge.confirm()}
                testID="mobile-pr-merge-confirm"
              />
              <ListRow
                accessory="none"
                label={MOBILE_COPY.pullRequestMergeCancel}
                labelTone={colors.textSecondary}
                last={merge.notice === undefined}
                onPress={merge.cancel}
                testID="mobile-pr-merge-cancel"
              />
            </>
          ) : merge.step === undefined ? (
            <>
              <ListRow
                accessory="none"
                label={MOBILE_COPY.pullRequestMergeAction}
                labelTone={colors.accent}
                onPress={() => void merge.begin("merge")}
                testID="mobile-pr-merge-open"
              />
              <ListRow
                accessory="none"
                label={MOBILE_COPY.pullRequestMergeWhenReadyAction}
                labelTone={colors.accent}
                last={!mergeWhenReadyOn && merge.notice === undefined}
                onPress={() => void merge.begin("when-ready")}
                testID="mobile-pr-merge-when-ready-open"
              />
              {mergeWhenReadyOn ? (
                <ListRow
                  accessory="none"
                  label={MOBILE_COPY.pullRequestMergeWhenReadyOff}
                  labelTone={colors.danger}
                  last={merge.notice === undefined}
                  onPress={() => void merge.turnOffMergeWhenReady()}
                  testID="mobile-pr-merge-when-ready-off"
                />
              ) : null}
            </>
          ) : (
            <View style={{ paddingVertical: space.md }}>
              <ActivityIndicator color={colors.accent} />
            </View>
          )}
          {merge.notice === undefined ? null : (
            <ListNote last testID="mobile-pr-merge-notice" text={merge.notice} />
          )}
        </ListSection>
      )}
    </ScrollView>
  );
}
