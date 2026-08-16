import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { space, typography, useTheme } from "../../design-system";
import { BottomSheet } from "../ui/BottomSheet";
import type { MobileIconName } from "../ui/IconButton";
import type { MobileHomeView } from "./homeView";

const VIEW_ITEMS: ReadonlyArray<{
  readonly id: MobileHomeView;
  readonly label: string;
  readonly detail: string;
  readonly icon: MobileIconName;
}> = [
  { id: "inbox", label: "Inbox", detail: "Work and Code status", icon: "file-tray-outline" },
  {
    id: "chat",
    label: "Chat",
    detail: "Conversations with your hosts",
    icon: "chatbubble-outline",
  },
  { id: "work", label: "Work", detail: "Project work", icon: "folder-outline" },
  { id: "code", label: "Code", detail: "Repository tasks and review", icon: "code-slash" },
];

export function HomeNavigationSheet(props: {
  readonly activeView: MobileHomeView;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onOpenHosts: () => void;
  readonly onSelectView: (view: MobileHomeView) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        list: { paddingHorizontal: space.sm, gap: 2 },
        row: {
          minHeight: 62,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingHorizontal: space.md,
          borderRadius: 14,
        },
        rowSelected: { backgroundColor: colors.glassFillRegular },
        rowPressed: { backgroundColor: colors.glassFillThin },
        icon: {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.glassFillThin,
        },
        body: { flex: 1, gap: 2 },
        label: { color: colors.textPrimary, fontSize: typography.body.fontSize, fontWeight: "600" },
        detail: { color: colors.textTertiary, fontSize: typography.caption.fontSize },
        divider: {
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.glassStroke,
          marginHorizontal: space.md,
          marginVertical: space.sm,
        },
      }),
    [colors],
  );

  const selectView = (view: MobileHomeView) => {
    props.onClose();
    props.onSelectView(view);
  };

  return (
    <BottomSheet
      onClose={props.onClose}
      testID="mobile-home-navigation-sheet"
      title="Octant"
      visible={props.visible}
    >
      <View style={styles.list}>
        {VIEW_ITEMS.map((item) => {
          const selected = props.activeView === item.id;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={item.id}
              onPress={() => selectView(item.id)}
              style={({ pressed }) => [
                styles.row,
                selected ? styles.rowSelected : null,
                pressed && !selected ? styles.rowPressed : null,
              ]}
              testID={`mobile-home-view-${item.id}`}
            >
              <View style={styles.icon}>
                <Ionicons
                  color={selected ? colors.textPrimary : colors.textSecondary}
                  name={item.icon}
                  size={18}
                />
              </View>
              <View style={styles.body}>
                <Text style={styles.label}>{item.label}</Text>
                <Text style={styles.detail}>{item.detail}</Text>
              </View>
              {selected ? <Ionicons color={colors.accent} name="checkmark" size={18} /> : null}
            </Pressable>
          );
        })}
        <View style={styles.divider} />
        <Pressable
          accessibilityLabel="Open workspaces and settings"
          accessibilityRole="button"
          onPress={() => {
            props.onClose();
            props.onOpenHosts();
          }}
          style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          testID="mobile-home-view-workspaces"
        >
          <View style={styles.icon}>
            <Ionicons color={colors.textSecondary} name="folder-open-outline" size={18} />
          </View>
          <View style={styles.body}>
            <Text style={styles.label}>Workspaces & Settings</Text>
            <Text style={styles.detail}>Open workspaces and settings</Text>
          </View>
          <Ionicons color={colors.textTertiary} name="chevron-forward" size={18} />
        </Pressable>
      </View>
    </BottomSheet>
  );
}
