import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import {
  createNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  StackActions,
  type ParamListBase,
  useFocusEffect,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from "@react-navigation/native-stack";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import type { MobileInboxRow } from "@octant/client-runtime";
import type { Todo } from "@octant/contracts/todos";
import { ScreenCanvas, space, typography, useTheme } from "../../design-system";
import { useAppearance } from "../appearance/AppearanceContext";
import { HostsScreen } from "../hosts/HostsScreen";
import { CountedThreadsScreen } from "../inbox/CountedThreadsScreen";
import { HomeScreen } from "../inbox/HomeScreen";
import { InboxScreen } from "../inbox/InboxScreen";
import { MobileThreadsProvider, useMobileThreads } from "../inbox/MobileThreadsContext";
import { NewThreadProvider, useNewThread } from "../inbox/NewThreadContext";
import type { MobileThreadArrangement } from "../inbox/threadArrangement";
import type { MobileThreadFilter } from "../inbox/threadFilters";
import { ThreadScreen } from "../inbox/ThreadScreen";
import { ThreadsScreen } from "../inbox/ThreadsScreen";
import type { MobileComputersDeepLinkTarget } from "../notifications/deepLinks";
import { mobileNotificationPort } from "../notifications/mobileNotificationPort";
import { mobilePushRegistrationBook } from "../notifications/mobilePushRegistrationBook";
import { usePhoneNotificationRotation } from "../notifications/usePhoneNotificationRotation";
import { useMobileSession } from "../session/MobileSessionContext";
import { TodosScreen } from "../todos/TodosScreen";
import { hasLiquidGlass } from "../ui/systemVersion";
import {
  mobileTodoDraftAfterHostChange,
  type MobileStartedThread,
  type MobileTodoQuickAddDraft,
} from "../todos/todosPresentation";
import { computersLinkOpening, deepLinkRefusal } from "./deepLinkNavigation";
import { createPlaceTabNavigator } from "./PlaceTabNavigator";
import { shippedMobilePlaces, type MobilePlaceId } from "./places";
import type { MobileStackParams } from "./routes";

export interface RootNavigatorProps {
  readonly pendingDeepLinkRow?: MobileInboxRow | undefined;
  /** A tapped notification that a move waits for this phone. */
  readonly pendingComputersLink?: MobileComputersDeepLinkTarget | undefined;
  readonly onDeepLinkConsumed?: (() => void) | undefined;
}

const Places = createPlaceTabNavigator();
const Stack = createNativeStackNavigator<MobileStackParams>();

/** What several screens share and no one of them owns. */
interface Shell {
  readonly arrangement: MobileThreadArrangement;
  readonly setArrangement: (arrangement: MobileThreadArrangement) => void;
  readonly mode: MobileThreadFilter["mode"];
  readonly setMode: (mode: MobileThreadFilter["mode"]) => void;
  readonly todoDraft: MobileTodoQuickAddDraft;
  readonly changeTodoDraft: (text: string) => void;
  readonly completeTodoDraft: (
    draftId: string,
    submittedText: string,
    hostId: string | undefined,
  ) => void;
  readonly recordTodoLink: (todoId: string, thread: MobileStartedThread, linked: boolean) => void;
  readonly startTodo: (todo: Todo) => void;
  readonly unlinkedTodoStarts: ReadonlyMap<string, MobileStartedThread>;
}

const ShellContext = createContext<Shell | undefined>(undefined);

function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (shell === undefined) throw new Error("Screens render inside the phone's shell.");
  return shell;
}

type ScreenProps<Name extends keyof MobileStackParams> = NativeStackScreenProps<
  MobileStackParams,
  Name
>;

function HomeRoute({ navigation }: ScreenProps<"homeRoot">) {
  const { setInboxHostFilter } = useMobileSession();
  const openPlace = (place: MobilePlaceId) => navigation.getParent()?.navigate(place);
  return (
    <HomeScreen
      onAddWorkspace={() => navigation.push("pair", { entryMode: "add" })}
      onOpenCounted={(view) => navigation.push("counted", { view })}
      onOpenSettings={() => navigation.push("settings", {})}
      onOpenThread={(row) => navigation.push("thread", { row })}
      onOpenThreads={() => {
        setInboxHostFilter("all");
        openPlace("threads");
      }}
      onOpenTodos={() => navigation.push("todos")}
      onOpenWorkspace={(hostId) => {
        setInboxHostFilter(hostId);
        openPlace("threads");
      }}
      onScanToPair={() => navigation.push("pair", { entryMode: "scan" })}
    />
  );
}

