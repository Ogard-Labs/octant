/**
 * A credential's label and what joins it to its value (`password:`, `"token": `,
 * `DB_PASSWORD=`, `the passphrase is`, `secret - `). The label may end a longer
 * name and be marked up or quoted. The shared secret shapes name only some of
 * these and take one word.
 */
const LABEL =
  /(?:password|passwd|passphrase|pwd|secret|credential|api[_ -]?key|token)s?["'`*_]{0,3}(?:[ \t]*[:=\uff1a]|[ \t]+(?:is|are)\b|[ \t]+[-\u2013\u2014](?=[ \t]))/gi;

const FENCES = ["```", '"""', "'''"];
const QUOTED: Readonly<Record<string, RegExp>> = {
  '"': /"(?:\\[\s\S]|[^"\\])*"/y,
  "'": /'(?:\\[\s\S]|[^'\\])*'/y,
  "`": /`(?:\\[\s\S]|[^`\\])*`/y,
};
const GAP = /[ \t]*(?:\r?\n[ \t]*)?/y;
const CLOSING_MARKUP = /[*_]{1,3}(?=\s)/y;
const BLOCK_MARK = /[|>][-+\d]{0,2}[ \t]*(?=\r?\n)/y;
const INDENTED_LINES = /(?:\r?\n(?:[ \t]+[^\n]*|[ \t]*(?=\r?\n)))+/y;
const JOINED = /\S*/y;

/**
 * Replaces every labelled credential with its whole value. Each label's value is
 * found on its own, also inside another's, so a value that ends in doubt can
 * never hide the next label from this. Where the end is not certain the rule
 * takes more, never less: what it costs is a line memory does not learn.
 */
export function redactLabelledCredentials(text: string): string {
  let redacted = "";
  let kept = 0;
  let start = -1;
  let end = -1;
  const ends = runEnds(text);
  const close = () => {
    if (start < 0) return;
    redacted += `${text.slice(kept, start)}[redacted]`;
    kept = end;
  };
  for (const match of text.matchAll(LABEL)) {
    if (namesTheProduct(text, match)) continue;
    const valueEnd = credentialValueEnd(text, match.index + match[0].length, ends);
    if (match.index > end) {
      close();
      start = match.index;
      end = valueEnd;
    } else end = Math.max(end, valueEnd);
    if (end >= text.length) break;
  }
  close();
  return redacted + text.slice(kept);
}

/** "1Password: …" is about the password manager; `1password=` is a field. */
function namesTheProduct(text: string, match: RegExpExecArray): boolean {
  return (
    /^Password[^=]*$/.test(match[0]) &&
    text[match.index - 1] === "1" &&
    !/\w/.test(text[match.index - 2] ?? " ")
  );
}

/**
 * The ends of a line, an indented block and a run without spaces. Any two
 * places in the same one end together, so a message full of labels is not read
 * to its end once for each.
 */
function runEnds(text: string) {
  const remembered = (find: (from: number) => number | undefined) => {
    let first = -1;
    let last = -1;
    return (from: number): number | undefined => {
      if (from >= first && from < last) return last;
      const found = find(from);
      if (found !== undefined) {
        first = from;
        last = found;
      }
      return found;
    };
  };
  return {
    line: remembered((from) => lineEnd(text, from)),
    joined: remembered((from) => matchAt(JOINED, text, from)),
    block: remembered((from) => matchAt(INDENTED_LINES, text, from)),
  };
}

function credentialValueEnd(text: string, from: number, ends: ReturnType<typeof runEnds>): number {
  // What is joined to a closing quote is still the value.
  const joined = (closing: number) => ends.joined(closing) ?? closing;
  const markup = matchAt(CLOSING_MARKUP, text, from);
  const at = matchAt(GAP, text, markup ?? from) ?? from;
  if (markup !== undefined) return ends.line(at) ?? text.length;
  const fence = FENCES.find((each) => text.startsWith(each, at));
  if (fence !== undefined) {
    const closing = text.indexOf(fence, at + fence.length);
    return closing < 0 ? text.length : joined(closing + fence.length);
  }
  const quoted = QUOTED[text[at] ?? ""];
  if (quoted !== undefined) {
    const closing = matchAt(quoted, text, at);
    return closing === undefined ? text.length : joined(closing);
  }
  const block = matchAt(BLOCK_MARK, text, at);
  return (block === undefined ? undefined : ends.block(block)) ?? ends.line(at) ?? text.length;
}

/** Where `pattern`, which is sticky, stops when it matches at `from`. */
function matchAt(pattern: RegExp, text: string, from: number): number | undefined {
  pattern.lastIndex = from;
  return pattern.test(text) ? pattern.lastIndex : undefined;
}

/** The end of the line, and of the next while a backslash ends it. */
function lineEnd(text: string, from: number): number {
  for (let at = from; ;) {
    const newline = text.indexOf("\n", at);
    if (newline < 0) return text.length;
    if (text[newline - 1] !== "\\" && text.slice(newline - 2, newline) !== "\\\r") return newline;
    at = newline + 1;
  }
}
