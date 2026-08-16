import { useMemo, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { GlassSurface, radii, space, typography, useTheme } from "../../design-system";
import { IconButton } from "./IconButton";

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
        handle: {
          alignSelf: "center",
          width: 40,
          height: 5,
          borderRadius: radii.pill,
          backgroundColor: colors.glassHighlight,
          marginTop: space.sm,
          marginBottom: space.sm,
        },
        header: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.md,
          marginBottom: space.md,
        },
        headerSpacer: { width: 34 },
        title: {
          flex: 1,
          textAlign: "center",
          color: colors.textPrimary,
          fontSize: typography.title.fontSize,
          fontWeight: typography.title.fontWeight,
        },
      }),
    [colors],
  );

  return (
    <Modal animationType="slide" onRequestClose={props.onClose} transparent visible={props.visible}>
      <View style={styles.root}>
        <Pressable onPress={props.onClose} style={styles.backdrop} testID="mobile-sheet-backdrop" />
        <GlassSurface
          contentStyle={[styles.sheetContent, props.contentStyle]}
          material="thick"
          radius={radii.composer}
          style={[styles.sheet, props.sheetStyle]}
          testID={props.testID ?? "mobile-bottom-sheet"}
        >
          <View style={styles.handle} />
          {props.headerVisible === false ? null : (
            <View style={styles.header}>
              <IconButton
                accessibilityLabel="Close"
                name="close"
                onPress={props.onClose}
                size={34}
                testID="mobile-sheet-close"
                variant="ghost"
              />
              <Text style={styles.title}>{props.title}</Text>
              <View style={styles.headerSpacer} />
            </View>
          )}
          {props.children}
        </GlassSurface>
      </View>
    </Modal>
  );
}
