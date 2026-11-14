import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  loadMobileCodeBoardCard,
  loadMobileCodeEnvironment,
  loadMobileContextMeter,
  loadMobileGitHistory,
  loadMobileLocalServers,
  loadMobileThreadTurnMetrics,
  loadMobileWorkingTreeReview,
  type MobileDiffFile,
  type MobileInboxMode,
  type MobilePaneRead,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import type { CodeThread } from "@octant/contracts";
import { threadStats, threadStatsInputOf } from "@octant/domain";
import { radii, space, typography, useTheme, withAlpha } from "../../design-system";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { BottomSheet } from "../ui/BottomSheet";
import { ListNote, ListRow, ListSection, SegmentedControl } from "../ui/NativeChrome";
import {
  contextMeterPresentation,
  diffstatText,
  folderName,
  listMobileThreadPanes,
  localServerRow,
  subagentSummary,
  workingTreeTotals,
  type MobileThreadPaneId,
} from "./threadPanesPresentation";

export interface ThreadPanesSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly transport: MobileRemoteTransport;
  readonly mode: MobileInboxMode;
  readonly threadId: string;
  /** The Code thread once loaded; Environment and Review need its Project and checkout. */
  readonly codeThread: CodeThread | undefined;
}

/**
 * The desktop thread's side panes at phone scale, read-only: one sheet, one
 * segmented control to move between them. Every row comes from a read the
 * host forwards to a paired device; acting on what a pane shows stays on the
 * Mac, so nothing here commits, stops, or steers.
 */
export function ThreadPanesSheet(props: ThreadPanesSheetProps) {
  const panes = useMemo(() => listMobileThreadPanes(props.mode), [props.mode]);
  const [pane, setPane] = useState<MobileThreadPaneId>(panes[0]?.id ?? "context");
  const active = panes.some((entry) => entry.id === pane) ? pane : (panes[0]?.id ?? "context");
  const scope =
    props.codeThread === undefined
      ? undefined
      : {
          threadId: props.threadId,
          projectId: String(props.codeThread.projectId),
          checkoutId: String(props.codeThread.checkoutId),
        };

  return (
    <BottomSheet
      onClose={props.onClose}
      sheetStyle={styles.sheet}
      testID="mobile-thread-panes"
      title={PANE_TITLES[active]}
      visible={props.visible}
    >
      <View style={styles.switcher}>
        <SegmentedControl
          onSelect={setPane}
          optionTestID={(id) => `mobile-thread-pane-${id}`}
          options={panes}
          selected={active}
          testID="mobile-thread-pane-switcher"
        />
      </View>
      {props.visible ? (
        <ScrollView contentContainerStyle={styles.content} style={styles.scroll}>
          {active === "environment" ? (
            scope === undefined ? (
              <Loading />
            ) : (
              <EnvironmentPane
                onOpenAgents={() => setPane("agents")}
                onOpenReview={() => setPane("review")}
                scope={scope}
                transport={props.transport}
              />
            )
          ) : active === "review" ? (
            scope === undefined ? (
              <Loading />
            ) : (
              <ReviewPane scope={scope} transport={props.transport} />
            )
          ) : active === "context" ? (
            <ContextPane mode={props.mode} threadId={props.threadId} transport={props.transport} />
          ) : (
            <AgentsPane mode={props.mode} threadId={props.threadId} transport={props.transport} />
          )}
        </ScrollView>
      ) : null}
    </BottomSheet>
  );
}

/** The desktop tool names; the segment says Context for room, the title says it whole. */
const PANE_TITLES: Readonly<Record<MobileThreadPaneId, string>> = {
  environment: "Environment",
  review: "Review",
  context: "Context & usage",
  agents: "Agents",
};

const styles = StyleSheet.create({
  sheet: { maxHeight: "90%", minHeight: "60%" },
  switcher: { paddingHorizontal: space.md, paddingBottom: space.md },
  scroll: { flexGrow: 0 },
  content: { paddingBottom: space.lg },
});

