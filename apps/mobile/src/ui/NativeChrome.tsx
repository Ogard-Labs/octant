import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, typography, useTheme } from "../../design-system";
import type { MobileIconName } from "./IconButton";

/*
 * The phone's native chrome: the bars, titles, and grouped lists a person
 * already knows from the system's own apps. Screens compose these rather than
 * drawing page-like headings and free-floating text, which read as a web page
 * inside an app frame.
 */

// The web build has no status bar of its own, so the bars keep its room.
const WEB_STATUS_ROOM = process.env.EXPO_OS === "web" ? 44 : 0;

export interface NavBarProps {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onBack?: (() => void) | undefined;
  /** The word beside the back chevron: the screen the person came from. */
  readonly backLabel?: string;
  readonly trailing?: ReactNode;
  readonly backTestID?: string;
}

/** A pushed screen's bar: back on the leading edge, the title centred. */
export function NavBar(props: NavBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        bar: {
          minHeight: 44,
          marginTop: WEB_STATUS_ROOM,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.xs,
        },
        side: { flex: 1, flexDirection: "row", alignItems: "center" },
        sideEnd: { justifyContent: "flex-end", paddingRight: space.xs, gap: space.xs },
        back: {
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          paddingRight: space.sm,
        },
        backLabel: { color: colors.accent, fontSize: 17, marginLeft: -2 },
        center: { flex: 2.4, alignItems: "center" },
        title: {
          color: colors.textPrimary,
          fontSize: typography.pageTitle.fontSize,
          fontWeight: typography.pageTitle.fontWeight,
          letterSpacing: typography.pageTitle.letterSpacing,
        },
        subtitle: { color: colors.textTertiary, fontSize: typography.meta.fontSize, marginTop: 1 },
      }),
    [colors],
  );

  return (
    <View style={styles.bar}>
      <View style={styles.side}>
        {props.onBack === undefined ? null : (
          <Pressable
            accessibilityLabel={
              props.backLabel === undefined ? "Back" : `Back to ${props.backLabel}`
            }
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onBack}
            style={({ pressed }) => [styles.back, pressed ? { opacity: 0.5 } : null]}
            testID={props.backTestID}
          >
            <Ionicons color={colors.accent} name="chevron-back" size={27} />
            {props.backLabel === undefined ? null : (
              <Text numberOfLines={1} style={styles.backLabel}>
                {props.backLabel}
              </Text>
            )}
          </Pressable>
        )}
      </View>
      <View style={styles.center}>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
          {props.title}
        </Text>
        {props.subtitle === undefined ? null : (
          <Text numberOfLines={1} style={styles.subtitle}>
            {props.subtitle}
          </Text>
        )}
      </View>
      <View style={[styles.side, styles.sideEnd]}>{props.trailing}</View>
    </View>
  );
}

export interface LargeTitleProps {
  readonly title: string;
  readonly trailing?: ReactNode;
}

/** A tab's root: a toolbar row for its actions, then the large title. */
export function LargeTitle(props: LargeTitleProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        toolbar: {
          minHeight: 44,
          marginTop: WEB_STATUS_ROOM,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: space.sm,
          paddingHorizontal: space.md,
        },
        title: {
          color: colors.textPrimary,
          fontSize: 32,
          fontWeight: "700",
          letterSpacing: -0.8,
          paddingHorizontal: space.md,
          marginBottom: space.sm,
        },
      }),
    [colors],
  );
  return (
    <View>
      <View style={styles.toolbar}>{props.trailing}</View>
      <Text accessibilityRole="header" style={styles.title}>
        {props.title}
      </Text>
    </View>
  );
}

/** A plain-glyph toolbar button in the accent, as system toolbars draw them. */
export function ToolbarButton(props: {
  readonly icon: MobileIconName;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={10}
      onPress={props.onPress}
      style={({ pressed }) => [styles.toolbarButton, pressed ? { opacity: 0.45 } : null]}
      testID={props.testID}
    >
      <Ionicons color={colors.accent} name={props.icon} size={23} />
    </Pressable>
  );
}

export interface ListSectionProps {
  readonly title?: string | undefined;
  /** A trailing action on the header row, such as "See all". */
  readonly action?: {
    readonly label: string;
    readonly onPress: () => void;
    readonly testID?: string;
  };
  readonly footer?: string | undefined;
  readonly children: ReactNode;
  readonly testID?: string;
}

