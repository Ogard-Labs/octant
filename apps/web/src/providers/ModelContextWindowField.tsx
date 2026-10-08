import type { ProviderModel } from "@octant/contracts";
import { resolveModelContextWindow } from "@octant/domain/model-context-window";
import { useEffect, useRef, useState } from "react";
import { contextWindowSourceLabel } from "../context/contextInspectorModel";
import { OctantInput } from "../ui/base/OctantInput";

/**
 * A model's optional context window override. Octant finds the window on its
 * own, so the box starts empty and its placeholder says what was found and
 * where from; a number typed in wins over every automatic source, and clearing
 * it returns to automatic resolution. It is saved when the person leaves the
 * box or presses Enter, never prompted for.
 */
export function ModelContextWindowField(props: {
  readonly model: ProviderModel;
  readonly disabled: boolean;
  readonly onChange: (contextWindow: number | undefined) => Promise<boolean>;
}) {
  const saved = props.model.contextWindowOverride;
  const [draft, setDraft] = useState(saved === undefined ? "" : String(saved));
  // Enter and the blur that follows it are one edit, sent once.
  const sent = useRef(saved);
  useEffect(() => {
    sent.current = saved;
    setDraft(saved === undefined ? "" : String(saved));
  }, [saved]);
  const { contextWindowOverride: _override, ...automatic } = props.model;
  const resolved = resolveModelContextWindow(automatic);
  const placeholder =
    resolved === undefined
      ? `Automatic · ${contextWindowSourceLabel("conservative-fallback")}`
      : `${resolved.contextWindow.toLocaleString("en-US")} · ${contextWindowSourceLabel(resolved.source)}`;

  const commit = () => {
    const digits = draft.replaceAll(/[\s,_]/g, "");
    const next = digits === "" ? undefined : Number(digits);
    if (next !== undefined && (!Number.isSafeInteger(next) || next <= 0)) {
      setDraft(saved === undefined ? "" : String(saved));
      return;
    }
    if (next === sent.current) return;
    sent.current = next;
    void props.onChange(next);
  };

  return (
    <OctantInput
      aria-label={`Context window for ${props.model.displayName}`}
      className="provider-model-visibility__context-window"
      disabled={props.disabled}
      inputMode="numeric"
      onBlur={commit}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      placeholder={placeholder}
      title="Context window in tokens. Leave empty to let Octant find it."
      value={draft}
    />
  );
}
