import type { ProviderSlashCommand } from "@octant/contracts";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { radii, space, typography, useTheme } from "../../design-system";
import { hapticSelect } from "./haptics";
import { matchingSlashCommands, slashCommandQuery } from "./slashCommands";

export interface SlashCommandSuggestionsProps {
  /** What the draft says so far. */
  readonly draft: string;
  /** The commands the chosen model's provider account lists; none offers nothing. */
  readonly commands: ReadonlyArray<ProviderSlashCommand> | undefined;
  /** The provider account's name, so a row says whose command it is. */
  readonly providerLabel: string;
  /** Choosing a command writes `/name ` as the whole draft. */
  readonly onChoose: (draft: string) => void;
}

/**
 * The provider's own commands while a message begins with `/`. The row writes
 * `/name ` and the provider runs it as the prompt; the draft then holds a space
 * after the name, which ends the list.
 */
export function SlashCommandSuggestions(props: SlashCommandSuggestionsProps) {
  const { colors } = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        list: {
          marginBottom: space.xs,
          borderRadius: radii.lg,
          overflow: "hidden",
          backgroundColor: colors.glassFillThin,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.glassStroke,
        },
        row: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 },
        pressed: { backgroundColor: colors.controlHover },
        name: { color: colors.textPrimary, fontSize: typography.body.fontSize, fontWeight: "500" },
        detail: { color: colors.textSecondary, fontSize: typography.caption.fontSize },
      }),
    [colors],
  );

  const query = slashCommandQuery(props.draft);
  if (query === undefined || props.commands === undefined) return null;
  const matches = matchingSlashCommands(props.commands, query);
  if (matches.length === 0) return null;

  return (
    <View style={styles.list} testID="mobile-slash-suggestions">
      {matches.map((command) => {
        const owner = props.providerLabel.length === 0 ? undefined : `${props.providerLabel}'s own`;
        const detail = [owner, command.argumentHint, command.description]
          .filter((part) => part !== undefined && part.length > 0)
          .join(" · ");
        return (
          <Pressable
            accessibilityLabel={`/${command.name}, ${detail}`}
            accessibilityRole="button"
            key={command.name}
            onPress={() => {
              hapticSelect();
              props.onChoose(`/${command.name} `);
            }}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`mobile-slash-${command.name}`}
          >
            <Text numberOfLines={1} style={styles.name}>{`/${command.name}`}</Text>
            <Text numberOfLines={2} style={styles.detail}>
              {detail}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
