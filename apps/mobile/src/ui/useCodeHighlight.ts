import { useEffect, useState } from "react";
import { useTheme } from "../../design-system";
import { highlightCode, type CodeTokenLines } from "./codeHighlight";

/**
 * While a reply streams, its code grows every few characters; colouring it
 * again on each one would tokenize the whole block per character.
 */
const SETTLE_MS = 120;

/**
 * The coloured lines last worked out for `code`. While a block is still
 * growing they cover only an earlier copy of it, so the caller draws them as
 * far as they still match and the rest plain (`HighlightedCode`).
 */
export function useCodeHighlight(
  code: string,
  grammar: string | undefined,
): CodeTokenLines | undefined {
  const { scheme } = useTheme();
  const [lines, setLines] = useState<CodeTokenLines | undefined>(undefined);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void highlightCode(code, grammar, scheme).then((result) => {
        if (current) setLines(result.status === "highlighted" ? result.lines : undefined);
      });
    }, SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [code, grammar, scheme]);
  return lines;
}
