import { useEffect, useRef, useState } from "react";

export interface ComposerTipContext {
  readonly scopeKey: string;
  readonly files?: boolean;
  readonly threads?: boolean;
  readonly commands?: boolean;
  readonly browser?: boolean;
  readonly computer?: boolean;
  readonly plan?: boolean;
}

const TIPS = [
  { id: "newline", text: "Tip: Use Shift+Enter to add a new line." },
  { id: "send", text: "Tip: Press Enter to send your message." },
  { id: "files", text: "Tip: Type @ to include a file from your checkout." },
  { id: "threads", text: "Tip: Type # to bring another thread into context." },
  { id: "commands", text: "Tip: Type / to find available commands." },
  { id: "browser", text: "Tip: Mention @Browser to use Octant’s built-in browser." },
  { id: "computer", text: "Tip: Mention @Computer to work with an app on your desktop." },
  { id: "plan", text: "Tip: Choose Plan for read-only exploration before making changes." },
] as const;

// Session-local discovery order. Advance on a composer visit, never on a timer
// or during render; Strict Mode's effect replay must not count as another visit.
let nextTip = 0;
let lastTip: string | undefined;

export function useComposerTip(context: ComposerTipContext): string {
  const eligible = TIPS.filter((tip) =>
    tip.id === "newline" || tip.id === "send" ? true : context[tip.id] === true,
  );
  const eligibleIds = eligible.map((tip) => tip.id).join(",");
  const [selected, setSelected] = useState<string>();
  const visit = useRef<{ scopeKey: string; tip: string } | undefined>(undefined);
  const { scopeKey } = context;

  useEffect(() => {
    const ids = eligibleIds.split(",");
    if (visit.current?.scopeKey === scopeKey && ids.includes(visit.current.tip)) return;
    let id = ids[nextTip % ids.length] ?? "newline";
    nextTip += 1;
    if (id === lastTip) {
      id = ids[nextTip % ids.length] ?? "send";
      nextTip += 1;
    }
    lastTip = id;
    visit.current = { scopeKey, tip: id };
    setSelected(id);
  }, [scopeKey, eligibleIds]);

  return eligible.find((tip) => tip.id === selected)?.text ?? TIPS[0].text;
}
