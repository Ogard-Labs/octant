import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ChatMessagePart } from "@octant/contracts";
import { GlassSurface, radii, space, useTheme } from "../../design-system";
import { MessageActions, type MessageActionItem } from "./MessageActions";
import { MessageBlocks } from "./MessageBlocks";
import { resolveChatMessageParts } from "./messageDocument";
import { ReasoningPart } from "./ReasoningPart";
import { ToolPartCard } from "./ToolPartCard";

export interface MessageBubbleProps {
  readonly role: string;
  readonly body: string;
  /** Structured parts from host when present (preferred over body fences). */
  readonly parts?: ReadonlyArray<ChatMessagePart>;
  readonly testID?: string;
  /** Show actions under assistant messages. Default true. */
  readonly showActions?: boolean;
  /** Extra actions (e.g. Retry) appended after Copy. */
  readonly extraActions?: ReadonlyArray<MessageActionItem>;
}

function isUserRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower === "user" || lower === "human";
}

function isResearchRole(role: string): boolean {
  return role.toLowerCase() === "research";
}

/**
 * Conversation-first message presentation on Distilled glass or flat surfaces:
 * user = solid ink bubble; assistant = reasoning + tool cards + markdown blocks.
 */
export function MessageBubble(props: MessageBubbleProps) {
  const { colors } = useTheme();
  const user = isUserRole(props.role);
  const research = isResearchRole(props.role);
  const showActions = props.showActions !== false && !user && !research;
  const parts = useMemo(
    () =>
      resolveChatMessageParts({
        role: props.role,
        body: props.body,
        ...(props.parts === undefined ? {} : { parts: props.parts }),
      }),
    [props.body, props.parts, props.role],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          width: "100%",
          marginBottom: space.xs,
        },
        rowUser: { alignItems: "flex-end" },
        rowAssistant: { alignItems: "stretch" },
        bubble: {
          maxWidth: "88%",
          borderRadius: radii.bubble,
          paddingHorizontal: space.md,
          paddingVertical: 12,
        },
        bubbleUser: {
          backgroundColor: colors.userBubble,
          borderBottomRightRadius: 8,
        },
        assistantStack: {
          width: "100%",
          gap: space.sm,
        },
        assistantPad: {
          paddingHorizontal: space.md,
          paddingVertical: 12,
        },
      }),
    [colors],
  );

  if (user) {
    return (
      <View style={[styles.row, styles.rowUser]} testID={props.testID}>
        <View style={[styles.bubble, styles.bubbleUser]}>
          <MessageBlocks text={props.body} tone="user" />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.rowAssistant]} testID={props.testID}>
      <View style={styles.assistantStack}>
        {parts.map((part, index) => {
          const key = `${part.kind}:${index}`;
          if (part.kind === "reasoning") {
            return <ReasoningPart key={key} text={part.text} />;
          }
          if (part.kind === "tool") {
            return (
              <ToolPartCard
                key={key}
                name={part.name}
                status={part.status}
                summary={part.summary}
              />
            );
          }
          return (
            <GlassSurface
              contentStyle={styles.assistantPad}
              key={key}
              material="thin"
              radius={radii.md}
              {...(props.testID === undefined ? {} : { testID: `${props.testID}-glass` })}
            >
              <MessageBlocks text={part.text} tone="assistant" />
            </GlassSurface>
          );
        })}
      </View>
      {showActions ? (
        <MessageActions
          actions={[
            {
              id: "copy",
              label: "Copy",
              icon: "copy-outline",
              onPress: async () => {
                await Clipboard.setStringAsync(props.body);
              },
            },
            ...(props.extraActions ?? []),
          ]}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}-actions` })}
        />
      ) : null}
    </View>
  );
}
