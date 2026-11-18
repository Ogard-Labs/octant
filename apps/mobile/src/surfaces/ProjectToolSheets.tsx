import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  sendMobileProjectBrowser,
  sendMobileProjectTerminal,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import {
  decodeCodeTerminalId,
  decodeProjectId,
  type CodeTerminalId,
  type ProjectBrowserView,
  type ProjectTerminalView,
} from "@octant/contracts";
import { useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { BottomSheet } from "../ui/BottomSheet";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import {
  appendTerminalOutput,
  projectPageAddress,
  terminalPlainText,
} from "./projectToolsPresentation";

/**
 * A phone keyboard's line of text, not a screen: the shell is sized for the
 * lines it prints to wrap on a phone rather than be cut.
 */
const PHONE_TERMINAL_COLUMNS = 60;
const PHONE_TERMINAL_ROWS = 30;
const CONTROL_C = "\u0003";

export interface ProjectTerminalSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly transport: MobileRemoteTransport;
  readonly projectId: string;
  readonly pollIntervalMs?: number;
}

type TerminalState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "open";
      readonly terminalId: CodeTerminalId;
      readonly view: ProjectTerminalView;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * The device's own shell in this Project's folder, as the paired browser's
 * Project tools open it: plain lines of output read from the host, a line to
 * run, and Control-C. The host decides the folder, the posture and that the
 * shell is this device's alone; it ends when the sheet closes, or when this
 * phone is revoked or goes quiet.
 */