/** An inset grouped section: a quiet header over one rounded group of rows. */
export function ListSection(props: ListSectionProps) {
  const { colors, surfaceStyle } = useTheme();
  const glass = surfaceStyle === "glass";
  const styles = useMemo(
    () =>
      StyleSheet.create({
        section: { marginBottom: space.lg },
        header: {
          flexDirection: "row",
          alignItems: "flex-end",
          justifyContent: "space-between",
          paddingHorizontal: space.md,
          marginBottom: 6,
        },
        title: {
          color: colors.textSecondary,
          fontSize: typography.section.fontSize,
          fontWeight: typography.section.fontWeight,
        },
        action: { color: colors.accent, fontSize: typography.detail.fontSize, fontWeight: "500" },
        group: {
          marginHorizontal: space.md,
          borderRadius: radii.md,
          overflow: "hidden",
          // On glass a grouped list lets the ground through like any panel.
          backgroundColor: glass ? colors.glassFillRegular : colors.surfaceElevatedSolid,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: glass ? colors.glassStroke : colors.hairline,
        },
        footer: {
          color: colors.textTertiary,
          fontSize: typography.meta.fontSize,
          lineHeight: 16,
          paddingHorizontal: space.md + space.md,
          marginTop: 6,
        },
      }),
    [colors, glass],
  );
  return (
    <View style={styles.section} testID={props.testID}>
      {props.title === undefined && props.action === undefined ? null : (
        <View style={styles.header}>
          <Text style={styles.title}>{props.title ?? ""}</Text>
          {props.action === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              hitSlop={12}
              onPress={props.action.onPress}
              testID={props.action.testID}
            >
              <Text style={styles.action}>{props.action.label}</Text>
            </Pressable>
          )}
        </View>
      )}
      <View style={styles.group}>{props.children}</View>
      {props.footer === undefined ? null : <Text style={styles.footer}>{props.footer}</Text>}
    </View>
  );
}

export interface ListRowProps {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly detailTone?: string | undefined;
  readonly icon?: MobileIconName;
  /** The icon's badge hue; without one the glyph sits bare in the secondary ink. */
  readonly iconTone?: string | undefined;
  /** Trailing text, such as a status or a count. */
  readonly value?: string | undefined;
  readonly valueTone?: string | undefined;
  readonly accessory?: "chevron" | "check" | "none";
  readonly labelTone?: string | undefined;
  readonly last?: boolean;
  readonly onPress?: (() => void) | undefined;
  readonly testID?: string | undefined;
  readonly accessibilityLabel?: string | undefined;
}

