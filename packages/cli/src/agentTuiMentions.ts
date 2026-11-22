export interface AgentFileMention {
  readonly start: number;
  readonly end: number;
  readonly path: string;
}

export function agentFileMentions(text: string): ReadonlyArray<AgentFileMention> {
  const mentions: AgentFileMention[] = [];
  for (const match of text.matchAll(/(^|\s)@("(?:\\.|[^"\\])*"|[^\s@#]+)/g)) {
    const leading = match[1] ?? "";
    const token = match[2] ?? "";
    let path = token;
    if (token.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(token);
        if (typeof parsed !== "string") continue;
        path = parsed;
      } catch {
        continue;
      }
    }
    const start = (match.index ?? 0) + leading.length;
    mentions.push({ start, end: start + token.length + 1, path });
  }
  return mentions;
}

export function completeAgentFileMention(path: string): string {
  return /[\s"\\]/.test(path) ? "@" + JSON.stringify(path) : "@" + path;
}