export function ProjectTerminalSheet(props: ProjectTerminalSheetProps) {
  const { colors } = useTheme();
  const [state, setState] = useState<TerminalState>({ kind: "idle" });
  const [output, setOutput] = useState("");
  const [line, setLine] = useState("");
  const [note, setNote] = useState<string>();
  const scrollRef = useRef<ScrollView>(null);
  // Which open of the sheet a start belongs to: a shell that finishes starting
  // after the sheet closed is stopped, not adopted.
  const generation = useRef(0);
  const running = useRef<CodeTerminalId | undefined>(undefined);
  const offset = useRef(0);
  const { transport, projectId, visible } = props;

  useEffect(() => {
    if (!visible) return;
    const startedFor = ++generation.current;
    const project = decodeProjectId(projectId);
    const terminalId = decodeCodeTerminalId(globalThis.crypto.randomUUID());
    const stop = () =>
      void sendMobileProjectTerminal(transport, {
        kind: "stop",
        projectId: project,
        terminalId,
      }).catch(() => undefined);
    setOutput("");
    setNote(undefined);
    offset.current = 0;
    setState({ kind: "starting" });
    void (async () => {
      try {
        const started = await sendMobileProjectTerminal(transport, {
          kind: "start",
          projectId: project,
          terminalId,
          columns: PHONE_TERMINAL_COLUMNS,
          rows: PHONE_TERMINAL_ROWS,
        });
        if (startedFor !== generation.current) {
          stop();
          return;
        }
        if (started.kind === "project-terminal-refused") {
          setState({ kind: "refused", message: started.message });
          return;
        }
        if (started.kind !== "project-terminal" || started.terminal.state !== "running") {
          setState({ kind: "refused", message: MOBILE_COPY.projectTerminalDidNotStart });
          return;
        }
        running.current = terminalId;
        setState({ kind: "open", terminalId, view: started.terminal });
      } catch {
        // The reply was lost, not necessarily the start: stop whatever began.
        stop();
        if (startedFor === generation.current) {
          setState({ kind: "refused", message: MOBILE_COPY.projectTerminalCouldNotStart });
        }
      }
    })();
    return () => {
      generation.current += 1;
      running.current = undefined;
      stop();
      setState({ kind: "idle" });
    };
  }, [visible, transport, projectId]);

  const openTerminal = state.kind === "open" ? state.terminalId : undefined;
  const shellRunning = state.kind === "open" && state.view.state === "running";
  useEffect(() => {
    if (openTerminal === undefined || !shellRunning) return;
    const project = decodeProjectId(projectId);
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const answer = await sendMobileProjectTerminal(transport, {
          kind: "read-output",
          projectId: project,
          terminalId: openTerminal,
          afterCharacters: offset.current,
        });
        if (running.current !== openTerminal) return;
        if (answer.kind === "project-terminal-refused") {
          setNote(answer.message);
          return;
        }
        if (answer.kind !== "project-terminal") return;
        const received = answer.output;
        if (received !== undefined) {
          offset.current = received.characters;
          setOutput((shown) => appendTerminalOutput(shown, received));
        }
        setState((current) =>
          current.kind === "open" && current.terminalId === openTerminal
            ? { ...current, view: answer.terminal }
            : current,
        );
      } catch {
        if (running.current === openTerminal) setNote(MOBILE_COPY.approvalReconnecting);
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), props.pollIntervalMs ?? 700);
    return () => clearInterval(timer);
  }, [openTerminal, shellRunning, transport, projectId, props.pollIntervalMs]);

  const write = async (data: string) => {
    if (openTerminal === undefined) return;
    try {
      const answer = await sendMobileProjectTerminal(transport, {
        kind: "write",
        projectId: decodeProjectId(projectId),
        terminalId: openTerminal,
        data,
      });
      setNote(answer.kind === "project-terminal-refused" ? answer.message : undefined);
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    }
  };
  const runLine = () => {
    const typed = line;
    setLine("");
    void write(`${typed}\r`);
  };

  return (
    <BottomSheet
      onClose={props.onClose}
      sheetStyle={styles.sheet}
      testID="mobile-project-terminal"
      title={MOBILE_COPY.projectTerminalTitle}
      visible={props.visible}
    >
      <View style={styles.body}>
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {MOBILE_COPY.projectToolsLifetime}
        </Text>
        {state.kind === "starting" ? <ActivityIndicator color={colors.accent} /> : null}
        {state.kind === "refused" ? (
          <Text
            style={[mobileTypography.body, { color: colors.textPrimary }]}
            testID="mobile-project-terminal-refused"
          >
            {state.message}
          </Text>
        ) : null}
        {state.kind !== "open" ? null : (
          <>
            <ScrollView
              accessibilityLabel={MOBILE_COPY.projectTerminalOutput}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
              ref={scrollRef}
              style={[
                styles.output,
                { borderColor: colors.hairlineStrong, backgroundColor: colors.control },
              ]}
              testID="mobile-project-terminal-output"
            >
              <Text selectable style={[mobileTypography.mono, { color: colors.textPrimary }]}>
                {terminalPlainText(output)}
              </Text>
            </ScrollView>
            {state.view.state === "running" ? (
              <View style={styles.row}>
                <TextInput
                  accessibilityLabel={MOBILE_COPY.projectTerminalLine}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setLine}
                  onSubmitEditing={runLine}
                  placeholder={MOBILE_COPY.projectTerminalLine}
                  placeholderTextColor={colors.textSecondary}
                  returnKeyType="send"
                  spellCheck={false}
                  style={[
                    styles.input,
                    mobileTypography.mono,
                    {
                      color: colors.textPrimary,
                      borderColor: colors.hairlineStrong,
                      backgroundColor: colors.control,
                    },
                  ]}
                  testID="mobile-project-terminal-line"
                  value={line}
                />
                <ToolButton
                  label={MOBILE_COPY.projectTerminalRun}
                  onPress={runLine}
                  primary
                  testID="mobile-project-terminal-run"
                />
                <ToolButton
                  accessibilityLabel={MOBILE_COPY.projectTerminalInterruptLabel}
                  label="⌃C"
                  onPress={() => void write(CONTROL_C)}
                  testID="mobile-project-terminal-interrupt"
                />
              </View>
            ) : (
              <Text style={[mobileTypography.body, { color: colors.textSecondary }]}>
                {MOBILE_COPY.projectTerminalEnded}
              </Text>
            )}
          </>
        )}
        {note === undefined ? null : (
          <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>{note}</Text>
        )}
      </View>
    </BottomSheet>
  );
}

export interface ProjectPageSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly transport: MobileRemoteTransport;
  readonly projectId: string;
}

/**
 * The device's own Private page for this Project: an address to open, the
 * page's picture, title and address as the host last saw it, Refresh, and
 * Close page. A profile page holds the person's sign-ins and stays at a
 * window on the computer; the host says so if one is asked for.
 */
