import type { CodeDeliveryOutcomeKind } from "@octant/contracts/code";
import { ChevronDown, FileSearch, GitMerge, GitPullRequest, Save } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantPopover } from "../../ui/base/OctantPopover";

export const CODE_DELIVERY_OUTCOME_OPTIONS: ReadonlyArray<{
  readonly id: CodeDeliveryOutcomeKind;
  readonly label: string;
  readonly detail: string;
  readonly icon: typeof FileSearch;
}> = [
  {
    id: "investigation-result",
    label: "Investigation",
    detail: "An answer, with nothing committed.",
    icon: FileSearch,
  },
  {
    id: "local-implementation",
    label: "Local change",
    detail: "Committed work that stays on this machine.",
    icon: Save,
  },
  {
    id: "opened-pr",
    label: "Opened PR",
    detail: "A pull request raised for review.",
    icon: GitPullRequest,
  },
  {
    id: "merged-pr",
    label: "Merged PR",
    detail: "A pull request that has landed.",
    icon: GitMerge,
  },
];

export interface CodeDeliveryOutcomeSelectorProps {
  readonly disabled?: boolean;
  readonly onChange: (outcome: CodeDeliveryOutcomeKind) => void;
  readonly value: CodeDeliveryOutcomeKind;
  /** True while the value is still the one read from the prompt. */
  readonly suggested: boolean;
}

/**
 * What finishing this task has to produce, as a decision rather than a reading.
 *
 * The outcome decides when a thread may be called Done, and it was inferred
 * from the prompt and written to the thread without ever being shown. This puts
 * the reading on screen before the thread exists, so the value the thread
 * carries is one the person actually agreed to.
 */
export function CodeDeliveryOutcomeSelector(props: CodeDeliveryOutcomeSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected =
    CODE_DELIVERY_OUTCOME_OPTIONS.find((option) => option.id === props.value) ??
    CODE_DELIVERY_OUTCOME_OPTIONS[0];
  const TriggerIcon = selected?.icon ?? FileSearch;

  return (
    <OctantPopover
      className="code-composer-choice__menu"
      onOpenChange={setOpen}
      open={open}
      title="Delivers"
      trigger={
        <>
          <TriggerIcon aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{selected?.label}</span>
          {props.suggested ? (
            <span className="code-composer-choice__hint">read from your prompt</span>
          ) : null}
          <ChevronDown aria-hidden="true" size={12} />
        </>
      }
      triggerClassName="code-composer-choice__trigger"
      triggerLabel="Delivers"
      {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
    >
      <p className="code-composer-choice__caption">This task delivers</p>
      <div aria-label="Delivers" className="code-composer-choice__list" role="listbox">
        {CODE_DELIVERY_OUTCOME_OPTIONS.map((option) => (
          <OctantButton
            aria-selected={option.id === props.value}
            className="code-composer-choice__option"
            key={option.id}
            onClick={() => {
              props.onChange(option.id);
              setOpen(false);
            }}
            role="option"
            type="button"
            variant="ghost"
          >
            <span className="code-composer-choice__option-icon">
              <option.icon aria-hidden="true" size={14} strokeWidth={1.7} />
            </span>
            <span className="code-composer-choice__option-copy">
              <span className="code-composer-choice__option-label">{option.label}</span>
              <span className="code-composer-choice__option-detail">{option.detail}</span>
            </span>
          </OctantButton>
        ))}
      </div>
    </OctantPopover>
  );
}