interface PaneScope {
  readonly threadId: string;
  readonly projectId: string;
  readonly checkoutId: string;
}

/** One read, started when its pane opens and dropped if the pane closes first. */
function usePaneRead<T>(
  load: () => Promise<MobilePaneRead<T>>,
  key: string,
): MobilePaneRead<T> | undefined {
  const [read, setRead] = useState<MobilePaneRead<T> | undefined>();
  useEffect(() => {
    let current = true;
    setRead(undefined);
    void load().then((answer) => {
      if (current) setRead(answer);
    });
    return () => {
      current = false;
    };
    // The key names everything the read depends on; `load` is a new closure each render.
  }, [key]);
  return read;
}

function Loading() {
  const { colors } = useTheme();
  return <ActivityIndicator color={colors.accent} style={{ marginVertical: space.lg }} />;
}

/** A read that did not come back ready, said in the host's or the phone's words. */
function ReadNote(props: { readonly read: MobilePaneRead<unknown> }) {
  const { colors } = useTheme();
  if (props.read.status === "ready") return null;
  return (
    <ListNote
      last
      text={props.read.message}
      tone={props.read.status === "refused" ? colors.textSecondary : colors.danger}
    />
  );
}

function EnvironmentPane(props: {
  readonly transport: MobileRemoteTransport;
  readonly scope: PaneScope;
  readonly onOpenReview: () => void;
  readonly onOpenAgents: () => void;
}) {
  const { colors } = useTheme();
  const key = `${props.transport.hostId}:${props.scope.threadId}`;
  const environment = usePaneRead(
    () => loadMobileCodeEnvironment(props.transport, props.scope),
    `env:${key}`,
  );
  const servers = usePaneRead(
    () => loadMobileLocalServers(props.transport, props.scope),
    `servers:${key}`,
  );
  const card = usePaneRead(
    () => loadMobileCodeBoardCard(props.transport, props.scope.threadId),
    `card:${key}`,
  );
  if (environment === undefined) return <Loading />;
  const observation = environment.status === "ready" ? environment.value : undefined;
  const linked = card?.status === "ready" ? card.value?.linkedPullRequest : undefined;
  const agents = card?.status === "ready" ? card.value?.childAgents : undefined;

  return (
    <View testID="mobile-pane-environment">
      <ListSection>
        {observation === undefined ? (
          <ReadNote read={environment} />
        ) : observation.status !== "ready" ? (
          <>
            <ListRow label={formatScreenshotSafeLabel(observation.projectName)} />
            <ListNote last text={observation.reason} tone={colors.textSecondary} />
          </>
        ) : (
          <>
            <ListRow
              detail={`${
                observation.branch.kind === "named"
                  ? observation.branch.name
                  : `Detached HEAD ${observation.branch.oid.slice(0, 12)}`
              } · ${folderName(observation.worktreeRoot)}`}
              icon="git-branch-outline"
              label={formatScreenshotSafeLabel(observation.projectName)}
            />
            <ListRow
              accessibilityLabel={
                observation.changes === "clean" ? "No uncommitted changes" : "View changes"
              }
              icon="document-text-outline"
              label={
                observation.changes === "clean" ? "No uncommitted changes" : "Uncommitted changes"
              }
              last
              testID="mobile-pane-environment-changes"
              {...(observation.changes === "clean"
                ? {}
                : {
                    onPress: props.onOpenReview,
                    ...(observation.insertions === undefined || observation.deletions === undefined
                      ? {}
                      : { value: diffstatText(observation.insertions, observation.deletions) }),
                  })}
            />
          </>
        )}
      </ListSection>

      <ListSection title="Running">
        {servers === undefined ? (
          <ListRow icon="server-outline" label="Local servers" value="Reading" />
        ) : servers.status !== "ready" ? (
          <>
            <ListRow icon="server-outline" label="Local servers" />
            <ReadNote read={servers} />
          </>
        ) : servers.value.currentCheckout.length === 0 ? (
          <ListRow
            icon="server-outline"
            label="Local servers"
            value={
              servers.value.other.length === 0 ? "None" : `${servers.value.other.length} other`
            }
          />
        ) : (
          servers.value.currentCheckout.map((listener) => {
            const row = localServerRow(listener);
            return (
              <ListRow
                detail={row.detail}
                icon="server-outline"
                key={String(listener.listenerId)}
                label={row.label}
              />
            );
          })
        )}
        <ListRow
          icon="people-outline"
          label="Subagents"
          last
          onPress={props.onOpenAgents}
          detail={
            agents === undefined
              ? card === undefined
                ? "Reading"
                : "Unknown"
              : subagentSummary(agents)
          }
        />
      </ListSection>

      <ListSection title="Delivery">
        <ListRow
          icon="git-pull-request-outline"
          label="Pull request"
          last
          {...(linked === undefined
            ? { value: card === undefined ? "Reading" : "Unknown" }
            : linked.kind === "none"
              ? { value: "None" }
              : {
                  value: `#${linked.number} · ${linked.state}`,
                  detail: `${linked.headBranch} → ${linked.baseBranch}`,
                })}
        />
      </ListSection>
      {card?.status === "ready" ? null : card === undefined ? null : (
        <ListSection>
          <ReadNote read={card} />
        </ListSection>
      )}
    </View>
  );
}

