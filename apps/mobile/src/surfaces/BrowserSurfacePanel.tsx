import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import {
  loadMobileBrowserSurface,
  MobileInboxFailure,
  tapMobileBrowserSurface,
  type MobileBrowserSurfaceView,
  type MobileInboxMode,
  type MobileRemoteTransport,
  type RemoteThreadSurfaceReach,
} from "@octant/client-runtime";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { browserSurfaceReachNote, browserSurfaceStatusNote } from "./threadSurfacePresentation";

export interface BrowserSurfacePanelProps {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly mode: MobileInboxMode;
  readonly reach: RemoteThreadSurfaceReach;
}

/**
 * What the Mac's browser is showing for this thread, on the phone.
 *
 * The picture is the host's: this panel draws the screenshot the host captured
 * and sends taps back as normalized points, so the host maps them onto its own
 * viewport rather than trusting anything this device measured. It never renders
 * the page itself, so nothing the page contains ever runs here.
 */
export function BrowserSurfacePanel(props: BrowserSurfacePanelProps) {
  const { colors } = useTheme();
  const [view, setView] = useState<MobileBrowserSurfaceView | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [frame, setFrame] = useState<{ readonly width: number; readonly height: number }>();

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

  const tap = useCallback(
    async (x: number, y: number) => {
      const handle = view?.action;
      if (handle === undefined || frame === undefined || props.reach !== "interactive") return;
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
            point: {
              x: Math.min(1, Math.max(0, x / frame.width)),
              y: Math.min(1, Math.max(0, y / frame.height)),
            },
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
    [frame, props.reach, props.threadId, props.transport, view?.action],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        panel: { gap: mobileSpacing.xs, paddingHorizontal: mobileSpacing.md },
        note: { ...mobileTypography.caption, color: colors.textSecondary },
        status: { ...mobileTypography.caption, color: colors.textTertiary },
        message: { ...mobileTypography.caption, color: colors.danger },
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

  return (
    <View style={styles.panel} testID="mobile-browser-surface">
      <Text style={styles.note}>{browserSurfaceReachNote(props.reach)}</Text>
      <View
        onLayout={(event) => setFrame(event.nativeEvent.layout)}
        style={styles.stage}
        testID="mobile-browser-surface-stage"
      >
        {view?.screenshotDataUrl === undefined ? (
          <Text style={styles.empty}>
            {browserSurfaceStatusNote({
              status,
              stale: view?.stale ?? true,
              ...(view?.url === undefined ? {} : { url: view.url }),
            })}
          </Text>
        ) : (
          <Pressable
            accessibilityLabel="Tap in the page the Mac is showing"
            accessibilityRole="imagebutton"
            disabled={props.reach !== "interactive" || busy}
            onPress={(event) => void tap(event.nativeEvent.locationX, event.nativeEvent.locationY)}
            testID="mobile-browser-surface-page"
          >
            <Image
              accessibilityIgnoresInvertColors
              resizeMode="contain"
              source={{ uri: view.screenshotDataUrl }}
              style={styles.image}
            />
          </Pressable>
        )}
      </View>
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
