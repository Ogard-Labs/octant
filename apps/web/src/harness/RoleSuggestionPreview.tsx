import type { RoleSuggestion } from "@octant/domain";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";

export interface RoleSuggestionPreviewProps {
  readonly suggestions: ReadonlyArray<{
    readonly label: string;
    readonly suggestion: RoleSuggestion;
  }>;
  readonly onUse: () => void;
  readonly onCancel: () => void;
}

/**
 * What Suggest would put in each role, shown before anything is saved. A role
 * nothing fits says why and stays as it is.
 */
export function RoleSuggestionPreview(props: RoleSuggestionPreviewProps) {
  const usable = props.suggestions.some((entry) => entry.suggestion.picks.length > 0);
  return (
    <OctantConfirmDialog
      confirmDisabled={!usable}
      confirmLabel="Use these"
      details={
        <ul aria-label="Suggested models" className="role-suggestion">
          {props.suggestions.map(({ label, suggestion }) => (
            <li className="role-suggestion__role" key={suggestion.roleId}>
              {suggestion.picks.length === 0 ? (
                <span>
                  <strong>{label}</strong> stays as it is. {suggestion.note}
                </span>
              ) : (
                <>
                  {suggestion.picks.map((pick) => (
                    <span className="role-suggestion__line" key={`${pick.kind}:${pick.modelId}`}>
                      {pick.kind === "main" ? (
                        <>
                          <strong>{label}</strong> → {pick.displayName} ({pick.providerLabel}) —{" "}
                          {pick.reason}
                        </>
                      ) : (
                        <span className="oct-meta">
                          Fallback: {pick.displayName} ({pick.providerLabel}) — {pick.reason}
                        </span>
                      )}
                    </span>
                  ))}
                  {suggestion.note === undefined ? null : (
                    <span className="oct-meta">{suggestion.note}</span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      }
      onCancel={props.onCancel}
      onConfirm={props.onUse}
      title="Suggested models"
    >
      Nothing is saved until you choose Use these. You can change any role afterwards.
    </OctantConfirmDialog>
  );
}
