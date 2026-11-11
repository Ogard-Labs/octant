import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { space, useTheme } from "../../design-system";
import type { MobileIconName } from "./IconButton";

export type MobileTabId = "inbox" | "chat" | "work" | "code" | "settings";

const TABS: ReadonlyArray<{
  readonly id: MobileTabId;
  readonly label: string;
  readonly icon: MobileIconName;
  readonly activeIcon: MobileIconName;
}> = [
  { id: "inbox", label: "Inbox", icon: "file-tray-outline", activeIcon: "file-tray" },
  { id: "chat", label: "Chat", icon: "chatbubble-outline", activeIcon: "chatbubble" },
  { id: "work", label: "Work", icon: "briefcase-outline", activeIcon: "briefcase" },
  { id: "code", label: "Code", icon: "code-slash-outline", activeIcon: "code-slash" },
  { id: "settings", label: "Settings", icon: "settings-outline", activeIcon: "settings" },
];

export interface TabBarProps {
  readonly active: MobileTabId;
  readonly onSelect: (tab: MobileTabId) => void;
  /** A count on a tab's icon; only Inbox carries one, for what needs the person. */
  readonly badges?: Partial<Record<MobileTabId, number>>;
}

/**
 * The phone's top-level places as the system's tab bar: always in reach at the
 * bottom, the current one in the accent. It replaced a menu button that opened
 * a drawer, which hid the places behind a tap and read as a web page's menu.
 */
export function TabBar(props: TabBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        bar: {
          flexDirection: "row",
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.hairlineStrong,
          backgroundColor: colors.glassFillChrome,
          paddingTop: 6,
          paddingBottom: process.env.EXPO_OS === "web" ? space.md : 2,
        },
        tab: { flex: 1, alignItems: "center", gap: 2, minHeight: 46 },
        label: { fontSize: 10, fontWeight: "500", letterSpacing: 0.1 },
        badge: {
          position: "absolute",
          top: -3,
          left: 15,
          minWidth: 17,
          height: 17,
          borderRadius: 9,
          paddingHorizontal: 4,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.danger,
        },
        badgeLabel: { color: colors.primaryForeground, fontSize: 11, fontWeight: "600" },
      }),
    [colors],
  );

  return (
    <View accessibilityRole="tablist" style={styles.bar} testID="mobile-tab-bar">
      {TABS.map((tab) => {
        const active = tab.id === props.active;
        const tone = active ? colors.accent : colors.textTertiary;
        const badge = props.badges?.[tab.id] ?? 0;
        return (
          <Pressable
            accessibilityLabel={badge > 0 ? `${tab.label}, ${badge}` : tab.label}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            key={tab.id}
            onPress={() => props.onSelect(tab.id)}
            style={styles.tab}
            testID={`mobile-tab-${tab.id}`}
          >
            <View>
              <Ionicons color={tone} name={active ? tab.activeIcon : tab.icon} size={24} />
              {badge > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeLabel}>{badge > 99 ? "99+" : badge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.label, { color: tone }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
