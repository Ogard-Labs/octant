import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ChatMessagePart, ReplyDetailLevel } from "@octant/contracts";
import { radii, space, useTheme } from "../../design-system";
import { MessageActions, type MessageActionItem } from "./MessageActions";
import { MessageBlocks } from "./MessageBlocks";
import { resolveChatMessageParts } from "./messageDocument";
import { ReasoningPart } from "./ReasoningPart";
import { ToolActivity, type ToolCall } from "./ToolActivity";
import { mobileReplyDetailPresentation } from "./replyDetailPresentation";

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
  /** Fork from here and Rewind to here; shown under either role's message. */
  readonly turnActions?: ReadonlyArray<MessageActionItem>;
  /** The thread's Reply detail level; absent draws Low. */
  readonly replyDetail?: ReplyDetailLevel;
}

type DisplayPart =
  | Exclude<ChatMessagePart, { readonly kind: "tool" }>
  | { readonly kind: "tools"; readonly calls: ReadonlyArray<ToolCall> };

/** Joins consecutive tool calls so a run of them draws as one rail. */
function groupToolCalls(parts: ReadonlyArray<ChatMessagePart>): ReadonlyArray<DisplayPart> {
  const grouped: Array<DisplayPart> = [];
  for (const part of parts) {
    if (part.kind !== "tool") {
      grouped.push(part);
      continue;
    }
    const call = { name: part.name, status: part.status, summary: part.summary };
    const previous = grouped.at(-1);
    if (previous?.kind === "tools") {
      grouped[grouped.length - 1] = { kind: "tools", calls: [...previous.calls, call] };
    } else {
      grouped.push({ kind: "tools", calls: [call] });
    }
  }
  return grouped;
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
 * user = control-fill bubble; assistant = reasoning and tool rows, then bare prose.
 */
export function MessageBubble(props: MessageBubbleProps) {
  const { colors, surfaceStyle } = useTheme();
  const user = isUserRole(props.role);
  const research = isResearchRole(props.role);
  const showActions = props.showActions !== false && !user && !research;
  const parts = useMemo(
    () =>
      groupToolCalls(
        resolveChatMessageParts({
          role: props.role,
          body: props.body,
          ...(props.parts === undefined ? {} : { parts: props.parts }),
        }),
      ),
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
          maxWidth: "84%",
          borderRadius: radii.bubble,
          paddingHorizontal: 14,
          paddingVertical: 10,
        },
        // A person's message: the control fill and a hairline, no accent
        // (docs/design/thread-view.md › Transcript); the reply beside it is bare prose.
        bubbleUser: {
          // On glass the bubble takes the thin glass fill so the ground shows
          // through it like every other panel; flat keeps the control fill.
          backgroundColor: surfaceStyle === "glass" ? colors.glassFillRegular : colors.userBubble,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: surfaceStyle === "glass" ? colors.glassStrokeStrong : colors.hairline,
        },
        assistantStack: {
          width: "100%",
          gap: space.xs,
        },
      }),
    [colors, surfaceStyle],
  );

  if (user) {
    return (
      <View style={[styles.row, styles.rowUser]} testID={props.testID}>
        <View style={[styles.bubble, styles.bubbleUser]}>
          <MessageBlocks text={props.body} tone="user" />
        </View>
        {props.turnActions === undefined || props.turnActions.length === 0 ? null : (
          <MessageActions
            actions={props.turnActions}
            {...(props.testID === undefined ? {} : { testID: `${props.testID}-actions` })}
          />
        )}
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.rowAssistant]} testID={props.testID}>
      <View style={styles.assistantStack}>
        {parts.map((part, index) => {
          // The level is in the key so a change of level remounts each panel
          // at the new level, dropping a choice made by hand at the old one.
          const level = props.replyDetail ?? "low";
          const key = `${part.kind}:${index}:${level}`;
          if (part.kind === "reasoning") {
            const presentation = mobileReplyDetailPresentation(level, part.text);
            return (
              <ReasoningPart
                defaultExpanded={presentation.reasoningExpanded}
                key={key}
                preview={presentation.reasoningPreview}
                text={part.text}
              />
            );
          }
          if (part.kind === "tools") {
            const presentation = mobileReplyDetailPresentation(level, "");
            return (
              <ToolActivity
                calls={part.calls}
                defaultDetailOpen={presentation.toolDetailOpen}
                defaultOpen={presentation.toolCallsOpen}
                key={key}
              />
            );
          }
          return (
            <View
              key={key}
              {...(props.testID === undefined ? {} : { testID: `${props.testID}-prose` })}
            >
              <MessageBlocks text={part.text} tone="assistant" />
            </View>
          );
        })}
      </View>
      {showActions || (props.turnActions?.length ?? 0) > 0 ? (
        <MessageActions
          actions={[
            ...(showActions
              ? [
                  {
                    id: "copy",
                    label: "Copy",
                    icon: "copy-outline" as const,
                    onPress: async () => {
                      await Clipboard.setStringAsync(props.body);
                    },
                  },
                  ...(props.extraActions ?? []),
                ]
              : []),
            ...(props.turnActions ?? []),
          ]}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}-actions` })}
        />
      ) : null}
    </View>
  );
}
