import type { WorkPromotionProposal, ProjectId } from "@octant/contracts";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { useState } from "react";
import type { WorkPromotionController } from "./useWorkPromotionController";
import { SurfaceEmpty, SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface WorkPromotionFlowProps {
  readonly controller: WorkPromotionController;
  readonly originProjectName: string;
  readonly targetCodeProjectLabels: ReadonlyArray<{
    readonly id: ProjectId;
    readonly name: string;
  }>;
  readonly providerChoices: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly label: string;
  }>;
  readonly onOpenLinkedCodeThread?: (
    threadId: CodeThreadId,
    title: string,
    projectId: ProjectId,
  ) => void;
}

export function WorkPromotionFlow(props: WorkPromotionFlowProps) {
  const [summary, setSummary] = useState("Continue this work in Code with explicit approval.");
  const [artifactIndex, setArtifactIndex] = useState("0");
  const [targetIndex, setTargetIndex] = useState("0");
  const [providerIndex, setProviderIndex] = useState("0");
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [approvedLinks, setApprovedLinks] = useState<
    ReadonlyArray<{
      readonly proposalId: string;
      readonly threadId: CodeThreadId;
      readonly title: string;
      readonly projectId: ProjectId;
    }>
  >([]);
  const errorMessage = localError ?? props.controller.errorMessage;
  // Every Code model this host reports may be unusable for Code. Approving with
  // no choice would create a linked Code thread with no model, so the flow says
  // so and refuses instead of presenting an empty picker and a dead button.
  const selectedArtifact = props.controller.availableArtifactRefs[Number(artifactIndex)];
  const selectedTarget = props.targetCodeProjectLabels[Number(targetIndex)];
  const noArtifacts = props.controller.availableArtifactRefs.length === 0;
  const noTargets = props.targetCodeProjectLabels.length === 0;
  const noUsableCodeModel = props.providerChoices.length === 0;

  return (
    <div className="work-promotion">
      {errorMessage !== undefined ? (
        <p className="oct-meta work-promotion__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <SurfaceSection
        className="work-promotion__propose"
        label="Continue in Code"
        note="Work never turns into Code on its own: propose a linked Code thread, then approve or dismiss it. The new thread starts approval-gated with none of this Project's file authority."
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (
              selectedTarget === undefined ||
              selectedArtifact === undefined ||
              selectedArtifact.trim() === "" ||
              props.controller.proposing
            )
              return;
            setLocalError(undefined);
            void props.controller
              .propose({
                targetCodeProjectId: selectedTarget.id,
                summary,
                artifactRefs: [selectedArtifact],
              })
              .then((proposal) => {
                if (proposal !== undefined) setSummary("");
              });
          }}
        >
          <label className="work-promotion__field">
            <span className="oct-row-detail">Selected context summary</span>
            <OctantTextarea
              rows={2}
              value={summary}
              onChange={(event) => setSummary(event.currentTarget.value)}
            />
          </label>
          <div className="work-promotion__selection-fields">
            <label className="work-promotion__field">
              <span className="oct-row-detail">Selected Work artifact</span>
              {noArtifacts ? (
                <SurfaceEmpty
                  detail="Create a starter note below, then propose."
                  title="No Work artifact to hand over yet"
                  tone="lane"
                />
              ) : (
                <OctantSelectField
                  aria-label="Selected Work artifact"
                  onValueChange={setArtifactIndex}
                  options={props.controller.availableArtifactRefs.map((ref, index) => ({
                    id: String(index),
                    label: ref,
                  }))}
                  value={artifactIndex}
                />
              )}
            </label>
            <label className="work-promotion__field">
              <span className="oct-row-detail">Target Code Project</span>
              {noTargets ? (
                <SurfaceEmpty title="No active Code Project to target" tone="lane" />
              ) : (
                <OctantSelectField
                  aria-label="Target Code Project"
                  onValueChange={setTargetIndex}
                  options={props.targetCodeProjectLabels.map((project, index) => ({
                    id: String(index),
                    label: project.name,
                  }))}
                  value={targetIndex}
                />
              )}
            </label>
          </div>
          {noArtifacts || noTargets ? null : (
            <OctantButton
              className="project-button"
              disabled={props.controller.proposing || (selectedArtifact ?? "").trim() === ""}
              type="submit"
              variant="secondary"
            >
              Propose a Code thread
            </OctantButton>
          )}
        </form>
      </SurfaceSection>
      <SurfaceSection className="work-promotion__pending" label="Waiting for your decision">
        {props.controller.pendingProposals.length === 0 ? (
          <SurfaceEmpty title={`Nothing waiting in ${props.originProjectName}`} />
        ) : (
          <ul className="surface-list">
            {props.controller.pendingProposals.map((proposal) => (
              <li className="surface-row" key={String(proposal.proposalId)}>
                <div className="surface-row__copy">
                  <span className="oct-row-label">{proposal.selectedContext.summary}</span>
                  <span className="oct-row-detail">
                    Target Code Project:{" "}
                    {props.targetCodeProjectLabels.find(
                      (project) => String(project.id) === String(proposal.targetCodeProjectId),
                    )?.name ?? "Unknown"}
                  </span>
                </div>
                <div className="work-promotion__actions surface-row__control">
                  {noUsableCodeModel ? null : (
                    <label className="work-promotion__provider">
                      <span className="sr-only">Provider for approval</span>
                      <OctantSelectField
                        aria-label="Provider for approval"
                        onValueChange={setProviderIndex}
                        options={props.providerChoices.map((choice, index) => ({
                          id: String(index),
                          label: choice.label,
                        }))}
                        value={providerIndex}
                      />
                    </label>
                  )}
                  {noUsableCodeModel ? (
                    <p className="work-promotion__unavailable">
                      No usable Code model is available. Configure a provider that reports a
                      tool-capable model before approving this.
                    </p>
                  ) : null}
                  <OctantButton
                    className="project-button"
                    disabled={noUsableCodeModel}
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const choice = props.providerChoices[Number(providerIndex)];
                      if (choice === undefined) return;
                      const deliveryTarget = props.controller.deliveryTargetsByProject.get(
                        String(proposal.targetCodeProjectId),
                      );
                      if (deliveryTarget === undefined) {
                        setLocalError(
                          "Approving needs a confirmed delivery on the Code Project you chose.",
                        );
                        return;
                      }
                      setLocalError(undefined);
                      void props.controller
                        .approve({
                          proposal,
                          providerInstanceId: choice.instanceId,
                          modelId: choice.modelId,
                          deliveryTarget,
                        })
                        .then((approved) => {
                          const linkedCodeThreadId = approved?.linkedCodeThreadId;
                          if (
                            approved !== undefined &&
                            linkedCodeThreadId !== undefined &&
                            props.onOpenLinkedCodeThread !== undefined
                          ) {
                            setApprovedLinks((current) => [
                              ...current,
                              {
                                proposalId: String(approved.proposalId),
                                threadId: linkedCodeThreadId,
                                title: approved.selectedContext.summary,
                                projectId: approved.targetCodeProjectId,
                              },
                            ]);
                          }
                        });
                    }}
                  >
                    Approve
                  </OctantButton>
                  <OctantButton
                    className="project-button project-button--quiet"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setLocalError(undefined);
                      void props.controller.dismiss(proposal);
                    }}
                  >
                    Dismiss
                  </OctantButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SurfaceSection>
      {approvedLinks.length > 0 ? (
        <SurfaceSection className="work-promotion__approved" label="Approved Code threads">
          <ul className="surface-list">
            {approvedLinks.map((entry) => (
              <li className="surface-row" key={entry.proposalId}>
                <span className="oct-row-label">{entry.title}</span>
                {props.onOpenLinkedCodeThread !== undefined ? (
                  <OctantButton
                    className="project-button"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      props.onOpenLinkedCodeThread?.(entry.threadId, entry.title, entry.projectId)
                    }
                  >
                    Open linked Code thread
                  </OctantButton>
                ) : null}
              </li>
            ))}
          </ul>
        </SurfaceSection>
      ) : null}
    </div>
  );
}

export type { WorkPromotionProposal };