export function ProjectPageSheet(props: ProjectPageSheetProps) {
  const { colors } = useTheme();
  const [address, setAddress] = useState("");
  const [view, setView] = useState<ProjectBrowserView>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const { transport, projectId, visible } = props;

  const send = async (command: "current" | "stop" | { readonly url: string }) => {
    setBusy(true);
    try {
      const project = decodeProjectId(projectId);
      const answer = await sendMobileProjectBrowser(
        transport,
        typeof command === "string"
          ? { kind: command, projectId: project }
          : { kind: "open", projectId: project, url: command.url, profile: "private" },
      );
      if (answer.kind === "project-browser-refused") {
        setNote(answer.message);
        return;
      }
      setNote(undefined);
      setView(answer.browser);
    } catch {
      setNote(MOBILE_COPY.approvalSendFailed);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    setView(undefined);
    setNote(undefined);
    void send("current");
    // `send` reads only what the effect names.
  }, [visible, transport, projectId]);

  const open = () => {
    const url = projectPageAddress(address);
    if (url !== undefined) void send({ url });
  };
  const page = view?.context === undefined ? undefined : view.page;

  return (
    <BottomSheet
      onClose={props.onClose}
      sheetStyle={styles.sheet}
      testID="mobile-project-page"
      title={MOBILE_COPY.projectPageTitle}
      visible={props.visible}
    >
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[mobileTypography.caption, { color: colors.textSecondary }]}>
          {MOBILE_COPY.projectPageHelp}
        </Text>
        <View style={styles.row}>
          <TextInput
            accessibilityLabel={MOBILE_COPY.projectPageAddress}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            onChangeText={setAddress}
            onSubmitEditing={open}
            placeholder={MOBILE_COPY.projectPageAddressPlaceholder}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="go"
            style={[
              styles.input,
              {
                color: colors.textPrimary,
                borderColor: colors.hairlineStrong,
                backgroundColor: colors.control,
              },
            ]}
            testID="mobile-project-page-address"
            value={address}
          />
          <ToolButton
            disabled={busy || projectPageAddress(address) === undefined}
            label={MOBILE_COPY.projectPageOpen}
            onPress={open}
            primary
            testID="mobile-project-page-open"
          />
        </View>
        {busy ? <ActivityIndicator color={colors.accent} /> : null}
        {page === undefined ? null : (
          <View style={styles.page} testID="mobile-project-page-view">
            {page.title === undefined ? null : (
              <Text style={[mobileTypography.section, { color: colors.textPrimary }]}>
                {page.title}
              </Text>
            )}
            {page.url === undefined ? null : (
              <Text selectable style={[mobileTypography.caption, { color: colors.textSecondary }]}>
                {page.url}
              </Text>
            )}
            {page.screenshotDataUrl === undefined ? null : (
              <Image
                accessibilityLabel={page.title ?? MOBILE_COPY.projectPageTitle}
                resizeMode="contain"
                source={{ uri: page.screenshotDataUrl }}
                style={[
                  styles.picture,
                  { borderColor: colors.hairlineStrong, backgroundColor: colors.control },
                ]}
                testID="mobile-project-page-picture"
              />
            )}
            <View style={styles.row}>
              <ToolButton
                disabled={busy}
                label={MOBILE_COPY.projectPageRefresh}
                onPress={() => void send("current")}
                testID="mobile-project-page-refresh"
              />
              <ToolButton
                disabled={busy}
                label={MOBILE_COPY.projectPageClose}
                onPress={() => void send("stop")}
                testID="mobile-project-page-close"
              />
            </View>
          </View>
        )}
        {note === undefined ? null : (
          <Text
            style={[mobileTypography.body, { color: colors.textPrimary }]}
            testID="mobile-project-page-note"
          >
            {note}
          </Text>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

export function ToolButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly testID: string;
}) {
  const { colors } = useTheme();
  const disabled = props.disabled === true;
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={props.onPress}
      style={[
        styles.button,
        props.primary === true
          ? { backgroundColor: colors.send }
          : { borderColor: colors.hairlineStrong, borderWidth: StyleSheet.hairlineWidth },
        disabled ? { opacity: 0.5 } : null,
      ]}
      testID={props.testID}
    >
      <Text
        style={[
          mobileTypography.section,
          { color: props.primary === true ? colors.sendLabel : colors.textPrimary },
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: "90%", minHeight: "60%" },
  body: { paddingHorizontal: mobileSpacing.md, gap: mobileSpacing.sm },
  output: {
    height: 320,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: mobileSpacing.sm,
  },
  row: { flexDirection: "row", alignItems: "center", gap: mobileSpacing.xs },
  input: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: mobileSpacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  button: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: mobileSpacing.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  page: { gap: mobileSpacing.xs },
  picture: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
});