function ThreadsRoute({ navigation }: ScreenProps<"threadsRoot">) {
  const shell = useShell();
  return (
    <ThreadsScreen
      arrangement={shell.arrangement}
      mode={shell.mode}
      onOpenThread={(row, focusTurnId) => navigation.push("thread", { row, focusTurnId })}
      onSelectArrangement={shell.setArrangement}
      onSelectMode={shell.setMode}
    />
  );
}

function InboxRoute({ navigation }: ScreenProps<"inboxRoot">) {
  return <InboxScreen onOpenThread={(row) => navigation.push("thread", { row })} />;
}

function CountedRoute({ navigation, route }: ScreenProps<"counted">) {
  return (
    <CountedThreadsScreen
      onOpenThread={(row) => navigation.push("thread", { row })}
      view={route.params.view}
    />
  );
}

function ThreadRoute({ navigation, route }: ScreenProps<"thread">) {
  const { reading } = useMobileThreads();
  const { row } = route.params;
  useFocusEffect(
    useCallback(() => {
      reading(row);
      return () => reading(undefined);
    }, [reading, row]),
  );
  return (
    <ThreadScreen
      focusTurnId={route.params.focusTurnId}
      onOpenThread={(row) => navigation.replace("thread", { row })}
      selected={route.params.row}
    />
  );
}

function SettingsRoute({ navigation, route }: ScreenProps<"settings">) {
  return (
    <HostsScreen
      entryMode="manage"
      newDevicesRefreshKey={route.params.linkOpened ?? 0}
      notice={route.params.notice}
      onPaired={() => navigation.popToTop()}
    />
  );
}

function PairRoute({ navigation, route }: ScreenProps<"pair">) {
  return (
    <HostsScreen
      entryMode={route.params.entryMode}
      newDevicesRefreshKey={0}
      onPaired={() => navigation.popToTop()}
    />
  );
}

function TodosRoute() {
  const shell = useShell();
  return (
    <TodosScreen
      draft={shell.todoDraft}
      onDraftChange={shell.changeTodoDraft}
      onDraftSubmitted={shell.completeTodoDraft}
      onLinked={shell.recordTodoLink}
      onStart={shell.startTodo}
      unlinked={shell.unlinkedTodoStarts}
    />
  );
}

// A root's list runs under the bar; a pushed screen ends above it. Android lays
// the place out above its bar, so there is nothing left to keep clear of.
const ROOT_EDGES: ReadonlyArray<Edge> = ["left", "right"];
const PUSHED_EDGES: ReadonlyArray<Edge> =
  Platform.OS === "android" ? ["left", "right"] : ["left", "right", "bottom"];

function PlaceStack(props: { readonly place: "home" | "threads" | "inbox" }) {
  const appearance = useAppearance();
  const { colors } = useTheme();
  return (
    <Stack.Navigator
      initialRouteName={`${props.place}Root`}
      screenLayout={({ children, route }) => (
        <ScreenCanvas
          customImageUri={appearance.preferences.customImageUri}
          effect={appearance.preferences.effect}
          picture={appearance.preferences.picture}
        >
          <SafeAreaView
            edges={[...(route.name === `${props.place}Root` ? ROOT_EDGES : PUSHED_EDGES)]}
            style={styles.fill}
          >
            {children}
          </SafeAreaView>
        </ScreenCanvas>
      )}
      screenOptions={{
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.textPrimary },
        headerLargeTitleStyle: { color: colors.textPrimary },
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
      }}
    >
      {props.place === "home" ? (
        <Stack.Screen component={HomeRoute} name="homeRoot" options={PLACE_OPTIONS} />
      ) : props.place === "threads" ? (
        <Stack.Screen component={ThreadsRoute} name="threadsRoot" options={PLACE_OPTIONS} />
      ) : (
        <Stack.Screen component={InboxRoute} name="inboxRoot" options={PLACE_OPTIONS} />
      )}
      <Stack.Screen component={CountedRoute} name="counted" />
      <Stack.Screen component={ThreadRoute} name="thread" />
      <Stack.Screen component={SettingsRoute} name="settings" options={ROOT_OPTIONS} />
      <Stack.Screen component={PairRoute} name="pair" />
      <Stack.Screen component={TodosRoute} name="todos" />
    </Stack.Navigator>
  );
}

