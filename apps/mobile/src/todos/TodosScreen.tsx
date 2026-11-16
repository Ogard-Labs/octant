import { changeMobileTodos, readMobileTodos } from "@octant/client-runtime/mobile-todo-client";
import type { Todo, TodoCommand, TodoListView } from "@octant/contracts/todos";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { BottomSheet } from "../ui/BottomSheet";
import { ListRow, ListSection, NavBar } from "../ui/NativeChrome";
import {
  mobileQuickAdd,
  mobileTickCommand,
  mobileTodoDetail,
  mobileTodoLinkCommand,
  mobileTodoSections,
  type MobileStartedThread,
} from "./todosPresentation";

/** The host's change feed does not reach the phone; it reads while in front. */
const REREAD_MS = 30_000;

export interface TodosScreenProps {
  readonly onBack: () => void;
  /** Opens the new-thread sheet with the to-do in it; nothing starts until the person sends. */
  readonly onStart: (todo: Todo) => void;
  /** Threads a Start made that the list did not take, by to-do id. */
  readonly unlinked: ReadonlyMap<string, MobileStartedThread>;
  readonly onLinked: (todoId: string, thread: MobileStartedThread, linked: boolean) => void;
}

/**
 * The person's to-do list on the computer this phone is connected to: the open
 * ones, then those ticked off, with one line to add another. The computer
 * decides every change; a refusal (a list kept on another computer, a device
 * it does not let change the list) is shown as it said it.
 */
