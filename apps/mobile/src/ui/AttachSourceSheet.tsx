import { useMemo, type ComponentProps } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { MobileAttachmentSource } from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { mobileSpacing, mobileTypography } from "../theme/tokens";
import { useTheme } from "../../design-system";
import { BottomSheet } from "./BottomSheet";

export interface AttachSourceSheetProps {
  readonly visible: boolean;
  /** Only the sources this thread's mode and model take; the host decides the rest. */
  readonly sources: ReadonlyArray<MobileAttachmentSource>;
  readonly onClose: () => void;
  readonly onSelect: (source: MobileAttachmentSource) => void;
}

const SOURCE_PRESENTATION: Readonly<
  Record<
    MobileAttachmentSource,
    { readonly label: string; readonly icon: ComponentProps<typeof Ionicons>["name"] }
  >
> = {
  camera: { label: MOBILE_COPY.attachFromCamera, icon: "camera-outline" },
  library: { label: MOBILE_COPY.attachFromLibrary, icon: "image-outline" },
  file: { label: MOBILE_COPY.attachFromFiles, icon: "document-outline" },
};

export function AttachSourceSheet(props: AttachSourceSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        help: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
          lineHeight: 18,
          paddingHorizontal: mobileSpacing.md,
          paddingBottom: mobileSpacing.sm,
        },
        row: {
          flexDirection: "row",
          alignItems: "center",
          gap: mobileSpacing.md,
          marginHorizontal: mobileSpacing.sm,
          paddingHorizontal: mobileSpacing.md,
          paddingVertical: mobileSpacing.md,
          borderRadius: 14,
        },
        icon: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.glassFillThin,
        },
        label: {
          color: colors.textPrimary,
          fontSize: mobileTypography.body.fontSize,
          fontWeight: "500",
        },
      }),
    [colors],
  );

  return (
    <BottomSheet
      onClose={props.onClose}
      testID="mobile-attach-sheet"
      title={MOBILE_COPY.attachSheetTitle}
      visible={props.visible}
    >
      <Text style={styles.help}>{MOBILE_COPY.attachSheetHelp}</Text>
      {props.sources.map((source) => {
        const presentation = SOURCE_PRESENTATION[source];
        return (
          <Pressable
            accessibilityRole="button"
            key={source}
            onPress={() => props.onSelect(source)}
            style={styles.row}
            testID={`mobile-attach-${source}`}
          >
            <View style={styles.icon}>
              <Ionicons color={colors.textPrimary} name={presentation.icon} size={18} />
            </View>
            <Text style={styles.label}>{presentation.label}</Text>
          </Pressable>
        );
      })}
    </BottomSheet>
  );
}
