import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  createMobilePairedBrowserControlClient,
  handBackMobileBrowserSurface,
  loadMobileBrowserSurface,
  MobileInboxFailure,
  takeOverMobileBrowserSurface,
  tapMobileBrowserSurface,
  type MobileBrowserSurfaceView,
  type MobileInboxMode,
  type MobileRemoteTransport,
  type RemoteThreadSurfaceReach,
} from "@octant/client-runtime";
import {
  type PairedBrowserEndReason,
  MAX_PAIRED_BROWSER_TEXT_LENGTH,
  type PairedBrowserInput,
  type PairedBrowserStreamEvent,
  type PairedBrowserWithheldReason,
} from "@octant/contracts/paired-browser-control";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { browserSurfaceReachNote, browserSurfaceStatusNote } from "./threadSurfacePresentation";

export interface BrowserSurfacePanelProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly mode: MobileInboxMode;
  readonly reach: RemoteThreadSurfaceReach;
  /** Person-paired devices can hold a live Browser page via touch and keyboard input. */
  readonly actsAsHostPerson?: boolean;
  /**
   * Draw only the page picture, small, over the conversation; a tap expands it
   * rather than clicking in the page, which a thumbnail is too small to aim at.
   */
  readonly compact?: { readonly onExpand: () => void };
}

interface PairedLiveFrame {
  readonly frameId: number;
  readonly src: string;
}

const WITHHELD_COPY: Readonly<Record<PairedBrowserWithheldReason, string>> = {
  "private-custody": "Frames are paused while a login fill or private script is active.",
  "native-prompt": "Frames are paused while a prompt is open on the computer.",
  "outside-document": "This tab moved outside the held page. Finish this on the computer.",
};

/**
 * What the Mac's browser is showing for this thread, on the phone.
 *
 * The picture is the host's: this panel draws the screenshot the host captured
 * and sends taps back as normalized points, so the host maps them onto its own
 * viewport rather than trusting anything this device measured. It never renders
 * the page itself, so nothing the page contains ever runs here.
 */
/** What the panel says once this phone no longer holds the page. */
export function pairedControlEndedMessage(reason: PairedBrowserEndReason): string {
  if (reason === "handed-back") return "Handed back to the agent.";
  // The host sends one reason whether the prompt was answered or its turn stopped.
  if (reason === "agent-sign-in")
    return "The sign-in request ended, so this phone no longer holds the page.";
  return "Remote control ended. Finish this on the computer or take over again.";
}