const ROOT_OPTIONS = { headerLargeTitleEnabled: true } as const;
// On Liquid Glass a place's name is in the bar (ScreenHeader). Older systems
// keep the large title.
const PLACE_OPTIONS = hasLiquidGlass() ? {} : ROOT_OPTIONS;
const HomeStack = () => <PlaceStack place="home" />;
const ThreadsStack = () => <PlaceStack place="threads" />;
const InboxStack = () => <PlaceStack place="inbox" />;
const STACKS: Readonly<Partial<Record<MobilePlaceId, () => JSX.Element>>> = {
  home: HomeStack,
  threads: ThreadsStack,
  inbox: InboxStack,
};

const styles = StyleSheet.create({ fill: { flex: 1 } });

function PlacesShell() {
  const { openNewThread, accessReason } = useNewThread();
  const { hosts } = useMobileSession();
  return (
    <Places.Navigator
      backBehavior="firstRoute"
      newDisabled={accessReason !== undefined || hosts.length === 0}
      onNew={openNewThread}
    >
      {shippedMobilePlaces().map((place) => {
        const stack = STACKS[place.id];
        return stack === undefined ? null : (
          <Places.Screen component={stack} key={place.id} name={place.id} />
        );
      })}
    </Places.Navigator>
  );
}

function LinkNotice(props: { readonly text: string; readonly onDismiss: () => void }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        backgroundColor: colors.surfaceElevated,
      }}
      testID="mobile-link-notice"
    >
      <Text style={{ flex: 1, color: colors.textPrimary, fontSize: typography.detail.fontSize }}>
        {props.text}
      </Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={10}
        onPress={props.onDismiss}
        testID="mobile-link-notice-dismiss"
      >
        <Text style={{ color: colors.accent, fontSize: typography.detail.fontSize }}>OK</Text>
      </Pressable>
    </View>
  );
}

