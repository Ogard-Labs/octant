/** Format pipe tables before styling. Fences remain literal and escaped pipes stay in cells. */
export function terminalMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let fenced = false;
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, "│"));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) fenced = !fenced;
    const separator = lines[i + 1];
    if (
      !fenced &&
      line.includes("|") &&
      separator !== undefined &&
      cells(separator).every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      const rows = [cells(line)];
      i += 1;
      for (;;) {
        const next = lines[i + 1];
        if (next === undefined || !next.includes("|") || next.trim().length === 0) break;
        i += 1;
        rows.push(cells(next));
      }
      const widths = (rows[0] ?? []).map((_, column) =>
        Math.min(36, Math.max(...rows.map((row) => Array.from(row[column] ?? "").length))),
      );
      const rule = (left: string, mid: string, right: string) =>
        left + widths.map((width) => "─".repeat(width + 2)).join(mid) + right;
      result.push(rule("┌", "┬", "┐"));
      rows.forEach((row, index) => {
        result.push(
          "│" +
            widths
              .map((width, column) => {
                const chars = Array.from(row[column] ?? "");
                const value =
                  chars.length > width
                    ? chars.slice(0, Math.max(0, width - 1)).join("") + "…"
                    : chars.join("");
                return (
                  " " + value + " ".repeat(Math.max(0, width - Array.from(value).length)) + " "
                );
              })
              .join("│") +
            "│",
        );
        if (index === 0) result.push(rule("├", "┼", "┤"));
      });
      result.push(rule("└", "┴", "┘"));
    } else result.push(line);
  }
  return result.join("\n");
}

/** One native span per continuous style, rather than one span per source line. */
export function compactTextChunks(
  chunks: readonly import("@opentui/core").TextChunk[],
): import("@opentui/core").TextChunk[] {
  const result: import("@opentui/core").TextChunk[] = [];
  for (const chunk of chunks) {
    const previous = result.at(-1);
    if (
      previous !== undefined &&
      previous.attributes === chunk.attributes &&
      previous.link?.url === chunk.link?.url &&
      (previous.fg?.equals(chunk.fg) ?? chunk.fg === undefined) &&
      (previous.bg?.equals(chunk.bg) ?? chunk.bg === undefined)
    )
      previous.text += chunk.text;
    else result.push({ ...chunk });
  }
  return result;
}
