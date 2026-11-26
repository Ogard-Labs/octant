import { useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Icon } from "../ui/Icon";
import type { MobileInboxRow } from "@octant/client-runtime";
import { space, typography, useTheme, withAlpha, type ThemeColors } from "../../design-system";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import type { MobileIconName } from "../ui/IconButton";
import { MOBILE_COPY } from "../copy";
import { useOutbox } from "../outbox/OutboxContext";
import { ProviderMark } from "../ui/ProviderMark";
import { useMobileThreads } from "./MobileThreadsContext";
import { threadRowActions } from "./threadRowActions";
import { ThreadRowMenu } from "./ThreadRowMenu";
import { ThreadRowSwipe, type SwipeAction } from "./ThreadRowSwipe";
import { useThreadRowAction } from "./useThreadRowAction";
import { threadModeIcon, threadModeLabel } from "./threadRowPresentation";
import {
  projectMonogram,
  pullRequestChip,
  threadRowState,
  type ThreadRowKind,
} from "./threadRowState";

const STATE_ICON: Readonly<Record<ThreadRowKind, MobileIconName | undefined>> = {
  waiting: "alert-circle-outline",
  failed: "close-circle-outline",
  finished: "checkmark-circle-outline",
  review: "eye-outline",
  working: "ellipse-outline",
  idle: undefined,
  settled: undefined,
};

function stateInk(kind: ThreadRowKind, colors: ThemeColors): string {
  switch (kind) {
    case "waiting":
      return colors.warning;
    case "failed":
      return colors.danger;
    case "finished":
      return colors.success;
    case "review":
      return colors.palettePurple;
    case "working":
      return colors.paletteBlue;
    case "idle":
    case "settled":
      return colors.textTertiary;
  }
}

/** One hue per Project name, the same on every launch. */
function projectHue(name: string, colors: ThemeColors): string {
  const hues = [
    colors.palettePurple,
    colors.paletteGreen,
    colors.paletteBlue,
    colors.paletteOrange,
    colors.paletteTeal,
  ];
  let sum = 0;
  for (const letter of name) sum = (sum * 31 + (letter.codePointAt(0) ?? 0)) % 9_973;
  return hues[sum % hues.length] ?? colors.paletteBlue;
}

const PULL_REQUEST_INK = (state: string, colors: ThemeColors): string =>
  state === "merged" ? colors.merged : state === "open" ? colors.paletteGreen : colors.textTertiary;

/** From here a title and its state no longer fit one line side by side. */
const LARGE_TEXT = 1.4;

/**
 * One thread in any list: its Project's letters and title, the computer and
 * mode under it, and at the end its state in words with its pull requests and
 * its provider's mark. At the largest text sizes the title takes the width and
 * its state goes under it. A long press offers what the row menu offers. A
 * running thread steps back, since nothing is asked of the person there.
 */
