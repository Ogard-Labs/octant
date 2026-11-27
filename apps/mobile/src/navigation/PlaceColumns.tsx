import type { MobileInboxRow } from "@octant/client-runtime";
import {
  NavigationContainer,
  NavigationIndependentTree,
  useIsFocused,
  useTheme as useNavigationTheme,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { useMobileThreads } from "../inbox/MobileThreadsContext";
import { ThreadScreen } from "../inbox/ThreadScreen";
import { columnsChange, listColumnWidth, showsColumns } from "./columns";
import type { MobileStackParams } from "./routes";

type OpenThread = (row: MobileInboxRow, focusTurnId?: string) => void;

type Open = { readonly row: MobileInboxRow; readonly focusTurnId?: string | undefined };

// Each column is a stack of its own, so the list and the thread each keep the
// system bar their screens fill (`ScreenHeader` writes to its own stack's bar).
// A screen holds one navigator, so each column's stack is its own tree: two
// side by side under the place's screen threw "Another navigator is already
// registered for this container" as the place opened on the iPad Simulator.
const ListColumn = createNativeStackNavigator<{ readonly list: undefined }>();
const ThreadColumn = createNativeStackNavigator<{ readonly open: undefined }>();

// The thread column ends above the place bar, as a pushed thread does.
const THREAD_EDGES: ReadonlyArray<Edge> =
  Platform.OS === "android" ? ["right"] : ["right", "bottom"];

function rowKey(row: MobileInboxRow): string {
  return `${row.hostId}:${row.mode}:${row.threadId}`;
}

/**
 * A list place (Threads, Inbox) as one column on a phone, and as the list
 * beside the open thread where the window is wide enough
 * (`COLUMNS_MIN_WIDTH`). Crossing that width, as when a foldable is folded or
 * opened, keeps the person's place: the open thread moves onto the stack or
 * back into the column (`columnsChange`).
 */
export function PlaceColumns(props: {
  readonly navigation: NativeStackNavigationProp<MobileStackParams, "threadsRoot" | "inboxRoot">;
  readonly list: (openThread: OpenThread) => ReactNode;
}) {
  const { navigation } = props;
  const placeFocused = useIsFocused();
  const { width } = useWindowDimensions();
  const columns = showsColumns(width);
  const [open, setOpen] = useState<Open>();
  // Read when the width is crossed; opening a thread is not a crossing.
  const openNow = useRef(open);
  openNow.current = open;

  useEffect(() => {
    const pushed = navigation
      .getState()
      .routes.slice(1)
      .map((route) => ({
        name: route.name,
        ...(route.name === "thread"
          ? { row: (route.params as MobileStackParams["thread"]).row }
          : {}),
      }));
    const change = columnsChange({ columns, openInColumn: openNow.current?.row, pushed });
    if (change.kind === "push-thread") {
      const focusTurnId = openNow.current?.focusTurnId;
      setOpen(undefined);
      navigation.push("thread", { row: change.row, focusTurnId });
    } else if (change.kind === "take-thread") {
      setOpen({ row: change.row });
      navigation.popToTop();
    }
  }, [columns, navigation]);

  // The columns bring their own bars; the place's bar would sit over both.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !columns });
  }, [columns, navigation]);

  if (!columns) {
    return props.list((row, focusTurnId) => navigation.push("thread", { row, focusTurnId }));
  }
  const listWidth = listColumnWidth(width);
  return (
    <View style={styles.row} testID="mobile-place-columns">
      <View style={{ width: listWidth }}>
        <ColumnTree>
          <ListColumn.Navigator screenOptions={{ headerShadowVisible: false }}>
            <ListColumn.Screen name="list">
              {() => props.list((row, focusTurnId) => setOpen({ row, focusTurnId }))}
            </ListColumn.Screen>
          </ListColumn.Navigator>
        </ColumnTree>
      </View>
      <Divider />
      <View style={styles.fill}>
        <ColumnTree key={open === undefined ? "none" : rowKey(open.row)}>
          <ThreadColumn.Navigator
            screenOptions={{ headerShadowVisible: false, headerBackButtonDisplayMode: "minimal" }}
          >
            <ThreadColumn.Screen name="open" options={open === undefined ? { title: "" } : {}}>
              {() =>
                open === undefined ? (
                  <NothingOpen />
                ) : (
                  <SafeAreaView edges={[...THREAD_EDGES]} style={styles.fill}>
                    <OpenThreadColumn
                      onOpenThread={(row) => setOpen({ row })}
                      open={open}
                      placeFocused={placeFocused}
                    />
                  </SafeAreaView>
                )
              }
            </ThreadColumn.Screen>
          </ThreadColumn.Navigator>
        </ColumnTree>
      </View>
    </View>
  );
}

/** A column's own navigation tree, drawn in the app's navigation theme. */
function ColumnTree(props: { readonly children: ReactNode }) {
  const theme = useNavigationTheme();
  return (
    <NavigationIndependentTree>
      <NavigationContainer theme={theme}>{props.children}</NavigationContainer>
    </NavigationIndependentTree>
  );
}

function OpenThreadColumn(props: {
  readonly open: Open;
  readonly onOpenThread: (row: MobileInboxRow) => void;
  /** Whether the place is on screen; the column's own tree is always focused. */
  readonly placeFocused: boolean;
}) {
  const { reading } = useMobileThreads();
  const { row, focusTurnId } = props.open;
  const { placeFocused } = props;
  // Read while it is on screen, as a pushed thread is.
  useEffect(() => {
    if (!placeFocused) return;
    reading(row);
    return () => reading(undefined);
  }, [placeFocused, reading, row]);
  return (
    <ThreadScreen
      focusTurnId={focusTurnId}
      key={rowKey(row)}
      onOpenThread={props.onOpenThread}
      selected={row}
    />
  );
}

function Divider() {
  const { colors } = useTheme();
  return <View style={[styles.divider, { backgroundColor: colors.hairline }]} />;
}

function NothingOpen() {
  const { colors } = useTheme();
  return (
    <View style={styles.empty} testID="mobile-place-columns-empty">
      <Text style={[typography.body, { color: colors.textSecondary, textAlign: "center" }]}>
        {MOBILE_COPY.columnsNothingOpen}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  fill: { flex: 1 },
  divider: { width: StyleSheet.hairlineWidth },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
});
