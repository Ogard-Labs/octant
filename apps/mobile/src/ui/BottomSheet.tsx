import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { BottomSheet as SystemSheet } from "@expo/ui/community/bottom-sheet";
import { space, typography, useTheme } from "../../design-system";
import { IconButton } from "./IconButton";
import { sheetsClosing } from "./sheetsClosing";

/**
 * How tall a sheet opens: as tall as what it holds, half the screen with room
 * to pull it up, or the whole screen for a form or a camera.
 */
export type SheetSize = "fitted" | "half" | "full";

export interface BottomSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testID?: string;
  readonly headerVisible?: boolean;
  readonly contentStyle?: StyleProp<ViewStyle>;
  /** Half by default. */
  readonly size?: SheetSize;
  /** False while closing would drop work under way: no close button and no swipe away. */
  readonly dismissible?: boolean;
  /**
   * Once the sheet has left the screen, however it was closed. The system
   * shows nothing else, such as the camera, while a sheet is still leaving.
   */
  readonly onGone?: () => void;
}

const HEIGHTS: Record<SheetSize, { snapPoints?: string[]; enableDynamicSizing: boolean }> = {
  fitted: { enableDynamicSizing: true },
  half: { snapPoints: ["50%", "100%"], enableDynamicSizing: false },
  full: { snapPoints: ["100%"], enableDynamicSizing: false },
};

/**
 * The platform's own sheet: on iOS the system sheet with its grabber, heights
 * and swipe; on Android the Material bottom sheet.
 */
export function BottomSheet(props: BottomSheetProps) {
  const { colors } = useTheme();
  const [sheet] = useState(() => Symbol("sheet"));
  const othersLeaving = useSyncExternalStore(
    sheetsClosing.subscribe,
    () => sheetsClosing.othersLeaving(sheet),
    () => false,
  );
  const selfLeaving = useSyncExternalStore(
    sheetsClosing.subscribe,
    () => sheetsClosing.isLeaving(sheet),
    () => false,
  );
  // What the system has been asked for. A sheet on screen stays there while
  // one over it leaves; a sheet leaving is not asked back until it has gone.
  const [phase, setPhase] = useState<"off" | "on" | "leaving">("off");
  // An exit the parent asked for is not reported back to it: by the time the
  // system says the sheet has gone, the parent may have asked for it again.
  const parentClosed = useRef(false);
  // Marked before any sheet asked for in the same change looks, so that one waits.
  useLayoutEffect(() => {
    if (phase !== "on" || props.visible) return;
    parentClosed.current = true;
    setPhase("leaving");
    sheetsClosing.leaves(sheet);
  }, [phase, props.visible, sheet]);
  useEffect(() => {
    if (props.visible && phase === "off" && !sheetsClosing.othersLeaving(sheet)) setPhase("on");
  }, [othersLeaving, phase, props.visible, sheet]);
  // A sheet the system never reported gone is taken as gone once its time is up.
  useEffect(() => {
    if (phase === "leaving" && !selfLeaving) setPhase("off");
  }, [phase, selfLeaving]);
  useEffect(() => () => sheetsClosing.gone(sheet), [sheet]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        page: { flex: 1 },
        header: {
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm,
          marginBottom: space.xs,
        },
        headerSpacer: { width: 34 },
        content: { flex: 1 },
        fitted: { paddingBottom: space.lg },
        title: {
          flex: 1,
          textAlign: "center",
          color: colors.textPrimary,
          fontSize: typography.pageTitle.fontSize,
          fontWeight: typography.pageTitle.fontWeight,
          letterSpacing: typography.pageTitle.letterSpacing,
        },
      }),
    [colors],
  );

  // Drawn until the system says it has gone, so it leaves with the system's
  // own motion and not by vanishing.
  if (!props.visible && phase === "off") return null;
  const size = props.size ?? "half";
  const dismissible = props.dismissible !== false;
  const close = () => {
    setPhase("leaving");
    sheetsClosing.leaves(sheet);
  };
  const header =
    props.headerVisible === false ? null : (
      <View style={styles.header}>
        {dismissible ? (
          <IconButton
            accessibilityLabel="Close"
            iconSize={17}
            name="close"
            onPress={close}
            size={30}
            testID="mobile-sheet-close"
          />
        ) : (
          <View style={styles.headerSpacer} />
        )}
        <Text accessibilityRole="header" style={styles.title}>
          {props.title}
        </Text>
        <View style={styles.headerSpacer} />
      </View>
    );

  return (
    <SystemSheet
      {...HEIGHTS[size]}
      // iOS draws its own sheet material, glass where the system uses it.
      {...(Platform.OS === "ios" ? {} : { backgroundStyle: { backgroundColor: colors.canvas } })}
      enablePanDownToClose={dismissible}
      index={phase === "on" && props.visible ? 0 : -1}
      onClose={() => {
        setPhase("off");
        sheetsClosing.gone(sheet);
        const closedByParent = parentClosed.current;
        parentClosed.current = false;
        if (!closedByParent) props.onClose();
        props.onGone?.();
      }}
    >
      <View
        style={size === "fitted" ? styles.fitted : styles.page}
        testID={props.testID ?? "mobile-bottom-sheet"}
      >
        {header}
        <View style={[size === "fitted" ? null : styles.content, props.contentStyle]}>
          {props.children}
        </View>
      </View>
    </SystemSheet>
  );
}
