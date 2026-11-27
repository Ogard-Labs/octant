import { useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Icon } from "./Icon";
import { fonts, radii, space, typography, useTheme } from "../../design-system";
import { parseMarkdownBlocks, type MarkdownBlock } from "./messageDocument";
import { grammarForFence } from "./codeHighlight";
import { HighlightedCode } from "./HighlightedCode";
import { useCodeHighlight } from "./useCodeHighlight";

export interface MessageBlocksProps {
  readonly text: string;
  readonly tone: "user" | "assistant";
  readonly testID?: string;
}

function useBlockStyles(tone: MessageBlocksProps["tone"]) {
  const { colors } = useTheme();
  const user = tone === "user";
  const textColor = user ? colors.userBubbleText : colors.textPrimary;
  const muted = user ? colors.onBubbleMuted : colors.textSecondary;
  const codeBg = user ? colors.onBubbleFill : colors.surfaceSolid;
  const codeBorder = user ? colors.onBubbleStroke : colors.glassStroke;

  return useMemo(
    () =>
      StyleSheet.create({
        stack: { gap: space.sm },
        paragraph: {
          color: textColor,
          fontSize: typography.body.fontSize,
          lineHeight: 22,
        },
        heading: {
          color: textColor,
          fontWeight: "600",
          letterSpacing: -0.2,
          marginTop: 2,
        },
        listItem: {
          color: textColor,
          fontSize: typography.body.fontSize,
          lineHeight: 22,
        },
        codeWrap: {
          borderRadius: radii.sm,
          backgroundColor: codeBg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: codeBorder,
          overflow: "hidden",
        },
        codeHeader: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm,
          paddingVertical: 6,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: codeBorder,
          gap: space.sm,
        },
        codeLang: {
          flex: 1,
          color: muted,
          fontSize: 13,
          fontWeight: "500",
          fontFamily: fonts.mono,
          textTransform: "lowercase",
        },
        codeBody: {
          color: textColor,
          fontFamily: fonts.mono,
          fontSize: 13,
          lineHeight: 22,
          padding: space.sm,
        },
        inlineCode: {
          fontFamily: fonts.mono,
          fontSize: typography.mono.fontSize + 1,
          color: textColor,
          backgroundColor: user ? colors.onBubbleFill : colors.primarySoft,
          borderRadius: 4,
        },
      }),
    [codeBg, codeBorder, muted, textColor],
  );
}

/** Paragraphs, headings, lists and code without a native Markdown renderer. */
export function PlainBlocks(props: MessageBlocksProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(props.text), [props.text]);
  const styles = useBlockStyles(props.tone);

  return (
    <View style={styles.stack} testID={props.testID ?? "mobile-message-blocks"}>
      {blocks.map((block, index) => (
        <BlockView block={block} key={`${block.type}:${index}`} styles={styles} tone={props.tone} />
      ))}
    </View>
  );
}

function CodeBlock(props: {
  readonly code: string;
  readonly language?: string | undefined;
  readonly styles: ReturnType<typeof useBlockStyles>;
  /** Syntax colours are for the reply's ground; a person's bubble has its own fill. */
  readonly colours: boolean;
}) {
  const { colors } = useTheme();
  const { styles } = props;
  const lines = useCodeHighlight(
    props.code,
    props.colours ? grammarForFence(props.language) : undefined,
  );
  return (
    <View style={styles.codeWrap} testID="mobile-message-code-block">
      <View style={styles.codeHeader}>
        <Text style={styles.codeLang}>{props.language ?? "code"}</Text>
        <Pressable
          accessibilityLabel="Copy code"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            void Clipboard.setStringAsync(props.code);
          }}
          testID="mobile-message-code-copy"
        >
          <Icon color={colors.textTertiary} name="copy-outline" size={14} />
        </Pressable>
      </View>
      {/* Long lines scroll; wrapped code reads as other code. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <HighlightedCode code={props.code} lines={lines} selectable style={styles.codeBody} />
      </ScrollView>
    </View>
  );
}

/** A reply's code, in the block every surface draws it in. */
export function ReplyCode(props: { readonly code: string; readonly language?: string }) {
  return <CodeBlock {...props} colours styles={useBlockStyles("assistant")} />;
}

function BlockView(props: {
  readonly block: MarkdownBlock;
  readonly styles: ReturnType<typeof useBlockStyles>;
  readonly tone: MessageBlocksProps["tone"];
}) {
  const { block, styles } = props;
  switch (block.type) {
    case "heading":
      return (
        <Text
          style={[
            styles.heading,
            // Headings inside a reply are labels, not page titles (docs/design/thread-view.md › Transcript).
            { fontSize: block.level === 1 ? 17 : 15 },
          ]}
        >
          {block.text}
        </Text>
      );
    case "list":
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, index) => (
            <Text key={`${index}:${item.slice(0, 12)}`} style={styles.listItem}>
              {block.ordered ? `${index + 1}. ` : "• "}
              {item}
            </Text>
          ))}
        </View>
      );
    case "code":
      return (
        <CodeBlock
          code={block.code}
          colours={props.tone === "assistant"}
          language={block.language}
          styles={styles}
        />
      );
    case "paragraph":
      return <Text style={styles.paragraph}>{renderInline(block.text, styles.inlineCode)}</Text>;
  }
}

function renderInline(text: string, inlineCodeStyle: object): ReactNode {
  const chunks = text.split(/(`[^`]+`)/g);
  if (chunks.length === 1) return text;
  return chunks.map((chunk, index) => {
    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 2) {
      return (
        <Text key={`c:${index}`} style={inlineCodeStyle}>
          {chunk.slice(1, -1)}
        </Text>
      );
    }
    return <Text key={`t:${index}`}>{chunk}</Text>;
  });
}