export function RootNavigator(props: RootNavigatorProps) {
  const { colors, scheme } = useTheme();
  const [navigation] = useState(() => createNavigationContainerRef<ParamListBase>());
  const [ready, setReady] = useState(false);
  const [linkNotice, setLinkNotice] = useState<string | undefined>();
  const linksOpened = useRef(0);
  const [arrangement, setArrangement] = useState<MobileThreadArrangement>("status");
  const [mode, setMode] = useState<MobileThreadFilter["mode"]>("all");
  // A Start pressed on To-dos, waiting for the new-thread sheet to take it.
  const [todoStart, setTodoStart] = useState<Todo | undefined>();
  const [todoDraft, setTodoDraft] = useState<MobileTodoQuickAddDraft>(() => ({
    id: globalThis.crypto.randomUUID(),
    text: "",
  }));
  // Threads a Start made that the list did not take, by to-do id. They stay on
  // the phone until the person links them again; the threads are unaffected.
  const [unlinkedTodoStarts, setUnlinkedTodoStarts] = useState<
    ReadonlyMap<string, MobileStartedThread>
  >(new Map());
  const recordTodoLink = useCallback(
    (todoId: string, thread: MobileStartedThread, linked: boolean) =>
      setUnlinkedTodoStarts((current) => {
        const next = new Map(current);
        if (linked) next.delete(todoId);
        else next.set(todoId, thread);
        return next;
      }),
    [],
  );
  const {
    environment,
    inboxHostFilter,
    hosts,
    hostsLoaded,
    hostsError,
    transport,
    transportForHost,
    transports,
  } = useMobileSession();
  const previousTodoHostId = useRef(transport?.hostId);
  const previousTodoHostIdValue = previousTodoHostId.current;
  const todoHostId =
    inboxHostFilter === "all"
      ? (transport?.hostId ??
        (previousTodoHostIdValue !== undefined &&
        hosts.some((host) => String(host.hostId) === previousTodoHostIdValue)
          ? previousTodoHostIdValue
          : undefined))
      : inboxHostFilter;
  const currentTodoHostId = useRef(todoHostId);
  currentTodoHostId.current = todoHostId;
  useEffect(() => {
    if (previousTodoHostId.current !== todoHostId) {
      previousTodoHostId.current = todoHostId;
      setTodoDraft((draft) =>
        mobileTodoDraftAfterHostChange(draft, globalThis.crypto.randomUUID()),
      );
    }
  }, [todoHostId]);
  const changeTodoDraft = useCallback((text: string) => {
    setTodoDraft((draft) =>
      draft.text === text ? draft : { id: globalThis.crypto.randomUUID(), text },
    );
  }, []);
  const completeTodoDraft = useCallback(
    (draftId: string, submittedText: string, hostId: string | undefined) => {
      setTodoDraft((draft) => {
        if (currentTodoHostId.current !== hostId || draft.id !== draftId) {
          return draft;
        }
        return {
          id: globalThis.crypto.randomUUID(),
          text: draft.text === submittedText ? "" : draft.text,
        };
      });
    },
    [],
  );
  usePhoneNotificationRotation({
    enabled: environment.kind === "live",
    book: mobilePushRegistrationBook(),
    permission: mobileNotificationPort,
    transportForHost,
    transports,
  });

  const { pendingDeepLinkRow, pendingComputersLink, onDeepLinkConsumed } = props;
  useEffect(() => {
    // On a cold open the paired list is still being read; deciding now would
    // call every computer unpaired.
    if (pendingDeepLinkRow === undefined || !hostsLoaded || !ready) return;
    const refusal = deepLinkRefusal(
      pendingDeepLinkRow,
      hosts.map((host) => host.hostId),
      hostsError !== undefined,
    );
    // A refused link leaves the person where they were, with the reason.
    setLinkNotice(refusal);
    if (refusal === undefined) {
      // Under its own list, so Back leads there from wherever the link came.
      navigation.navigate("threads", {
        state: {
          routes: [
            { name: "threadsRoot" },
            { name: "thread", params: { row: pendingDeepLinkRow } },
          ],
        },
      });
    }
    onDeepLinkConsumed?.();
  }, [hosts, hostsError, hostsLoaded, navigation, onDeepLinkConsumed, pendingDeepLinkRow, ready]);

  useEffect(() => {
    // As for a thread link, the paired list must be read before a computer
    // can be called unpaired.
    if (pendingComputersLink === undefined || !hostsLoaded || !ready) return;
    const opening = computersLinkOpening(
      pendingComputersLink,
      hosts.map((host) => host.hostId),
      hostsError !== undefined,
    );
    linksOpened.current += 1;
    navigation.navigate("home", {
      state: {
        routes: [
          { name: "homeRoot" },
          {
            name: "settings",
            params: { notice: opening.notice, linkOpened: linksOpened.current },
          },
        ],
      },
    });
    onDeepLinkConsumed?.();
  }, [hosts, hostsError, hostsLoaded, navigation, onDeepLinkConsumed, pendingComputersLink, ready]);

  const shell = useMemo<Shell>(
    () => ({
      arrangement,
      setArrangement,
      mode,
      setMode,
      todoDraft,
      changeTodoDraft,
      completeTodoDraft,
      recordTodoLink,
      startTodo: setTodoStart,
      unlinkedTodoStarts,
    }),
    [
      arrangement,
      changeTodoDraft,
      completeTodoDraft,
      mode,
      recordTodoLink,
      todoDraft,
      unlinkedTodoStarts,
    ],
  );
  const theme = useMemo(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.accent,
        background: colors.canvas,
        // The bar is the page's own colour, so nothing shows through a title.
        card: colors.canvas,
        text: colors.textPrimary,
      },
    };
  }, [colors, scheme]);

  return (
    <View style={styles.fill} testID="octant-mobile-shell">
      {linkNotice === undefined ? null : (
        <SafeAreaView edges={environment.kind === "mock" ? [] : ["top"]}>
          <LinkNotice onDismiss={() => setLinkNotice(undefined)} text={linkNotice} />
        </SafeAreaView>
      )}
      <ShellContext.Provider value={shell}>
        <MobileThreadsProvider>
          <NewThreadProvider
            onOpenThread={(row) => navigation.dispatch(StackActions.push("thread", { row }))}
            onTodoLinked={recordTodoLink}
            onTodoStartOpened={() => setTodoStart(undefined)}
            todoStart={todoStart}
          >
            <NavigationContainer onReady={() => setReady(true)} ref={navigation} theme={theme}>
              <PlacesShell />
            </NavigationContainer>
          </NewThreadProvider>
        </MobileThreadsProvider>
      </ShellContext.Provider>
    </View>
  );
}
