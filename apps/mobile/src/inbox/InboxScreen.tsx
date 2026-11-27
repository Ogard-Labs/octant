import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { MOBILE_COPY, MOBILE_SCREEN_TITLES } from "../copy";
import { useTheme } from "../../design-system";
import { NEW_BUTTON_CLEARANCE } from "../navigation/places";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { useMobileSession } from "../session/MobileSessionContext";
import { FilterChips } from "../ui/FilterChips";
import { inboxFilterCounts, MOBILE_INBOX_FILTERS, rowsForInboxFilter } from "./inboxFilters";
import type { MobileInboxFilter } from "./inboxFilters";
import { EmptyPlace } from "../ui/EmptyPlace";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadListNotices } from "./ThreadListNotices";
import { ThreadGroup } from "./ThreadGroup";

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
      }),
    [],
  );
  const empty =
    transports.length === 0
      ? MOBILE_COPY.inboxEmpty
      : (MOBILE_INBOX_FILTERS.find((option) => option.id === filter)?.empty ?? "");
  return (
    <View style={{ flex: 1 }} testID="mobile-inbox">
      <ScreenHeader
        search={{ placeholder: MOBILE_COPY.searchInbox, onChangeText: setQuery }}
        place
        title={MOBILE_SCREEN_TITLES.inbox}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
      >
        <ThreadListNotices />
        <FilterChips
          onSelect={setFilter}
          options={MOBILE_INBOX_FILTERS.map((option) => ({
            id: option.id,
            label: option.label,
            count: counts[option.id],
          }))}
          selected={filter}
          testID="mobile-inbox-filter"
        />
        {loading && rows.length === 0 ? <ActivityIndicator color={colors.accent} /> : null}
        {shown.length > 0 ? (
          <ThreadGroup
            label={MOBILE_COPY.needsAttention}
            onOpen={props.onOpenThread}
            rows={shown}
          />
        ) : loading && rows.length === 0 ? null : (
          <EmptyPlace
            icon="file-tray-outline"
            text={query.trim().length > 0 ? MOBILE_COPY.searchNone : empty}
          />
        )}
      </ScrollView>
    </View>
  );
}
