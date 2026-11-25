import { useCallback, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { MobileInboxRow } from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { space } from "../../design-system";
import type { CountedThreads } from "../navigation/routes";
import { ScreenHeader } from "../navigation/ScreenHeader";
import { inboxCountedRows } from "./inboxWorkPresentation";
import { EmptyPlace } from "../ui/EmptyPlace";
import type { MobileIconName } from "../ui/symbols";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadListNotices } from "./ThreadListNotices";
import { ThreadGroup } from "./ThreadGroup";

const COUNTED: Readonly<
  Record<
    CountedThreads,
    { readonly title: string; readonly empty: string; readonly icon: MobileIconName }
  >
> = {
  attention: {
    title: MOBILE_COPY.needsAttention,
    empty: MOBILE_COPY.countedNoneNeedsYou,
    icon: "file-tray-outline",
  },
  working: {
    title: MOBILE_COPY.working,
    empty: MOBILE_COPY.countedNoneWorking,
    icon: "play-outline",
  },
  review: {
    title: MOBILE_COPY.inReview,
    empty: MOBILE_COPY.countedNoneInReview,
    icon: "eye-outline",
  },
};

/** What one of Home's counts counted, thread for thread. */
export function CountedThreadsScreen(props: {
  readonly view: CountedThreads;
  readonly onOpenThread: (row: MobileInboxRow) => void;
}) {
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
        content: { paddingTop: space.sm, paddingBottom: space.xl, flexGrow: 1 },
      }),
    [],
  );
  return (
    <View style={{ flex: 1 }} testID="mobile-counted-threads">
      <ScreenHeader title={COUNTED[props.view].title} />
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        <ThreadListNotices />
        {counted.length > 0 ? (
          <ThreadGroup onOpen={props.onOpenThread} rows={counted} />
        ) : loading ? null : (
          <EmptyPlace icon={COUNTED[props.view].icon} text={COUNTED[props.view].empty} />
        )}
      </ScrollView>
    </View>
  );
}
