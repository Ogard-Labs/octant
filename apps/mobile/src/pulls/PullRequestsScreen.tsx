import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { listMobilePullRequests, type MobilePullRequestList } from "@octant/client-runtime";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES } from "../copy";
import { useTheme } from "../../design-system";
import { NEW_BUTTON_CLEARANCE } from "../navigation/places";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { useMobileSession } from "../session/MobileSessionContext";
import { EmptyPlace } from "../ui/EmptyPlace";
import { ListNote, ListSection } from "../ui/NativeChrome";
import { PullRequestGroup } from "./PullRequestGroup";
import { groupPullRequests, type MobilePullRequest } from "./pullRequestPresentation";

/** Open pull requests from every paired computer, sorted by what they wait on. */
export function PullRequestsScreen(props: {
  readonly onOpen: (pullRequest: MobilePullRequest) => void;
}) {
  const { colors } = useTheme();
  const { transports, hosts } = useMobileSession();
  const [lists, setLists] = useState<ReadonlyArray<MobilePullRequestList>>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  // Only the newest read lands, so a slow cached read cannot undo a refresh.
  const reads = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      const read = (reads.current += 1);
      if (refresh) setRefreshing(true);
      else setLoading(true);
      const next = await Promise.all(
        transports.map((transport) => listMobilePullRequests(transport, { refresh })),
      );
      if (read !== reads.current) return;
      setLists(next);
      setLoading(false);
      setRefreshing(false);
    },
    [transports],
  );
  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load]),
  );

  const label = useCallback(
    (hostId: string) =>
      hosts.find((host) => String(host.hostId) === hostId)?.label ?? hostId.slice(0, 8),
    [hosts],
  );
  const severalHosts = transports.length > 1;
  const pullRequests = useMemo<ReadonlyArray<MobilePullRequest>>(() => {
    const wanted = query.trim().toLowerCase();
    return lists.flatMap((list) =>
      list.status !== "ready"
        ? []
        : list.rows
            .filter(
              (row) =>
                wanted.length === 0 ||
                row.title.toLowerCase().includes(wanted) ||
                `${row.repositoryOwner}/${row.repositoryName}`.toLowerCase().includes(wanted) ||
                `#${row.number}`.includes(wanted),
            )
            .map((row) => ({ hostId: list.hostId, row })),
    );
  }, [lists, query]);
  const groups = useMemo(() => groupPullRequests(pullRequests), [pullRequests]);
  const notices = lists.flatMap((list) => {
    const prefix = severalHosts ? `${label(list.hostId)}: ` : "";
    if (list.status !== "ready") return [{ key: list.hostId, text: `${prefix}${list.message}` }];
    return [
      ...(list.freshness.status === "stale"
        ? [{ key: `${list.hostId}:stale`, text: `${prefix}${MOBILE_COPY.pullRequestsStale}` }]
        : []),
      ...(list.truncated
        ? [{ key: `${list.hostId}:more`, text: `${prefix}${MOBILE_COPY.pullRequestsTruncated}` }]
        : []),
    ];
  });

  const styles = useMemo(
    () => StyleSheet.create({ content: { paddingBottom: NEW_BUTTON_CLEARANCE, flexGrow: 1 } }),
    [],
  );
  const firstRead = loading && lists.length === 0;
  return (
    <View style={{ flex: 1 }} testID="mobile-pull-requests">
      <ScreenHeader
        place
        search={{ placeholder: MOBILE_COPY.searchPullRequests, onChangeText: setQuery }}
        title={MOBILE_SCREEN_TITLES.pullRequests}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            onRefresh={() => void load(true)}
            refreshing={refreshing}
            tintColor={colors.accent}
          />
        }
      >
        {notices.length === 0 ? null : (
          <ListSection testID="mobile-pr-notices">
            {notices.map((notice, index) => (
              <ListNote
                key={notice.key}
                last={index === notices.length - 1}
                text={notice.text}
                tone={colors.textSecondary}
              />
            ))}
          </ListSection>
        )}
        {firstRead ? <ActivityIndicator color={colors.accent} /> : null}
        {groups.map((group) => (
          <PullRequestGroup
            hostLabel={severalHosts ? label : undefined}
            key={group.id}
            label={group.label}
            onOpen={props.onOpen}
            pullRequests={group.pullRequests}
            testID={`mobile-pr-group-${group.id}`}
          />
        ))}
        {firstRead || groups.length > 0 ? null : (
          <EmptyPlace
            icon="git-pull-request-outline"
            text={
              transports.length === 0
                ? MOBILE_COPY.pullRequestsNoHosts
                : query.trim().length > 0
                  ? MOBILE_COPY.pullRequestsSearchNone
                  : MOBILE_COPY.pullRequestsNone
            }
          />
        )}
      </ScrollView>
    </View>
  );
}
