import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { ProviderGlyph } from "../../providers/ProviderGlyph";
import { PROVIDER_LOGOS } from "../../providers/providerLogoPaths";
import { signInConsent } from "../../providers/ProviderOAuthSignIn";
import { OctantButton } from "../../ui/base/OctantButton";
import type { EndpointFixKind, EndpointStatus, ModelEndpointInstance } from "./endpointStatus";

/**
 * The OpenAI mark for the ChatGPT plan, keyed by its sign-in rather than its
 * driver: an OpenAI-compatible endpoint that is not the plan keeps a monogram.
 * OpenRouter stays a monogram until a licensed mark is bundled.
 */
const MONOGRAM_SIZE = 24;

const SIGN_IN_GLYPHS: Readonly<Record<string, string>> = { "chatgpt-plan": "openai-image" };

export function EndpointMark(props: {
  readonly instance: ModelEndpointInstance;
  readonly size?: number;
}) {
  const descriptorId =
    props.instance.driverKind === "openai-compatible" ||
    props.instance.driverKind === "anthropic-compatible"
      ? props.instance.configuration.oauthDescriptorId
      : undefined;
  const glyph =
    descriptorId === undefined
      ? props.instance.driverKind === "ollama" || props.instance.driverKind === "azure-foundry"
        ? props.instance.driverKind
        : "model-endpoint"
      : (SIGN_IN_GLYPHS[descriptorId] ?? "model-endpoint");
  // A monogram's letters scale with its box, so it takes the larger step to
  // stay readable beside a logo drawn at the smaller one.
  const size = PROVIDER_LOGOS[glyph] === undefined ? MONOGRAM_SIZE : (props.size ?? 16);
  return (
    <span aria-hidden="true" className="endpoint-mark">
      <ProviderGlyph displayName={props.instance.displayName} driverKind={glyph} size={size} />
    </span>
  );
}

/** A state in words beside a dot whose shape carries the same state. */
export function EndpointState(props: { readonly status: EndpointStatus }) {
  return (
    <span className="endpoint-state" data-tone={props.status.tone}>
      <span aria-hidden="true" className="endpoint-state__dot" />
      {props.status.label}
    </span>
  );
}

export interface ModelEndpointRowProps {
  readonly instance: ModelEndpointInstance;
  readonly status: EndpointStatus;
  readonly subLine: string;
  /** Model count, or "kept, not offered" for an endpoint that is off. */
  readonly meta?: string;
  /** The consent line a sign-in fix carries while the terms are unacknowledged. */
  readonly signInTerms?: string;
  readonly disabled: boolean;
  readonly onOpen: () => void;
  readonly onFix: (kind: EndpointFixKind) => void;
}

/**
 * One endpoint in the list: a single link to its details named with its
 * state, and, when it needs you, the sentence and its one fix beside it.
 */
export function ModelEndpointRow(props: ModelEndpointRowProps) {
  const name = props.instance.displayName;
  const fix = props.status.fix;
  const accessibleName = [name, props.status.label.toLowerCase(), props.meta]
    .filter((part) => part !== undefined)
    .join(", ");
  let fixArea: ReactNode = null;
  if (props.status.sentence !== undefined || fix !== undefined) {
    fixArea = (
      <div aria-label={`Fix ${name}`} className="endpoint-row__fix" role="group">
        {props.status.sentence === undefined ? null : (
          <p className="endpoint-row__sentence">{props.status.sentence}</p>
        )}
        {fix === undefined ? null : (
          <OctantButton
            aria-label={`${fix.label} for ${name}`}
            disabled={props.disabled}
            onClick={() => props.onFix(fix.kind)}
            size="sm"
            type="button"
            variant={fix.kind === "sign-in" ? "default" : "outline"}
          >
            {fix.label}
          </OctantButton>
        )}
        {fix?.kind === "sign-in" && props.signInTerms !== undefined ? (
          <p className="endpoint-row__consent">{signInConsent(props.signInTerms)}</p>
        ) : null}
      </div>
    );
  }
  return (
    <li className="endpoint-row" data-tone={props.status.tone}>
      <a
        aria-label={`${accessibleName}. Open details`}
        className="endpoint-row__link window-no-drag"
        data-endpoint-id={String(props.instance.id)}
        href={`#endpoint-${String(props.instance.id)}`}
        onClick={(event) => {
          event.preventDefault();
          props.onOpen();
        }}
      >
        <EndpointMark instance={props.instance} />
        <span className="endpoint-row__text">
          <span className="endpoint-row__name">{name}</span>
          <span className="endpoint-row__sub">{props.subLine}</span>
        </span>
        <span className="endpoint-row__state">
          <EndpointState status={props.status} />
          {props.meta === undefined ? null : (
            <span className="endpoint-row__meta">{props.meta}</span>
          )}
        </span>
        <ChevronRight aria-hidden="true" className="endpoint-row__chevron" size={16} />
      </a>
      {/* The check result is announced here, on the row it is about, rather
          than through a page-level alert. */}
      <div aria-live="polite" className="endpoint-row__live">
        {fixArea}
      </div>
    </li>
  );
}