export function TodosScreen(props: TodosScreenProps) {
  const { colors } = useTheme();
  const { transport, hosts } = useMobileSession();
  const [view, setView] = useState<TodoListView>();
  const [problem, setProblem] = useState<string>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionTodo, setActionTodo] = useState<Todo>();
  // One id per draft, kept across failed sends so a resent add lands once.
  const draftId = useRef(globalThis.crypto.randomUUID());
  // Every answer is checked against the newest request made to the computer
  // in front: a slower read, or any reply from a computer the phone has since
  // left, is dropped rather than drawn under the new computer's name.
  const generation = useRef(0);
  const reads = useRef(0);
  const sending = useRef(false);
  const transportId = transport?.hostId;
  const hostName = hosts.find((host) => host.hostId === transportId)?.label;

  const failureText = (reason: "unreachable" | "invalid" | "signed-out", unsaved: boolean) =>
    reason === "signed-out"
      ? MOBILE_COPY.todosSignedOut
      : unsaved
        ? MOBILE_COPY.todosUnsaved
        : MOBILE_COPY.todosUnreachable;

  // A reconnect to the same computer hands a new transport object; the list,
  // the draft and its id belong to the computer, so only a new computer resets
  // them. Requests always go through the newest transport.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const load = useCallback(async () => {
    const transport = transportRef.current;
    if (transport === undefined) return;
    const shownFor = generation.current;
    const ticket = ++reads.current;
    const result = await readMobileTodos(transport);
    if (shownFor !== generation.current || ticket !== reads.current) return;
    if (result.status === "loaded") {
      setView(result.view);
      setProblem(undefined);
    } else {
      setProblem(
        result.status === "refused" ? result.refusal.message : failureText(result.reason, false),
      );
    }
  }, []);

  useEffect(() => {
    // Another computer is another list: nothing of the last one carries over.
    generation.current += 1;
    setView(undefined);
    setProblem(undefined);
    setText("");
    setBusy(false);
    setActionTodo(undefined);
    sending.current = false;
    draftId.current = globalThis.crypto.randomUUID();
    void load();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void load();
    }, REREAD_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [load, transportId]);

  const send = async (command: TodoCommand): Promise<boolean> => {
    // A ref, not the busy state: two taps in one tick both saw busy as false.
    if (transport === undefined || sending.current) return false;
    sending.current = true;
    setBusy(true);
    const shownFor = generation.current;
    // A read already in flight began before this change; its answer is older.
    reads.current += 1;
    const result = await changeMobileTodos(transport, command);
    // A read that started while this change was in flight may have seen the
    // list before it; its answer is older than this one.
    reads.current += 1;
    // The computer changed meanwhile, and its reset already cleared the send.
    if (shownFor !== generation.current) return false;
    sending.current = false;
    setBusy(false);
    if (result.status === "loaded") {
      setView(result.view);
      setProblem(undefined);
      return true;
    }
    setProblem(
      result.status === "refused" ? result.refusal.message : failureText(result.reason, true),
    );
    return false;
  };

  const add = async () => {
    if (sending.current) return;
    const draft = mobileQuickAdd(text, draftId.current);
    if (draft.status === "empty") return;
    if (draft.status === "too-long") {
      setProblem(MOBILE_COPY.todosTooLong);
      return;
    }
    const submitted = text;
    if (await send(draft.command)) {
      // Text typed while the add was in flight is the next to-do; keep it.
      setText((current) => (current === submitted ? "" : current));
      draftId.current = globalThis.crypto.randomUUID();
    }
  };

  const styles = useMemo(
    () =>
      StyleSheet.create({
        shell: { flex: 1, backgroundColor: "transparent" },
        body: { paddingBottom: mobileSpacing.xl },
        add: {
          marginHorizontal: mobileSpacing.md,
          marginBottom: mobileSpacing.md,
          height: 44,
          paddingHorizontal: 12,
          borderRadius: 10,
          backgroundColor: colors.control,
          color: colors.textPrimary,
          fontSize: 17,
        },
        actions: { paddingBottom: mobileSpacing.lg },
        note: {
          ...mobileTypography.detail,
          color: colors.textSecondary,
          marginHorizontal: mobileSpacing.md,
          marginBottom: mobileSpacing.md,
        },
      }),
    [colors],
  );

  const link = async (todo: Todo, thread: MobileStartedThread) => {
    if (await send(mobileTodoLinkCommand(String(todo.id), thread))) {
      props.onLinked(String(todo.id), thread, true);
      setActionTodo(undefined);
    }
  };

  const sections = mobileTodoSections(view?.todos ?? []);
  const actionUnlinked =
    actionTodo === undefined ? undefined : props.unlinked.get(String(actionTodo.id));
  const row = (todo: Todo, last: boolean) => (
    <ListRow
      accessibilityLabel={
        todo.state === "done" ? `Open ${todo.title} again` : `Tick off ${todo.title}`
      }
      detail={mobileTodoDetail(todo, { unlinked: props.unlinked.has(String(todo.id)) })}
      icon={todo.state === "done" ? "checkmark-circle" : "ellipse-outline"}
      iconTone={todo.state === "done" ? colors.success : colors.textTertiary}
      key={String(todo.id)}
      label={todo.title}
      labelTone={todo.state === "done" ? colors.textSecondary : undefined}
      last={last}
      onPress={busy ? undefined : () => void send(mobileTickCommand(todo))}
      {...(todo.state === "open"
        ? { onLongPress: () => setActionTodo(todo), longPressLabel: MOBILE_COPY.todosActions }
        : {})}
      testID={`mobile-todo-${String(todo.id)}`}
    />
  );

  return (
    <View style={styles.shell} testID="mobile-todos">
      <NavBar
        backLabel={MOBILE_COPY.inboxTitle}
        backTestID="mobile-todos-back"
        onBack={props.onBack}
        subtitle={hostName}
        title={MOBILE_COPY.todosTitle}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <TextInput
          accessibilityLabel={MOBILE_COPY.todosNew}
          editable={transport !== undefined}
          onChangeText={(next) => {
            setText(next);
            setProblem(undefined);
          }}
          onSubmitEditing={() => void add()}
          placeholder={MOBILE_COPY.todosNew}
          placeholderTextColor={colors.textTertiary}
          returnKeyType="done"
          style={styles.add}
          testID="mobile-todos-add"
          value={text}
        />
        {problem === undefined ? null : (
          <Text accessibilityRole="alert" style={styles.note}>
            {problem}
          </Text>
        )}
        {transport === undefined ? (
          <Text style={styles.note}>{MOBILE_COPY.todosNoComputer}</Text>
        ) : view === undefined ? (
          problem === undefined ? (
            <Text style={styles.note}>{MOBILE_COPY.todosLoading}</Text>
          ) : null
        ) : sections.open.length + sections.done.length === 0 ? (
          <Text style={styles.note}>{MOBILE_COPY.todosEmpty}</Text>
        ) : (
          <>
            {sections.open.length === 0 ? null : (
              <ListSection testID="mobile-todos-open" title={MOBILE_COPY.todosOpen}>
                {sections.open.map((todo, index) => row(todo, index === sections.open.length - 1))}
              </ListSection>
            )}
            {sections.done.length === 0 ? null : (
              <ListSection testID="mobile-todos-done" title={MOBILE_COPY.todosDone}>
                {sections.done.map((todo, index) => row(todo, index === sections.done.length - 1))}
              </ListSection>
            )}
          </>
        )}
      </ScrollView>
      <BottomSheet
        onClose={() => setActionTodo(undefined)}
        testID="mobile-todo-actions"
        title={actionTodo === undefined ? "" : formatScreenshotSafeLabel(actionTodo.title)}
        visible={actionTodo !== undefined}
      >
        <View style={styles.actions}>
          {problem === undefined ? null : <Text style={styles.note}>{problem}</Text>}
          <ListSection>
            <ListRow
              icon="play-outline"
              label={MOBILE_COPY.todosStart}
              last={actionUnlinked === undefined}
              onPress={
                actionTodo === undefined
                  ? undefined
                  : () => {
                      const todo = actionTodo;
                      setActionTodo(undefined);
                      props.onStart(todo);
                    }
              }
              testID="mobile-todo-action-start"
            />
            {actionUnlinked === undefined || actionTodo === undefined ? null : (
              <ListRow
                detail={MOBILE_COPY.todosNotLinked}
                icon="link-outline"
                label={MOBILE_COPY.todosLink}
                last
                onPress={busy ? undefined : () => void link(actionTodo, actionUnlinked)}
                testID="mobile-todo-action-link"
              />
            )}
          </ListSection>
        </View>
      </BottomSheet>
    </View>
  );
}
