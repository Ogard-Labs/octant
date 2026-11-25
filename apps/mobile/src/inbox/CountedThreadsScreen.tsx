import { useCallback, useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { space, typography, useTheme } from "../../design-system";
import type { CountedThreads } from "../navigation/routes";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { ListSection } from "../ui/NativeChrome";
import { inboxCountedRows } from "./inboxWorkPresentation";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadListNotices } from "./ThreadListNotices";
import { ThreadRow } from "./ThreadRow";

const COUNTED: Readonly<
  Record<CountedThreads, { readonly title: string; readonly empty: string }>
> = {
  attention: { title: MOBILE_COPY.needsAttention, empty: MOBILE_COPY.countedNoneNeedsYou },
  working: { title: MOBILE_COPY.working, empty: MOBILE_COPY.countedNoneWorking },
  review: { title: MOBILE_COPY.inReview, empty: MOBILE_COPY.countedNoneInReview },
};

/** What one of Home's counts counted, thread for thread. */
export function CountedThreadsScreen(props: {
  readonly view: CountedThreads;
  readonly onOpenThread: (row: MobileInboxRow) => void;
}) {
  const { colors } = useTheme();
  const { rows, loading, refresh } = useMobileThreads();
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const counted = useMemo(() => inboxCountedRows(rows, props.view), [props.view, rows]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: { paddingTop: space.sm, paddingBottom: space.xl },
        empty: {
          color: colors.textSecondary,
          fontSize: typography.detail.fontSize,
          padding: space.md,
          textAlign: "center",
        },
      }),
    [colors],
  );
  return (
    <View style={{ flex: 1 }} testID="mobile-counted-threads">
      <ScreenHeader title={COUNTED[props.view].title} />
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <ThreadListNotices />
        {counted.length > 0 ? (
          <ListSection>
            {counted.map((row, index) => (
              <ThreadRow
                key={`${row.hostId}:${row.mode}:${row.threadId}`}
                last={index === counted.length - 1}
                onOpen={props.onOpenThread}
                row={row}
              />
            ))}
          </ListSection>
        ) : loading ? null : (
          <Text style={styles.empty}>{COUNTED[props.view].empty}</Text>
        )}
      </ScrollView>
    </View>
  );
}