export function BrowserSurfacePanel(props: BrowserSurfacePanelProps) {
  const { colors } = useTheme();
  const [view, setView] = useState<MobileBrowserSurfaceView | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [frame, setFrame] = useState<{ readonly width: number; readonly height: number }>();
  const [pairedLease, setPairedLease] = useState<MobileBrowserSurfaceView["pairedLease"]>();
  const [liveFrame, setLiveFrame] = useState<PairedLiveFrame | undefined>();
  const [withheld, setWithheld] = useState<PairedBrowserWithheldReason | undefined>();
  const [appHidden, setAppHidden] = useState(() => AppState.currentState !== "active");
  const [typedText, setTypedText] = useState("");
  const sequence = useRef(0);
  const pairedControl = useMemo(
    () => createMobilePairedBrowserControlClient(props.transport),
    [props.transport],
  );

  // Blank any live frame immediately when the app leaves the foreground so the
  // OS app switcher never caches a screenshot of a signed-in page.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const hidden = nextState !== "active";
      setAppHidden(hidden);
      if (hidden) setLiveFrame(undefined);
    });
    return () => {
      subscription.remove();
    };
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      setView(
        await loadMobileBrowserSurface({
          transport: props.transport,
          threadId: props.threadId,
          mode: props.mode,
        }),
      );
    } catch (cause) {
      setView(undefined);
      setMessage(
        cause instanceof MobileInboxFailure ? cause.message : "Could not read the Mac's browser.",
      );
    } finally {
      setBusy(false);
    }
  }, [props.mode, props.threadId, props.transport]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (pairedLease === undefined) return;
    const abort = new AbortController();
    const onEvent = (event: PairedBrowserStreamEvent) => {
      if (event.kind === "frame") {
        if (AppState.currentState !== "active") return;
        setWithheld(undefined);
        setLiveFrame({
          frameId: event.frameId,
          src: `data:image/jpeg;base64,${event.jpegBase64}`,
        });
        return;
      }
      if (event.kind === "withheld") {
        setLiveFrame(undefined);
        setWithheld(event.reason);
        return;
      }
      if (event.kind === "file-chooser") {
        setMessage("A file chooser opened on the page. Finish this on the computer.");
        return;
      }
      if (event.kind === "reclaimed-locally") {
        setLiveFrame(undefined);
        setPairedLease(undefined);
        setMessage("Reclaimed on the computer.");
        return;
      }
      setLiveFrame(undefined);
      setPairedLease(undefined);
      setMessage(pairedControlEndedMessage(event.reason));
    };
    void pairedControl
      .stream({ leaseId: pairedLease.leaseId, onEvent, signal: abort.signal })
      .catch(() => undefined);
    return () => {
      abort.abort();
    };
  }, [pairedControl, pairedLease]);

  const sendPairedEvents = useCallback(
    async (events: ReadonlyArray<PairedBrowserInput>) => {
      if (pairedLease === undefined || events.length === 0) return;
      sequence.current += 1;
      const result = await pairedControl.sendInput(pairedLease.leaseId, sequence.current, events);
      if (result.status === "refused") {
        if (result.reason === "stale-frame") {
          setMessage("The page changed before that tap landed.");
        } else if (result.reason === "lease-ended" || result.reason === "authority-ended") {
          setLiveFrame(undefined);
          setPairedLease(undefined);
          setMessage("Remote control ended. Finish this on the computer or take over again.");
        } else if (result.reason === "rate-limited") {
          setMessage("Slow down — input rate limit reached.");
        }
      }
    },
    [pairedControl, pairedLease],
  );

  const takeOver = useCallback(async () => {
    if (props.actsAsHostPerson !== true) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const next = await takeOverMobileBrowserSurface({
        transport: props.transport,
        threadId: props.threadId,
        ...(view?.action?.authority === undefined ? {} : { authority: view.action.authority }),
      });
      setView(next);
      if (next.pairedLease !== undefined) {
        sequence.current = 0;
        setWithheld(undefined);
        setPairedLease(next.pairedLease);
      }
    } catch (cause) {
      setMessage(
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not hold the Browser page from this device.",
      );
    } finally {
      setBusy(false);
    }
  }, [props.actsAsHostPerson, props.threadId, props.transport, view?.action?.authority]);

  const handBack = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const next = await handBackMobileBrowserSurface({
        transport: props.transport,
        threadId: props.threadId,
        ...(pairedLease === undefined ? {} : { leaseId: pairedLease.leaseId }),
        ...(view?.action?.authority === undefined ? {} : { authority: view.action.authority }),
      });
      setLiveFrame(undefined);
      setWithheld(undefined);
      setPairedLease(undefined);
      setView(next);
    } catch (cause) {
      setMessage(
        cause instanceof MobileInboxFailure ? cause.message : "Could not hand the page back.",
      );
    } finally {
      setBusy(false);
    }
  }, [pairedLease, props.threadId, props.transport, view?.action?.authority]);

  const tap = useCallback(
    async (x: number, y: number, kind: "tap" | "long-press" = "tap") => {
      if (frame === undefined || frame.width <= 0 || frame.height <= 0) return;
      const point = {
        x: Math.min(1, Math.max(0, x / frame.width)),
        y: Math.min(1, Math.max(0, y / frame.height)),
      };
      if (pairedLease !== undefined) {
        if (liveFrame === undefined) return;
        await sendPairedEvents([{ kind, frameId: liveFrame.frameId, x: point.x, y: point.y }]);
        return;
      }
      const handle = view?.action;
      if (handle === undefined || props.reach !== "interactive") return;
      setBusy(true);
      setMessage(undefined);
      try {
        setView(
          await tapMobileBrowserSurface({
            transport: props.transport,
            threadId: props.threadId,
            handle,
            // Normalized against the picture actually drawn, so the host places
            // the tap in its own viewport instead of in phone pixels.
            point,
          }),
        );
      } catch (cause) {
        setMessage(
          cause instanceof MobileInboxFailure ? cause.message : "The Mac refused this tap.",
        );
      } finally {
        setBusy(false);
      }
    },
    [
      frame,
      liveFrame,
      pairedLease,
      props.reach,
      props.threadId,
      props.transport,
      sendPairedEvents,
      view?.action,
    ],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.xs, paddingHorizontal: mobileSpacing.md },
        note: { ...mobileTypography.caption, color: colors.textSecondary },
        status: { ...mobileTypography.caption, color: colors.textTertiary },
        message: { ...mobileTypography.caption, color: colors.danger },
        actionsRow: { flexDirection: "row", gap: mobileSpacing.sm, alignItems: "center" },
        actionButton: {
          ...mobileTypography.caption,
          color: colors.accent,
          paddingVertical: mobileSpacing.xs,
        },
        textRow: { flexDirection: "row", gap: mobileSpacing.xs, alignItems: "center" },
        textInput: {
          ...mobileTypography.caption,
          flex: 1,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          paddingHorizontal: mobileSpacing.sm,
          paddingVertical: mobileSpacing.xs,
          color: colors.textPrimary,
          backgroundColor: colors.surface,
        },
        stage: {
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          overflow: "hidden",
          backgroundColor: colors.surface,
          minHeight: 180,
          justifyContent: "center",
        },
        image: { width: "100%", aspectRatio: 0.75 },
        compactImage: { width: "100%", aspectRatio: 0.75 },
        compactNote: {
          ...mobileTypography.caption,
          color: colors.textTertiary,
          padding: mobileSpacing.sm,
        },
        empty: {
          ...mobileTypography.caption,
          color: colors.textTertiary,
          padding: mobileSpacing.md,
        },
        refresh: {
          ...mobileTypography.caption,
          color: colors.accent,
          paddingTop: mobileSpacing.xs,
        },
      }),
    [colors],
  );

  const status = view?.status ?? "waiting";
  const unavailable = status === "unavailable";
  const canHold =
    props.actsAsHostPerson === true &&
    props.compact === undefined &&
    view !== undefined &&
    (status === "showing" || status === "waiting");

  if (props.compact !== undefined) {
    const onExpand = props.compact.onExpand;
    return (
      <Pressable
        accessibilityLabel="Show the Mac's browser full size"
        accessibilityRole="button"
        onPress={onExpand}
        testID="mobile-browser-surface-compact"
      >
        {view?.screenshotDataUrl === undefined || appHidden ? (
          <Text numberOfLines={3} style={styles.compactNote}>
            {browserSurfaceStatusNote({
              status,
              stale: view?.stale ?? true,
              ...(view?.url === undefined ? {} : { url: view.url }),
            })}
          </Text>
        ) : (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: view.screenshotDataUrl }}
            style={styles.compactImage}
          />
        )}
      </Pressable>
    );
  }

  const displayedImage =
    pairedLease !== undefined
      ? appHidden || withheld !== undefined
        ? undefined
        : liveFrame?.src
      : appHidden
        ? undefined
        : view?.screenshotDataUrl;

  return (
    <View style={styles.panel} testID="mobile-browser-surface">
      <Text style={styles.note}>
        {pairedLease !== undefined
          ? "You hold this page from this device. Touch and keyboard input stay on the computer."
          : browserSurfaceReachNote(props.reach)}
      </Text>
      {canHold ? (
        <View style={styles.actionsRow}>
          {pairedLease === undefined ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void takeOver()}
              testID="mobile-browser-surface-take-over"
            >
              <Text style={styles.actionButton}>
                {view?.waitingForPerson === "sign-in" ? "Sign in here" : "Take over"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void handBack()}
              testID="mobile-browser-surface-hand-back"
            >
              <Text style={styles.actionButton}>Hand back</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      <View
        onLayout={(event) => setFrame(event.nativeEvent.layout)}
        style={styles.stage}
        testID="mobile-browser-surface-stage"
      >
        {pairedLease !== undefined && appHidden ? (
          <Text style={styles.empty}>Live frame hidden while app is inactive.</Text>
        ) : pairedLease !== undefined && withheld !== undefined ? (
          <Text style={styles.empty}>{WITHHELD_COPY[withheld]}</Text>
        ) : displayedImage === undefined ? (
          <Text style={unavailable ? styles.status : styles.empty}>
            {pairedLease !== undefined
              ? "Waiting for live frame from the computer..."
              : browserSurfaceStatusNote({
                  status,
                  stale: view?.stale ?? true,
                  ...(view?.url === undefined ? {} : { url: view.url }),
                })}
          </Text>
        ) : (
          <Pressable
            accessibilityLabel="Tap in the page the Mac is showing"
            accessibilityRole="imagebutton"
            disabled={pairedLease === undefined && (props.reach !== "interactive" || busy)}
            onLongPress={(event) => {
              if (pairedLease !== undefined) {
                void tap(event.nativeEvent.locationX, event.nativeEvent.locationY, "long-press");
              }
            }}
            onPress={(event) => void tap(event.nativeEvent.locationX, event.nativeEvent.locationY)}
            testID="mobile-browser-surface-page"
          >
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={{ uri: displayedImage }}
              style={styles.image}
            />
          </Pressable>
        )}
      </View>
      {pairedLease !== undefined ? (
        <>
          <View style={styles.actionsRow}>
            <Pressable
              accessibilityRole="button"
              disabled={liveFrame === undefined}
              onPress={() => {
                if (liveFrame !== undefined) {
                  void sendPairedEvents([
                    {
                      kind: "scroll",
                      frameId: liveFrame.frameId,
                      x: 0.5,
                      y: 0.5,
                      deltaX: 0,
                      deltaY: -240,
                    },
                  ]);
                }
              }}
              testID="mobile-browser-surface-scroll-up"
            >
              <Text style={styles.actionButton}>Scroll up</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={liveFrame === undefined}
              onPress={() => {
                if (liveFrame !== undefined) {
                  void sendPairedEvents([
                    {
                      kind: "scroll",
                      frameId: liveFrame.frameId,
                      x: 0.5,
                      y: 0.5,
                      deltaX: 0,
                      deltaY: 240,
                    },
                  ]);
                }
              }}
              testID="mobile-browser-surface-scroll-down"
            >
              <Text style={styles.actionButton}>Scroll down</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void sendPairedEvents([
                  { kind: "key", phase: "down", key: "Enter", code: "Enter" },
                  { kind: "key", phase: "up", key: "Enter", code: "Enter" },
                ])
              }
              testID="mobile-browser-surface-key-enter"
            >
              <Text style={styles.actionButton}>Enter</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void sendPairedEvents([
                  { kind: "key", phase: "down", key: "Backspace", code: "Backspace" },
                  { kind: "key", phase: "up", key: "Backspace", code: "Backspace" },
                ])
              }
              testID="mobile-browser-surface-key-backspace"
            >
              <Text style={styles.actionButton}>Backspace</Text>
            </Pressable>
          </View>
          <View style={styles.textRow}>
            <TextInput
              accessibilityLabel="Type into the held page"
              onChangeText={setTypedText}
              placeholder="Type or paste into the page"
              style={styles.textInput}
              testID="mobile-browser-surface-text-input"
              value={typedText}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const payload = typedText.slice(0, MAX_PAIRED_BROWSER_TEXT_LENGTH);
                if (payload.length === 0) return;
                setTypedText("");
                void sendPairedEvents([{ kind: "text", text: payload }]);
              }}
              testID="mobile-browser-surface-text-send"
            >
              <Text style={styles.actionButton}>Send</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {view?.screenshotDataUrl === undefined ? null : (
        <Text style={styles.status}>
          {browserSurfaceStatusNote({
            status,
            stale: view.stale,
            ...(view.url === undefined ? {} : { url: view.url }),
          })}
        </Text>
      )}
      {busy ? <ActivityIndicator color={colors.accent} /> : null}
      {message === undefined ? null : <Text style={styles.message}>{message}</Text>}
      <Pressable onPress={() => void refresh()} testID="mobile-browser-surface-refresh">
        <Text style={styles.refresh}>Refresh</Text>
      </Pressable>
    </View>
  );
}
