import { threadRowShortAge } from "../projects/threadRowShortAge";
import { OctantButton } from "../ui/base/OctantButton";
import type { ComposerNoticeItem } from "./ComposerNotice";

/**
 * "Settled 19m ago" with Un-settle, above a settled thread's composer in
 * every mode. A settled thread is closed out, by the person or because its
 * agent finished; it stays readable and a new message brings it back, so the
 * notice says when it settled and offers the one-click way back.
 */
export function settledThreadNotice(input: {
  readonly settledAt: string | undefined;
  readonly busy?: boolean;
  readonly onUnsettle: (() => void) | undefined;
  readonly now?: number;
}): ComposerNoticeItem | undefined {
  if (input.settledAt === undefined) return undefined;
  const age = threadRowShortAge(input.settledAt, input.now);
  return {
    key: "settled",
    tone: "neutral",
    text: age === undefined || age === "now" ? "Settled just now" : `Settled ${age} ago`,
    ...(input.onUnsettle === undefined
      ? {}
      : {
          action: (
            <OctantButton
              disabled={input.busy === true}
              onClick={input.onUnsettle}
              size="sm"
              type="button"
            >
              Un-settle
            </OctantButton>
          ),
        }),
  };
}
