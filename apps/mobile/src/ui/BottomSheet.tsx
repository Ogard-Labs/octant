import { useMemo, type ReactNode } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import { IconButton } from "./IconButton";
import { KeyboardRoom } from "./KeyboardRoom";

export interface BottomSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testID?: string;
  readonly headerVisible?: boolean;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly sheetStyle?: StyleProp<ViewStyle>;
}

export function BottomSheet(props: BottomSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, justifyContent: "flex-end" },
        backdrop: {
          ...StyleSheet.absoluteFill,
          backgroundColor: colors.backdrop,
        },
        sheet: {
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          maxHeight: "78%",
        },
        sheetContent: {
          paddingBottom: space.xl,
        },
        // The system sheet's grabber: 36 by 5, in the muted ink.
        handle: {
          alignSelf: "center",
          width: 36,
          height: 5,
          borderRadius: radii.pill,
          backgroundColor: colors.hairlineStrong,
          marginTop: 6,
          marginBottom: space.xs,
        },
        header: {
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm,
          marginBottom: space.xs,
        },
        headerSpacer: { width: 34 },
        page: { flex: 1 },
        pageTop: { height: space.md },
        pageContent: { flex: 1 },
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

  const header =
    props.headerVisible === false ? null : (
      <View style={styles.header}>
        <IconButton
          accessibilityLabel="Close"
          iconSize={17}
          name="close"
          onPress={props.onClose}
          size={30}
          testID="mobile-sheet-close"
        />
        <Text style={styles.title}>{props.title}</Text>
        <View style={styles.headerSpacer} />
      </View>
    );

  if (Platform.OS === "ios") {
    // The system's own sheet: its card, its swipe, and its keyboard room.
    return (
      <Modal
        allowSwipeDismissal
        animationType="slide"
        onRequestClose={props.onClose}
        presentationStyle="pageSheet"
        visible={props.visible}
      >
        <KeyboardRoom
          style={[styles.page, { backgroundColor: colors.canvas }]}
          testID={props.testID ?? "mobile-bottom-sheet"}
        >
          <View style={styles.pageTop} />
          {header}
          <View style={[styles.pageContent, props.contentStyle]}>{props.children}</View>
        </KeyboardRoom>
      </Modal>
    );
  }

  return (
    <Modal animationType="slide" onRequestClose={props.onClose} transparent visible={props.visible}>
      <View style={styles.root}>
        <Pressable onPress={props.onClose} style={styles.backdrop} testID="mobile-sheet-backdrop" />
        <GlassSurface
          contentStyle={[styles.sheetContent, props.contentStyle]}
          material="thick"
          radius={radii.sheet}
          style={[styles.sheet, props.sheetStyle]}
          testID={props.testID ?? "mobile-bottom-sheet"}
        >
          <View style={styles.handle} />
          {header}
          {props.children}
        </GlassSurface>
      </View>
    </Modal>
  );
}
