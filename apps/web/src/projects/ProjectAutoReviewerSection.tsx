import type { ProjectSummary } from "@octant/contracts/projects";
import type { AutoReviewer } from "@octant/contracts/shield";
import { useState } from "react";
import { OctantSelectField } from "../ui/base/OctantSelect";

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

const FOLLOW_SETTINGS = "settings";

const OPTIONS: ReadonlyArray<{
  readonly id: AutoReviewer | typeof FOLLOW_SETTINGS;
  readonly label: string;
}> = [
  { id: FOLLOW_SETTINGS, label: "Same as Settings" },
  { id: "provider", label: "Provider's own" },
  { id: "octant-shield", label: "Octant Shield" },
];

export interface ProjectAutoReviewerSectionProps {
  readonly project: CodeProjectSummary;
  readonly onChange: (reviewer: AutoReviewer | undefined) => Promise<boolean>;
  readonly disabled?: boolean;
}

/** The Project's override of the Settings Auto reviewer. */
export function ProjectAutoReviewerSection(props: ProjectAutoReviewerSectionProps) {
  // Each command asserts the Project version it read, so a second pick waits
  // for the first rather than being refused as stale.
  const [pending, setPending] = useState(false);
  return (
    <OctantSelectField
      aria-label="Auto reviewer for this Project"
      className="window-no-drag"
      disabled={props.disabled === true || pending}
      onValueChange={(next) => {
        const option = OPTIONS.find((candidate) => candidate.id === next);
        if (option === undefined) return;
        setPending(true);
        void props
          .onChange(option.id === FOLLOW_SETTINGS ? undefined : option.id)
          .finally(() => setPending(false));
      }}
      options={OPTIONS}
      value={props.project.autoReviewer ?? FOLLOW_SETTINGS}
    />
  );
}
