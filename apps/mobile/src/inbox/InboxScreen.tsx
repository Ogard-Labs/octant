import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES } from "../copy";
import { space, typography, useTheme } from "../../design-system";
import { NEW_BUTTON_CLEARANCE } from "../navigation/places";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { useMobileSession } from "../session/MobileSessionContext";
import { ListSection, SegmentedControl } from "../ui/NativeChrome";
import { inboxFilterCounts, MOBILE_INBOX_FILTERS, rowsForInboxFilter } from "./inboxFilters";
import type { MobileInboxFilter } from "./inboxFilters";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadListNotices } from "./ThreadListNotices";
import { ThreadRow } from "./ThreadRow";

/** What waits on the person, from every paired computer. */
export function InboxScreen(props: { readonly onOpenThread: (row: MobileInboxRow) => void }) {
  const { colors } = useTheme();
  const { transports } = useMobileSession();
  const { rows, loading, refresh } = useMobileThreads();
  const [filter, setFilter] = useState<MobileInboxFilter>("all");
  const [query, setQuery] = useState("");
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const counts = useMemo(() => inboxFilterCounts(rows), [rows]);
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return rowsForInboxFilter(rows, filter).filter(
      (row) => wanted.length === 0 || row.title.toLowerCase().includes(wanted),
    );
  }, [filter, query, rows]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: { paddingBottom: NEW_BUTTON_CLEARANCE, flexGrow: 1 },
        filters: { paddingHorizontal: space.md, paddingBottom: space.md },
        empty: {
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          lineHeight: 18,
          padding: space.md,
          textAlign: "center",
        },
      }),
    [colors],
  );
  const empty =
    transports.length === 0
      ? MOBILE_COPY.inboxEmpty
      : MOBILE_INBOX_FILTERS.find((option) => option.id === filter)?.empty;
  return (
    <View style={{ flex: 1 }} testID="mobile-inbox">
      <ScreenHeader
        search={{ placeholder: MOBILE_COPY.searchInbox, onChangeText: setQuery }}
        title={MOBILE_SCREEN_TITLES.inbox}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
      >
        <ThreadListNotices />
        <View style={styles.filters}>
          <SegmentedControl
            onSelect={setFilter}
            optionTestID={(id) => `mobile-inbox-filter-${id}`}
            options={MOBILE_INBOX_FILTERS.map((option) => ({
              id: option.id,
              label: counts[option.id] > 0 ? `${option.label} ${counts[option.id]}` : option.label,
            }))}
            selected={filter}
            testID="mobile-inbox-filters"
          />
        </View>
        {loading && rows.length === 0 ? <ActivityIndicator color={colors.accent} /> : null}
        {shown.length > 0 ? (
          <ListSection title={MOBILE_COPY.needsAttention}>
            {shown.map((row, index) => (
              <ThreadRow
                key={`${row.hostId}:${row.mode}:${row.threadId}`}
                last={index === shown.length - 1}
                onOpen={props.onOpenThread}
                row={row}
              />
            ))}
          </ListSection>
        ) : loading && rows.length === 0 ? null : (
          <Text style={styles.empty}>
            {query.trim().length > 0 ? MOBILE_COPY.searchNone : empty}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