function ReviewPane(props: {
  readonly transport: MobileRemoteTransport;
  readonly scope: PaneScope;
}) {
  const { colors } = useTheme();
  const key = `${props.transport.hostId}:${props.scope.threadId}:${props.scope.checkoutId}`;
  const changes = usePaneRead(
    () => loadMobileWorkingTreeReview(props.transport, props.scope),
    `changes:${key}`,
  );
  const history = usePaneRead(
    () => loadMobileGitHistory(props.transport, props.scope),
    `history:${key}`,
  );
  const [open, setOpen] = useState<string | undefined>();
  if (changes === undefined) return <Loading />;
  const files = changes.status === "ready" ? changes.value.files : [];
  const opened = files.find((file) => file.path === open);
  if (opened !== undefined) {
    return (
      <View testID="mobile-pane-review-file">
        <ListSection>
          <ListRow
            accessibilityLabel="Back to all changes"
            icon="chevron-back"
            label="All changes"
            last
            onPress={() => setOpen(undefined)}
            testID="mobile-pane-review-back"
            accessory="none"
          />
        </ListSection>
        <UnifiedDiff file={opened} />
      </View>
    );
  }
  const totals = workingTreeTotals(files);
  return (
    <View testID="mobile-pane-review">
      <ListSection
        footer={
          changes.status === "ready" && changes.value.truncated
            ? "The diff was cut at the phone's limit; later files may be missing."
            : undefined
        }
        title={
          files.length === 0
            ? "Uncommitted changes"
            : `Uncommitted changes · ${diffstatText(totals.additions, totals.deletions)}`
        }
      >
        {changes.status !== "ready" ? (
          <ReadNote read={changes} />
        ) : files.length === 0 ? (
          <ListNote last text="No uncommitted changes." tone={colors.textSecondary} />
        ) : (
          files.map((file, index) => (
            <ListRow
              detail={file.binary ? "Binary file" : undefined}
              key={file.path}
              label={file.path}
              last={index === files.length - 1}
              onPress={file.binary ? undefined : () => setOpen(file.path)}
              testID={`mobile-pane-review-file-${index}`}
              value={file.binary ? undefined : diffstatText(file.additions, file.deletions)}
            />
          ))
        )}
      </ListSection>
      <ListSection title="History">
        {history === undefined ? (
          <ListRow label="Reading history" />
        ) : history.status !== "ready" ? (
          <ReadNote read={history} />
        ) : history.value.commits.length === 0 ? (
          <ListNote last text="No commits on this branch yet." tone={colors.textSecondary} />
        ) : (
          history.value.commits
            .slice(0, 20)
            .map((commit, index, shown) => (
              <ListRow
                detail={`${commit.oid.slice(0, 7)} · ${formatScreenshotSafeLabel(commit.author, 40)} · ${commit.authoredAt.slice(0, 10)}`}
                key={commit.oid}
                label={formatScreenshotSafeLabel(commit.subject)}
                last={index === shown.length - 1}
              />
            ))
        )}
      </ListSection>
    </View>
  );
}

