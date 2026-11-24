import type { PickerGroup } from "@octant/domain";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { modelDisplayName, providerModelLabel } from "../providers/providerModelLabel";
import { OctantSeparatorWithLabel } from "../ui/base/OctantSeparator";
import { ArrowLeftRight, ArrowRight, GitBranch, GitFork, RotateCcw } from "../ui/icons";
import "./transcript-handoff.css";

export interface TranscriptProviderSelection {
  readonly providerInstanceId: unknown;
  readonly modelId: unknown;
}

export type TranscriptHandoffKind =
  | "context-handoff"
  | "model-switch"
  | "fork"
  | "branch"
  | "rewind";

export type RecordedHandoffReason =
  | "provider-switch"
  | "account-move"
  | "account-move-native-session"
  | "fork"
  | "fork-native-session"
  | "branch"
  | "rewind"
  | "rewind-native-session";

export interface RecordedHandoffSummary {
  readonly reason: RecordedHandoffReason;
  readonly previousProviderInstanceId?: unknown;
  readonly previousModelId?: unknown;
}

export interface TranscriptHandoffEntry {
  readonly kind: TranscriptHandoffKind;
  readonly from?: TranscriptProviderSelection;
  readonly to?: TranscriptProviderSelection;
  readonly disclosure?: string;
}

const HEADING_FOR_KIND: Readonly<Record<TranscriptHandoffKind, string>> = {
  "context-handoff": "Context handoff",
  "model-switch": "Model switch",
  fork: "Forked context",
  branch: "Branched context",
  rewind: "Rewound context",
};

/**
 * Classifies a boundary between turns or attempts for Chat, Work, and Code alike.
 *
 * A provider or account change, or a same-provider model change that forced a
 * text handoff, reads as a context handoff. A same-provider model change without
 * a session handoff stays a model switch so the transcript never claims a fresh
 * session when the provider carried its own.
 */
export function resolveTranscriptHandoff(input: {
  readonly previous?: TranscriptProviderSelection | undefined;
  readonly current?: TranscriptProviderSelection | undefined;
  readonly handoff?: RecordedHandoffSummary | undefined;
  readonly disclosure?: string | undefined;
}): TranscriptHandoffEntry | undefined {
  const from =
    input.previous ??
    (input.handoff?.previousProviderInstanceId !== undefined &&
    input.handoff.previousModelId !== undefined
      ? {
          providerInstanceId: input.handoff.previousProviderInstanceId,
          modelId: input.handoff.previousModelId,
        }
      : undefined);
  const to = input.current;
  const providerChanged =
    from !== undefined &&
    to !== undefined &&
    String(from.providerInstanceId) !== String(to.providerInstanceId);
  const modelChanged =
    from !== undefined &&
    to !== undefined &&
    String(from.providerInstanceId) === String(to.providerInstanceId) &&
    String(from.modelId) !== String(to.modelId);
  const reason = input.handoff?.reason;

  let kind: TranscriptHandoffKind | undefined;
  if (
    providerChanged ||
    reason === "provider-switch" ||
    reason === "account-move" ||
    reason === "account-move-native-session"
  ) {
    kind = "context-handoff";
  } else if (modelChanged) {
    kind = "model-switch";
  } else if (reason === "fork" || reason === "fork-native-session") {
    kind = "fork";
  } else if (reason === "branch") {
    kind = "branch";
  } else if (reason === "rewind" || reason === "rewind-native-session") {
    kind = "rewind";
  }

  if (kind === undefined) return undefined;
  const showRoute = from !== undefined && to !== undefined && (providerChanged || modelChanged);

  return {
    kind,
    ...(showRoute ? { from, to } : {}),
    ...(input.disclosure === undefined ? {} : { disclosure: input.disclosure }),
  };
}

interface ResolvedEndpoint {
  readonly group: PickerGroup | undefined;
  readonly label: string;
  readonly fullLabel: string;
}

