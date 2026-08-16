import { useMemo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, space, typography, useTheme } from "../../design-system";
import { MOBILE_COPY } from "../copy";
import { BottomSheet } from "../ui/BottomSheet";
import { IconButton, type MobileIconName } from "../ui/IconButton";
import type { MobileCreateMode } from "./createModePresentation";

const MOBILE_CREATE_MODES: ReadonlyArray<{
  readonly id: MobileCreateMode;
  readonly label: string;
  readonly icon: MobileIconName;
}> = [
  { id: "chat", label: "Chat", icon: "chatbubble-outline" },
  { id: "work", label: "Work", icon: "folder-outline" },
  { id: "code", label: "Code", icon: "code-slash" },
];

function placeholderFor(mode: MobileCreateMode): string {
  if (mode === "work") return MOBILE_COPY.composerWork;
  if (mode === "code") return MOBILE_COPY.composerCode;
  return MOBILE_COPY.composerHome;
}

export function HomeComposerSheet(props: {
  readonly visible: boolean;
  readonly mode: MobileCreateMode;
  readonly prompt: string;
  readonly modelLabel: string;
  readonly placementLabel?: string | undefined;
  readonly projectLabel?: string | undefined;
  readonly busy?: boolean;
  readonly editable?: boolean;
  readonly error?: string | undefined;
  readonly availableModes?: ReadonlyArray<MobileCreateMode> | undefined;
  readonly onChangePrompt: (value: string) => void;
  readonly onClose: () => void;
  readonly onPressModel: () => void;
  readonly onSelectMode: (mode: MobileCreateMode) => void;
  readonly onSubmit: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        sheet: {
          marginHorizontal: space.sm,
          marginBottom: process.env.EXPO_OS === "web" ? 48 : space.sm,
          borderBottomLeftRadius: radii.composer,
          borderBottomRightRadius: radii.composer,
        },
        content: {
          minHeight: 380,
          paddingHorizontal: space.md,
          paddingBottom: space.md,
          gap: space.md,
        },
        modes: {
          alignSelf: "flex-start",
          flexDirection: "row",
          padding: 3,
          gap: 2,
          borderRadius: radii.pill,
          backgroundColor: colors.glassFillThin,
        },
        mode: {
          minHeight: 34,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          paddingHorizontal: space.sm,
          borderRadius: radii.pill,
        },
        modeSelected: { backgroundColor: colors.glassFillThick },
        modeLabel: {
          color: colors.textTertiary,
          fontSize: typography.caption.fontSize,
          fontWeight: "600",
        },
        modeLabelSelected: { color: colors.textPrimary },
        context: { flexDirection: "row", alignItems: "center", gap: space.sm },
        contextItem: { flexDirection: "row", alignItems: "center", gap: 5 },
        contextText: {
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          fontWeight: "500",
        },
        input: {
          flex: 1,
          minHeight: 120,
          color: colors.textPrimary,
          fontSize: 18,
          lineHeight: 25,
          textAlignVertical: "top",
          outlineColor: "transparent",
          outlineStyle: "solid",
          outlineWidth: 0,
        },
        error: { color: colors.danger, fontSize: typography.caption.fontSize, lineHeight: 18 },
        toolbar: { flexDirection: "row", alignItems: "center", gap: space.sm },
        model: {
          flex: 1,
          minHeight: 46,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: space.md,
          borderRadius: radii.pill,
        },
        modelPressed: { backgroundColor: colors.glassFillThin },
        modelText: {
          flex: 1,
          color: colors.textPrimary,
          fontSize: typography.body.fontSize,
          fontWeight: "600",
        },
      }),
    [colors],
  );

  const editable = props.editable !== false && props.busy !== true;
  const canSubmit = editable && props.prompt.trim().length > 0;
  const availableModes = MOBILE_CREATE_MODES.filter(
    (mode) => props.availableModes === undefined || props.availableModes.includes(mode.id),
  );
  const projectLabel =
    props.mode === "chat" ? "New conversation" : (props.projectLabel ?? "Choose on host");

  return (
    <BottomSheet
      contentStyle={styles.content}
      headerVisible={false}
      onClose={props.onClose}
      sheetStyle={styles.sheet}
      testID="mobile-home-composer-sheet"
      title="New thread"
      visible={props.visible}
    >
      {availableModes.length > 1 ? (
        <View accessibilityRole="tablist" style={styles.modes}>
          {availableModes.map((mode) => {
            const selected = props.mode === mode.id;
            return (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                key={mode.id}
                onPress={() => props.onSelectMode(mode.id)}
                style={[styles.mode, selected ? styles.modeSelected : null]}
                testID={`mobile-home-composer-mode-${mode.id}`}
              >
                <Ionicons
                  color={selected ? colors.textPrimary : colors.textTertiary}
                  name={mode.icon}
                  size={14}
                />
                <Text style={[styles.modeLabel, selected ? styles.modeLabelSelected : null]}>
                  {mode.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.context}>
        <View style={styles.contextItem}>
          <Ionicons
            color={colors.textTertiary}
            name={
              props.mode === "code"
                ? "git-branch-outline"
                : props.mode === "work"
                  ? "folder-outline"
                  : "chatbubble-outline"
            }
            size={16}
          />
          <Text numberOfLines={1} style={styles.contextText}>
            {projectLabel}
          </Text>
        </View>
        <View style={styles.contextItem}>
          <Ionicons color={colors.textTertiary} name="cloud-outline" size={16} />
          <Text numberOfLines={1} style={styles.contextText}>
            {props.placementLabel ?? "No host"}
          </Text>
        </View>
      </View>

      <TextInput
        autoFocus
        editable={editable}
        multiline
        onChangeText={props.onChangePrompt}
        placeholder={placeholderFor(props.mode)}
        placeholderTextColor={colors.textTertiary}
        style={styles.input}
        testID="mobile-home-composer-input"
        value={props.prompt}
      />

      {props.error === undefined ? null : (
        <Text selectable style={styles.error}>
          {props.error}
        </Text>
      )}

      <View style={styles.toolbar}>
        <IconButton accessibilityLabel="Attachments unavailable" disabled name="add" size={46} />
        <Pressable
          accessibilityLabel={`Choose model, ${props.modelLabel}`}
          accessibilityRole="button"
          onPress={props.onPressModel}
          style={({ pressed }) => [styles.model, pressed ? styles.modelPressed : null]}
          testID="mobile-home-composer-model"
        >
          <Text numberOfLines={1} style={styles.modelText}>
            {props.modelLabel}
          </Text>
          <Ionicons color={colors.textSecondary} name="chevron-down" size={16} />
        </Pressable>
        <IconButton
          accessibilityLabel="Voice input unavailable"
          disabled
          name="mic-outline"
          size={46}
        />
        <IconButton
          accessibilityLabel={props.busy === true ? "Creating" : "Send"}
          disabled={!canSubmit}
          name={props.busy === true ? "hourglass-outline" : "arrow-up"}
          onPress={props.onSubmit}
          size={46}
          testID="mobile-home-composer-submit"
          variant="send"
        />
      </View>
    </BottomSheet>
  );
}
