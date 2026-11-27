import { Fragment, useMemo } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import type { CodeToken, CodeTokenLines } from "./codeHighlight";

/**
 * The runs of `lines` that still spell the start of `code`, then whatever
 * follows plain: a streaming block keeps its colours for what was already
 * worked out instead of dropping back to plain text on every new character.
 */
export function matchingRuns(
  code: string,
  lines: CodeTokenLines | undefined,
): { readonly runs: ReadonlyArray<CodeToken>; readonly rest: string } {
  if (lines === undefined) return { runs: [], rest: code };
  const runs: CodeToken[] = [];
  let at = 0;
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      if (code[at] !== "\n") return { runs, rest: code.slice(at) };
      runs.push({ text: "\n" });
      at += 1;
    }
    for (const token of line) {
      if (!code.startsWith(token.text, at)) return { runs, rest: code.slice(at) };
      runs.push(token);
      at += token.text.length;
    }
  }
  return { runs, rest: code.slice(at) };
}

/** Code as one selectable text, coloured where its runs are known. */
export function HighlightedCode(props: {
  readonly code: string;
  readonly lines: CodeTokenLines | undefined;
  readonly style: StyleProp<TextStyle>;
  readonly selectable?: boolean;
}) {
  const { runs, rest } = useMemo(
    () => matchingRuns(props.code, props.lines),
    [props.code, props.lines],
  );
  return (
    <Text selectable={props.selectable} style={props.style}>
      {runs.map((run, index) =>
        run.color === undefined && run.italic !== true && run.bold !== true ? (
          <Fragment key={index}>{run.text}</Fragment>
        ) : (
          <Text
            key={index}
            style={{
              ...(run.color === undefined ? {} : { color: run.color }),
              ...(run.italic === true ? { fontStyle: "italic" } : {}),
              ...(run.bold === true ? { fontWeight: "600" } : {}),
            }}
          >
            {run.text}
          </Text>
        ),
      )}
      {rest}
    </Text>
  );
}