/** One file's unified diff in mono, added and removed lines in the diff inks. */
function UnifiedDiff(props: { readonly file: MobileDiffFile }) {
  const { colors } = useTheme();
  const diffStyles = useMemo(
    () =>
      StyleSheet.create({
        frame: {
          marginHorizontal: space.md,
          borderRadius: radii.md,
          overflow: "hidden",
          backgroundColor: colors.surfaceElevatedSolid,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.hairline,
        },
        path: {
          color: colors.textSecondary,
          fontSize: typography.meta.fontSize,
          fontFamily: typography.mono.fontFamily,
          paddingHorizontal: space.sm,
          paddingVertical: space.xs,
        },
        line: {
          fontFamily: typography.mono.fontFamily,
          fontSize: 12,
          lineHeight: 18,
          paddingHorizontal: space.sm,
          color: colors.textPrimary,
        },
        added: { backgroundColor: withAlpha(colors.success, 0.14), color: colors.success },
        removed: { backgroundColor: withAlpha(colors.danger, 0.14), color: colors.danger },
        hunk: { color: colors.textTertiary, backgroundColor: colors.control },
      }),
    [colors],
  );
  return (
    <View style={diffStyles.frame} testID="mobile-pane-review-diff">
      <Text style={diffStyles.path}>
        {props.file.path} {diffstatText(props.file.additions, props.file.deletions)}
      </Text>
      <ScrollView horizontal>
        <View>
          {props.file.lines.map((line, index) => (
            <Text
              key={index}
              style={[
                diffStyles.line,
                line.kind === "added"
                  ? diffStyles.added
                  : line.kind === "removed"
                    ? diffStyles.removed
                    : line.kind === "hunk"
                      ? diffStyles.hunk
                      : null,
              ]}
            >
              {line.text}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function ContextPane(props: {
  readonly transport: MobileRemoteTransport;
  readonly mode: MobileInboxMode;
  readonly threadId: string;
}) {
  const { colors } = useTheme();
  const key = `${props.transport.hostId}:${props.mode}:${props.threadId}`;
  const meter = usePaneRead(
    () => loadMobileContextMeter(props.transport, { mode: props.mode, threadId: props.threadId }),
    `meter:${key}`,
  );
  const usage = usePaneRead(
    () => loadMobileThreadTurnMetrics(props.transport, props.threadId),
    `usage:${key}`,
  );
  const meterStyles = useMemo(
    () =>
      StyleSheet.create({
        block: { paddingHorizontal: space.md, paddingVertical: space.md, gap: space.xs },
        label: {
          color: colors.textPrimary,
          fontSize: typography.rowLabel.fontSize,
          fontWeight: typography.rowLabel.fontWeight,
          fontVariant: ["tabular-nums"],
        },
        track: {
          height: 6,
          borderRadius: radii.pill,
          backgroundColor: colors.control,
          overflow: "hidden",
        },
        fill: { height: 6, borderRadius: radii.pill, backgroundColor: colors.accent },
        note: { color: colors.textTertiary, fontSize: typography.meta.fontSize },
      }),
    [colors],
  );
  if (meter === undefined) return <Loading />;
  const shown = meter.status === "ready" ? contextMeterPresentation(meter.value) : undefined;
  const stats =
    usage?.status === "ready" && usage.value !== undefined
      ? threadStats(threadStatsInputOf(usage.value))
      : [];
  return (
    <View testID="mobile-pane-context">
      <ListSection title="Context">
        {shown === undefined ? (
          <ReadNote read={meter} />
        ) : (
          <View style={meterStyles.block} testID="mobile-pane-context-meter">
            <Text style={meterStyles.label}>{shown.label}</Text>
            {shown.fraction === undefined ? null : (
              <View
                accessibilityLabel={`Context ${shown.label}`}
                accessibilityRole="progressbar"
                style={meterStyles.track}
              >
                <View style={[meterStyles.fill, { width: `${shown.fraction * 100}%` }]} />
              </View>
            )}
            <Text style={meterStyles.note}>{shown.note}</Text>
          </View>
        )}
      </ListSection>
      <ListSection title="Usage">
        {usage === undefined ? (
          <ListRow label="Reading usage" />
        ) : usage.status !== "ready" ? (
          <ReadNote read={usage} />
        ) : stats.length === 0 ? (
          <ListNote
            last
            text="The provider reported no usage for this thread."
            tone={colors.textSecondary}
          />
        ) : (
          stats.map((stat, index) => (
            <ListRow
              accessibilityLabel={stat.label}
              key={stat.key}
              label={STAT_NAMES[stat.key]}
              last={index === stats.length - 1}
              value={stat.text}
            />
          ))
        )}
      </ListSection>
    </View>
  );
}

const STAT_NAMES: Readonly<Record<ReturnType<typeof threadStats>[number]["key"], string>> = {
  turns: "Turns",
  input: "Input",
  output: "Output",
  reasoning: "Thinking",
  cache: "Cache hit",
  speed: "Speed",
  "first-token": "First token",
  cost: "Cost",
};

function AgentsPane(props: {
  readonly transport: MobileRemoteTransport;
  readonly mode: MobileInboxMode;
  readonly threadId: string;
}) {
  const { colors } = useTheme();
  if (props.mode !== "code") {
    return (
      <View testID="mobile-pane-agents">
        <ListSection footer="Reading and steering a subagent stays on the Mac.">
          <ListNote
            last
            text="This host lists a thread's subagents only at a window on the Mac."
            tone={colors.textSecondary}
          />
        </ListSection>
      </View>
    );
  }
  return <CodeAgentsPane threadId={props.threadId} transport={props.transport} />;
}

function CodeAgentsPane(props: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
}) {
  const { colors } = useTheme();
  const card = usePaneRead(
    () => loadMobileCodeBoardCard(props.transport, props.threadId),
    `agents:${props.transport.hostId}:${props.threadId}`,
  );
  if (card === undefined) return <Loading />;
  if (card.status !== "ready") {
    return (
      <ListSection>
        <ReadNote read={card} />
      </ListSection>
    );
  }
  const agents = card.value?.childAgents;
  return (
    <View testID="mobile-pane-agents">
      <ListSection footer="Reading and steering a subagent stays on the Mac." title="Subagents">
        {agents === undefined ? (
          <ListNote
            last
            text="This thread is not on the host's board."
            tone={colors.textSecondary}
          />
        ) : (
          <>
            <ListRow label="Working" value={String(agents.active)} />
            <ListRow label="To review" value={String(agents.unacknowledgedResults)} />
            <ListRow label="Done" value={String(agents.completed)} />
            <ListRow
              label="Failed"
              last={agents.latestSummary === undefined}
              value={String(agents.failed)}
              {...(agents.failed > 0 ? { valueTone: colors.danger } : {})}
            />
            {agents.latestSummary === undefined ? null : (
              <ListNote last text={formatScreenshotSafeLabel(agents.latestSummary, 400)} />
            )}
          </>
        )}
      </ListSection>
    </View>
  );
}
