import type { CodeCheckoutId } from "@octant/contracts/code";
import { OctantSelectField } from "../ui/base/OctantSelect";
import type { CodeRepositoryOption } from "./threadRepositories";

export interface CodeRepositoryPickerProps {
  readonly repositories: ReadonlyArray<CodeRepositoryOption>;
  readonly selectedCheckoutId: CodeCheckoutId;
  readonly onSelect: (checkoutId: CodeCheckoutId) => void;
  readonly label?: string;
}

/**
 * Per-repository switcher for Diff and Git panes in multi-repository Code
 * Projects. Renders nothing for single-repository threads so single-repo
 * workflows see zero UI change.
 */
export function CodeRepositoryPicker(props: CodeRepositoryPickerProps) {
  if (props.repositories.length <= 1) return null;
  const label = props.label ?? "Repository";
  return (
    <div className="code-repository-picker">
      <OctantSelectField
        aria-label={label}
        onValueChange={(value) => {
          const matched = props.repositories.find((repo) => String(repo.checkoutId) === value);
          if (matched !== undefined) props.onSelect(matched.checkoutId);
        }}
        options={props.repositories.map((repo) => ({
          id: String(repo.checkoutId),
          label: repo.label,
        }))}
        value={String(props.selectedCheckoutId)}
      />
    </div>
  );
}
