import type { ReactNode } from "react";
import type { GuidedTourPictureId } from "./guidedTourSteps";

/**
 * A small picture of a feature, drawn from the parts the interface is made of:
 * rows, chips, a pill and a few lines. It is decoration, so it is hidden from
 * assistive technology; the step's title and body carry the meaning. Colour
 * comes from the stylesheet's classes, so it follows the theme.
 */
export function GuidedTourPicture(props: { readonly id: GuidedTourPictureId }) {
  return (
    <svg
      aria-hidden="true"
      className="guided-tour__picture-art"
      focusable="false"
      viewBox="0 0 300 112"
    >
      {PICTURES[props.id]}
    </svg>
  );
}

const PICTURES: Record<GuidedTourPictureId, ReactNode> = {
  "new-thread": (
    <>
      <rect className="gt-fill gt-strong" height="26" rx="8" width="84" x="108" y="14" />
      <rect className="gt-on-strong" height="5" rx="2.5" width="40" x="130" y="24.5" />
      <rect className="gt-line" height="26" rx="8" width="58" x="64" y="52" />
      <rect className="gt-fill gt-accent-soft" height="26" rx="8" width="58" x="128" y="52" />
      <rect className="gt-line" height="26" rx="8" width="58" x="192" y="52" />
      <rect className="gt-text" height="4" rx="2" width="26" x="80" y="63" />
      <rect className="gt-text gt-accent" height="4" rx="2" width="26" x="144" y="63" />
      <rect className="gt-text" height="4" rx="2" width="26" x="208" y="63" />
      <rect className="gt-line" height="20" rx="8" width="172" x="64" y="86" />
      <circle className="gt-fill gt-accent" cx="78" cy="96" r="3.5" />
      <rect className="gt-text" height="4" rx="2" width="56" x="88" y="94" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="40" x="184" y="94" />
    </>
  ),
  projects: (
    <>
      <rect className="gt-fill gt-accent" height="12" rx="3" width="12" x="58" y="14" />
      <rect className="gt-text" height="5" rx="2.5" width="64" x="78" y="17.5" />
      <rect className="gt-fill gt-soft" height="20" rx="8" width="184" x="58" y="34" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="120" x="70" y="42" />
      <rect className="gt-line" height="20" rx="8" width="184" x="58" y="58" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="96" x="70" y="66" />
      <rect className="gt-fill gt-strong" height="12" rx="3" width="12" x="58" y="86" />
      <rect className="gt-text" height="5" rx="2.5" width="48" x="78" y="89.5" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="44" x="252" y="42" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="28" x="252" y="66" />
    </>
  ),
  tools: (
    <>
      <rect className="gt-line" height="86" rx="10" width="128" x="26" y="14" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="76" x="40" y="30" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="92" x="40" y="44" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="58" x="40" y="58" />
      <rect className="gt-fill gt-soft" height="86" rx="10" width="108" x="166" y="14" />
      <rect className="gt-fill gt-accent-soft" height="22" rx="7" width="22" x="176" y="24" />
      <rect className="gt-fill gt-soft-2" height="22" rx="7" width="22" x="202" y="24" />
      <rect className="gt-fill gt-soft-2" height="22" rx="7" width="22" x="228" y="24" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="80" x="178" y="62" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="60" x="178" y="76" />
    </>
  ),
  composer: (
    <>
      <rect className="gt-line" height="62" rx="20" width="230" x="35" y="28" />
      <rect className="gt-text gt-faint" height="4" rx="2" width="120" x="56" y="44" />
      <circle className="gt-line" cx="58" cy="76" r="8" />
      <rect className="gt-text" height="3" rx="1.5" width="8" x="54" y="74.5" />
      <rect className="gt-text" height="8" rx="1.5" width="3" x="56.5" y="72" />
      <rect className="gt-fill gt-accent-soft" height="16" rx="8" width="44" x="76" y="68" />
      <rect className="gt-line" height="16" rx="8" width="56" x="126" y="68" />
      <circle className="gt-fill gt-strong" cx="244" cy="76" r="8" />
    </>
  ),
  settings: (
    <>
      <rect className="gt-line" height="24" rx="8" width="210" x="45" y="12" />
      <circle className="gt-fill gt-accent" cx="62" cy="24" r="4" />
      <rect className="gt-text" height="4" rx="2" width="64" x="74" y="22" />
      <rect className="gt-fill gt-accent-soft" height="10" rx="5" width="20" x="226" y="19" />
      <rect className="gt-line" height="24" rx="8" width="210" x="45" y="44" />
      <circle className="gt-fill gt-accent" cx="62" cy="56" r="4" />
      <rect className="gt-text" height="4" rx="2" width="80" x="74" y="54" />
      <rect className="gt-fill gt-soft" height="10" rx="5" width="20" x="226" y="51" />
      <rect className="gt-line" height="24" rx="8" width="210" x="45" y="76" />
      <circle className="gt-fill gt-accent" cx="62" cy="88" r="4" />
      <rect className="gt-text" height="4" rx="2" width="52" x="74" y="86" />
      <rect className="gt-fill gt-accent-soft" height="10" rx="5" width="20" x="226" y="83" />
    </>
  ),
};