function resolveRoute(
  groups: ReadonlyArray<PickerGroup>,
  from: TranscriptProviderSelection,
  to: TranscriptProviderSelection,
): {
  readonly from: ResolvedEndpoint;
  readonly to: ResolvedEndpoint;
  readonly showToGlyph: boolean;
} {
  const fromGroup = groups.find(
    (candidate) => String(candidate.instance.id) === String(from.providerInstanceId),
  );
  const toGroup = groups.find(
    (candidate) => String(candidate.instance.id) === String(to.providerInstanceId),
  );
  const fromModel = modelDisplayName(groups, from);
  const toModel = modelDisplayName(groups, to);
  const differentInstance = String(from.providerInstanceId) !== String(to.providerInstanceId);
  // Two accounts running the same model would otherwise read "Model -> Model";
  // name each account beside the model so the move stays legible.
  const disambiguateAccount = differentInstance && fromModel === toModel;

  return {
    from: {
      group: fromGroup,
      label:
        disambiguateAccount && fromGroup !== undefined
          ? `${fromGroup.instance.displayName} · ${fromModel}`
          : fromModel,
      fullLabel: providerModelLabel(groups, from),
    },
    to: {
      group: toGroup,
      label:
        disambiguateAccount && toGroup !== undefined
          ? `${toGroup.instance.displayName} · ${toModel}`
          : toModel,
      fullLabel: providerModelLabel(groups, to),
    },
    showToGlyph: differentInstance,
  };
}

function LeadIcon(props: { readonly kind: TranscriptHandoffKind }) {
  switch (props.kind) {
    case "context-handoff":
    case "model-switch":
      return <ArrowLeftRight aria-hidden="true" className="transcript-handoff__icon" size={12} />;
    case "fork":
      return <GitFork aria-hidden="true" className="transcript-handoff__icon" size={12} />;
    case "branch":
      return <GitBranch aria-hidden="true" className="transcript-handoff__icon" size={12} />;
    case "rewind":
      return <RotateCcw aria-hidden="true" className="transcript-handoff__icon" size={12} />;
  }
}

function HandoffEndpoint(props: {
  readonly endpoint: ResolvedEndpoint;
  readonly emphasized?: boolean;
  readonly showGlyph: boolean;
}) {
  const { endpoint, emphasized, showGlyph } = props;
  return (
    <span
      className={
        emphasized === true
          ? "transcript-handoff__endpoint transcript-handoff__endpoint--to"
          : "transcript-handoff__endpoint"
      }
      title={endpoint.fullLabel}
    >
      {showGlyph && endpoint.group !== undefined ? (
        <ProviderGlyph
          className="transcript-handoff__glyph"
          displayName={endpoint.group.instance.displayName}
          driverKind={endpoint.group.instance.driverKind}
          size={14}
        />
      ) : null}
      <span className="transcript-handoff__model">{endpoint.label}</span>
    </span>
  );
}

/**
 * Shared inline handoff boundary for Chat, Work, and Code transcripts: a full-width
 * hairline with the transition's icon, label, and source-to-target models with their
 * provider marks, followed by the host's disclosure note when context was carried.
 */
export function TranscriptHandoff(props: {
  readonly entry: TranscriptHandoffEntry;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
}) {
  const { entry, providerGroups } = props;
  const heading = HEADING_FOR_KIND[entry.kind];
  const route =
    entry.from !== undefined && entry.to !== undefined
      ? resolveRoute(providerGroups, entry.from, entry.to)
      : undefined;
  const accessibleLabel =
    route === undefined
      ? heading
      : entry.kind === "model-switch"
        ? `${heading} from ${route.from.label} to ${route.to.label}`
        : `${heading} from ${route.from.fullLabel} to ${route.to.fullLabel}`;

  return (
    <div className="transcript-handoff" data-handoff-kind={entry.kind}>
      <OctantSeparatorWithLabel aria-label={accessibleLabel} className="transcript-handoff__rule">
        <span className="transcript-handoff__content">
          <span className="transcript-handoff__lead">
            <LeadIcon kind={entry.kind} />
            <span>{heading}</span>
          </span>
          {route === undefined ? null : (
            <span className="transcript-handoff__route">
              <HandoffEndpoint endpoint={route.from} showGlyph={route.from.group !== undefined} />
              <ArrowRight aria-hidden="true" className="transcript-handoff__arrow" size={12} />
              <HandoffEndpoint
                emphasized
                endpoint={route.to}
                showGlyph={route.to.group !== undefined && route.showToGlyph}
              />
            </span>
          )}
        </span>
      </OctantSeparatorWithLabel>
      {entry.disclosure === undefined ? null : (
        <p className="transcript-handoff__note" role="note">
          {entry.disclosure}
        </p>
      )}
    </div>
  );
}