/** One row of a grouped list; its separator starts where its text does. */
export function ListRow(props: ListRowProps) {
  const { colors } = useTheme();
  const hasBadge = props.icon !== undefined && props.iconTone !== undefined;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          minHeight: props.detail === undefined ? 46 : 58,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: space.md,
        },
        pressed: { backgroundColor: colors.controlHover },
        badge: {
          width: 30,
          height: 30,
          borderRadius: 7,
          alignItems: "center",
          justifyContent: "center",
          marginRight: 12,
        },
        bareIcon: { width: 26, marginRight: 12, alignItems: "center" },
        main: {
          flex: 1,
          minHeight: props.detail === undefined ? 46 : 58,
          flexDirection: "row",
          alignItems: "center",
          paddingRight: space.md,
          gap: space.sm,
        },
        separator: {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.hairline,
        },
        text: { flex: 1, paddingVertical: 8, gap: 2 },
        label: {
          color: colors.textPrimary,
          fontSize: typography.rowLabel.fontSize,
          fontWeight: typography.rowLabel.fontWeight,
        },
        detail: { color: colors.textSecondary, fontSize: typography.detail.fontSize },
        value: {
          color: colors.textTertiary,
          fontSize: typography.detail.fontSize,
          fontVariant: ["tabular-nums"],
        },
      }),
    [colors, props.detail],
  );

  const body = (
    <>
      {props.icon === undefined ? null : hasBadge ? (
        <View style={[styles.badge, { backgroundColor: props.iconTone }]}>
          <Ionicons color={colors.primaryForeground} name={props.icon} size={17} />
        </View>
      ) : (
        <View style={styles.bareIcon}>
          <Ionicons color={colors.textSecondary} name={props.icon} size={20} />
        </View>
      )}
      <View style={[styles.main, props.last === true ? null : styles.separator]}>
        <View style={styles.text}>
          <Text
            numberOfLines={1}
            style={[
              styles.label,
              props.labelTone === undefined ? null : { color: props.labelTone },
            ]}
          >
            {props.label}
          </Text>
          {props.detail === undefined ? null : (
            <Text
              numberOfLines={1}
              style={[
                styles.detail,
                props.detailTone === undefined ? null : { color: props.detailTone },
              ]}
            >
              {props.detail}
            </Text>
          )}
        </View>
        {props.value === undefined ? null : (
          <Text
            style={[
              styles.value,
              props.valueTone === undefined ? null : { color: props.valueTone },
            ]}
          >
            {props.value}
          </Text>
        )}
        {props.accessory === "check" ? (
          <Ionicons color={colors.accent} name="checkmark" size={20} />
        ) : props.accessory === "none" || props.onPress === undefined ? null : (
          <Ionicons color={colors.textTertiary} name="chevron-forward" size={17} />
        )}
      </View>
    </>
  );

  if (props.onPress === undefined) {
    return (
      <View accessibilityLabel={props.accessibilityLabel} style={styles.row} testID={props.testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
      testID={props.testID}
    >
      {body}
    </Pressable>
  );
}

/** A sentence inside a group, for a state that needs more than a row's label. */
export function ListNote(props: {
  readonly text: string;
  readonly tone?: string | undefined;
  readonly last?: boolean;
  readonly testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        noteStyles.note,
        props.last === true
          ? null
          : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
      ]}
      testID={props.testID}
    >
      <Text style={[noteStyles.text, { color: props.tone ?? colors.textPrimary }]}>
        {props.text}
      </Text>
    </View>
  );
}

const noteStyles = StyleSheet.create({
  note: { marginLeft: space.md, paddingRight: space.md, paddingVertical: 12 },
  text: { fontSize: typography.detail.fontSize + 1, lineHeight: 20 },
});

export interface SegmentedControlProps<Id extends string> {
  readonly options: ReadonlyArray<{ readonly id: Id; readonly label: string }>;
  readonly selected: Id;
  readonly onSelect: (id: Id) => void;
  readonly testID?: string;
  readonly optionTestID?: (id: Id) => string;
}

/** The system segmented control: one track, the chosen segment raised. */
export function SegmentedControl<Id extends string>(props: SegmentedControlProps<Id>) {
  const { colors, scheme, surfaceStyle } = useTheme();
  const glass = surfaceStyle === "glass";
  const styles = useMemo(
    () =>
      StyleSheet.create({
        track: {
          flexDirection: "row",
          padding: 2,
          borderRadius: 9,
          backgroundColor: glass ? colors.glassFillThin : colors.control,
        },
        segment: {
          flex: 1,
          height: 30,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: space.sm,
          borderRadius: 7,
        },
        // In dark the raised fill matched the track, so the thumb takes the
        // strong border grey there, as the system's dark thumb is lighter.
        selected: {
          backgroundColor: glass
            ? colors.glassThumb
            : scheme === "dark"
              ? colors.hairlineStrong
              : colors.surfaceElevatedSolid,
          shadowColor: colors.shadow,
          shadowOpacity: 0.12,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        },
        label: { fontSize: typography.detail.fontSize, color: colors.textPrimary },
      }),
    [colors, glass, scheme],
  );
  return (
    <View accessibilityRole="tablist" style={styles.track} testID={props.testID}>
      {props.options.map((option) => {
        const selected = option.id === props.selected;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            hitSlop={{ top: 7, bottom: 7 }}
            key={option.id}
            onPress={() => props.onSelect(option.id)}
            style={[styles.segment, selected ? styles.selected : null]}
            testID={props.optionTestID?.(option.id)}
          >
            <Text
              numberOfLines={1}
              style={[styles.label, { fontWeight: selected ? "600" : "400" }]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  toolbarButton: {
    minWidth: 32,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