export function ThreadRow(props: {
  readonly row: MobileInboxRow;
  readonly last: boolean;
  readonly onOpen: (row: MobileInboxRow) => void;
}) {
  const { row } = props;
  const { colors } = useTheme();
  const { transports } = useMobileSession();
  const { hostLabel, projectName, provider: providerOf, refresh, settled } = useMobileThreads();
  const transport = transports.find((entry) => entry.hostId === row.hostId);
  const project = projectName(row);
  const provider = providerOf(row);
  const outgoing = useOutbox().waitingFor(row).length > 0;
  const state = outgoing
    ? ({ kind: "waiting", word: MOBILE_COPY.outboxRow, spoken: MOBILE_COPY.outboxWaiting } as const)
    : threadRowState(row, new Date());
  const quiet = state.kind === "working" || state.kind === "settled";
  const ink = stateInk(state.kind, colors);
  const letters = project === undefined ? "" : projectMonogram(project);
  const hue = project === undefined ? colors.textSecondary : projectHue(project, colors);
  // The glyphs stand for words, so they follow the text size as words would.
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= LARGE_TEXT;
  const glyph = (size: number) => Math.round(size * Math.min(Math.max(fontScale, 1), 2));
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          minHeight: 54,
          flexDirection: "row",
          paddingLeft: space.md,
        },
        pressed: { backgroundColor: colors.controlHover },
        badge: {
          width: 20,
          height: 20,
          marginTop: 8,
          marginRight: 10,
          borderRadius: 5,
          alignItems: "center",
          justifyContent: "center",
        },
        letters: { fontSize: 9.5, fontWeight: "700" },
        body: { flex: 1, paddingVertical: 8, paddingRight: space.md, gap: 2 },
        separator: {
          position: "absolute",
          left: space.md,
          right: 0,
          bottom: 0,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.hairline,
        },
        quiet: { opacity: 0.55 },
        line: { flexDirection: "row", alignItems: "center", gap: space.sm },
        lines: { alignItems: "flex-start", gap: 2 },
        placeAlone: { flexDirection: "row", alignItems: "center", gap: 5 },
        title: { flex: 1, color: colors.textPrimary, fontSize: 16, fontWeight: "500" },
        state: { flexDirection: "row", alignItems: "center", gap: 4 },
        stateWord: { fontSize: typography.detail.fontSize, fontWeight: "600" },
        place: { flex: 1, flexDirection: "row", alignItems: "center", gap: 5 },
        placeText: { flexShrink: 1, color: colors.textTertiary, fontSize: 13 },
        pullRequest: { flexDirection: "row", alignItems: "center", gap: 3 },
        pullRequestText: { fontSize: typography.detail.fontSize, fontVariant: ["tabular-nums"] },
      }),
    [colors],
  );
  const title = formatScreenshotSafeLabel(row.title);
  const place = `${hostLabel(row.hostId)} · ${threadModeLabel(row.mode)}`;
  const icon = STATE_ICON[state.kind];
  const pullRequests = row.pullRequests;
  const pullRequestInk =
    pullRequests === undefined ? "" : PULL_REQUEST_INK(pullRequests.state, colors);
  const { run } = useThreadRowAction({
    row,
    transport,
    onDone: (action) => {
      if (action.kind === "put-away") settled(row);
      void refresh();
    },
    onFailed: (message) => Alert.alert(title, message),
  });
  const offered = threadRowActions(row, new Date()).flatMap((offer) =>
    offer.kind === "action" ? [offer.action] : [],
  );
  const swiped = (id: string, fill: string): ReadonlyArray<SwipeAction> =>
    offered
      .filter((action) => action.id === id)
      .map((action) => ({ ...action, fill, onPress: () => run(action.run) }));
  // The everyday ones; the row's menu holds the rest, snooze times among them.
  const leading = swiped("pin", colors.paletteOrange);
  const trailing = [
    ...swiped("put-away", colors.success),
    ...swiped("reopen", colors.paletteBlue),
    ...swiped("wake", colors.palettePurple),
  ];
  const stateWord = (
    <View style={styles.state}>
      {icon === undefined ? null : <Icon color={ink} name={icon} size={glyph(15)} />}
      <Text numberOfLines={1} style={[styles.stateWord, { color: ink }]}>
        {state.word}
      </Text>
    </View>
  );
  return (
    <ThreadRowSwipe leading={leading} trailing={trailing}>
      <ThreadRowMenu onChanged={() => void refresh()} row={row} transport={transport}>
        {({ onLongPress, onOffer }) => (
          <Pressable
            accessibilityActions={[{ name: "longpress", label: "Thread actions" }]}
            accessibilityLabel={[
              title,
              state.spoken,
              project === undefined ? "" : formatScreenshotSafeLabel(project),
              place,
              pullRequests === undefined
                ? ""
                : pullRequests.count === 1
                  ? `Pull request ${pullRequests.number}`
                  : `${pullRequests.count} pull requests`,
              provider === undefined ? "" : formatScreenshotSafeLabel(provider.displayName),
            ]
              .filter((part) => part.length > 0)
              .join(", ")}
            accessibilityRole="button"
            onAccessibilityAction={onOffer}
            {...(onLongPress === undefined ? {} : { onLongPress })}
            onPress={() => props.onOpen(row)}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`mobile-home-thread-row-${row.mode}-${row.threadId}`}
          >
            <View
              style={[
                styles.badge,
                { backgroundColor: withAlpha(hue, 0.18) },
                quiet ? styles.quiet : null,
              ]}
            >
              {letters === "" ? (
                <Icon color={hue} name={threadModeIcon(row.mode)} size={12} />
              ) : (
                <Text allowFontScaling={false} style={[styles.letters, { color: hue }]}>
                  {letters}
                </Text>
              )}
            </View>
            <View style={styles.body}>
              <View style={[styles.line, quiet ? styles.quiet : null]}>
                {row.pinned === true ? (
                  <Icon color={colors.textTertiary} name="pin" size={glyph(13)} />
                ) : null}
                <Text numberOfLines={large ? 3 : 1} style={styles.title}>
                  {title}
                </Text>
                {large ? null : stateWord}
              </View>
              {large ? <View style={quiet ? styles.quiet : null}>{stateWord}</View> : null}
              <View style={[large ? styles.lines : styles.line, quiet ? styles.quiet : null]}>
                <View style={large ? styles.placeAlone : styles.place}>
                  <Icon color={colors.textTertiary} name="desktop-outline" size={glyph(13)} />
                  <Text numberOfLines={large ? 2 : 1} style={styles.placeText}>
                    {place}
                  </Text>
                </View>
                {pullRequests === undefined ? null : (
                  <View style={styles.pullRequest}>
                    <Icon color={pullRequestInk} name="git-pull-request-outline" size={glyph(14)} />
                    <Text style={[styles.pullRequestText, { color: pullRequestInk }]}>
                      {pullRequestChip(pullRequests)}
                    </Text>
                  </View>
                )}
                {provider === undefined ? null : (
                  <ProviderMark driverKind={provider.driverKind} size={glyph(15)} />
                )}
              </View>
            </View>
            {props.last ? null : <View pointerEvents="none" style={styles.separator} />}
          </Pressable>
        )}
      </ThreadRowMenu>
    </ThreadRowSwipe>
  );
}
