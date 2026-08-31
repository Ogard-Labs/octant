import type { WorkPromotionProposal, ProjectId } from "@octant/contracts";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import { useState } from "react";
import type { WorkPromotionController } from "./useWorkPromotionController";
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
  const noUsableCodeModel = props.providerChoices.length === 0;

  return (
    <section className="work-promotion" aria-label="Work promotion to Code">
      <header className="work-promotion__header">
        <h2>Promote coding work to Code</h2>
        <p>
          Work never switches mode silently. Propose a linked Code promotion, then approve or
          dismiss it explicitly. Code starts approval-gated with no inherited Work filesystem
          authority.
        </p>
      </header>
      {errorMessage !== undefined ? (
        <p className="work-promotion__error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <form
        className="work-promotion__propose"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const target = props.targetCodeProjectLabels[Number(targetIndex)];
          if (target === undefined || props.controller.proposing) return;
          setLocalError(undefined);
          void props.controller
            .propose({
              targetCodeProjectId: target.id,
              summary,
              artifactRefs: [props.controller.availableArtifactRefs[Number(artifactIndex)] ?? ""],
            })
            .then((proposal) => {
              if (proposal !== undefined) setSummary("");
            });
        }}
      >
        <label className="work-promotion__field">
          <span>Selected context summary</span>
          <OctantTextarea
            value={summary}
            onChange={(event) => setSummary(event.currentTarget.value)}
          />
        </label>
        <label className="work-promotion__field">
          <span>Selected Work artifact</span>
          <OctantSelectField
            aria-label="Selected Work artifact"
            onValueChange={setArtifactIndex}
            options={
              props.controller.availableArtifactRefs.length === 0
                ? [{ id: "", label: "No Work artifacts available" }]
                : props.controller.availableArtifactRefs.map((ref, index) => ({
                    id: String(index),
                    label: ref,
                  }))
            }
            value={artifactIndex}
          />
        </label>
        <label className="work-promotion__field">
          <span>Target Code Project</span>
          <OctantSelectField
            onValueChange={setTargetIndex}
            options={props.targetCodeProjectLabels.map((project, index) => ({
              id: String(index),
              label: project.name,
            }))}
            value={targetIndex}
          />
        </label>
        <OctantButton
          className="project-button"
          disabled={
            props.controller.proposing ||
            (props.controller.availableArtifactRefs[Number(artifactIndex)] ?? "").trim() === ""
          }
          type="submit"
          variant="secondary"
        >
          Propose promotion
        </OctantButton>
      </form>
      <section className="work-promotion__pending" aria-label="Pending promotion proposals">
        <h3>Pending proposals</h3>
        {props.controller.pendingProposals.length === 0 ? (
          <p>No pending promotion proposals for {props.originProjectName}.</p>
        ) : (
          <ul>
            {props.controller.pendingProposals.map((proposal) => (
              <li key={String(proposal.proposalId)}>
                <article>
                  <p>{proposal.selectedContext.summary}</p>
                  <p>
                    Target Code Project:{" "}
                    {props.targetCodeProjectLabels.find(
                      (project) => String(project.id) === String(proposal.targetCodeProjectId),
                    )?.name ?? "Unknown"}
                  </p>
                  <div className="work-promotion__actions">
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
                            "Approve requires an authoritative Code delivery target for the target Code Project.",
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
                            if (
                              approved?.linkedCodeThreadId !== undefined &&
                              props.onOpenLinkedCodeThread !== undefined
                            ) {
                              setApprovedLinks((current) => [
                                ...current,
                                {
                                  proposalId: String(approved.proposalId),
                                  threadId: approved.linkedCodeThreadId!,
                                  title: approved.selectedContext.summary,
                                  projectId: approved.targetCodeProjectId,
                                },
                              ]);
                            }
                          });
                      }}
                    >
                      Approve promotion
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
                  <label className="work-promotion__field">
                    <span>Provider for approval</span>
                    {noUsableCodeModel ? (
                      <p className="work-promotion__unavailable">
                        No usable Code model is available. Configure a provider that reports a
                        tool-capable model before approving this promotion.
                      </p>
                    ) : (
                      <OctantSelectField
                        onValueChange={setProviderIndex}
                        options={props.providerChoices.map((choice, index) => ({
                          id: String(index),
                          label: choice.label,
                        }))}
                        value={providerIndex}
                      />
                    )}
                  </label>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>
      {approvedLinks.length > 0 ? (
        <section className="work-promotion__approved" aria-label="Approved linked Code threads">
          <h3>Approved promotions</h3>
          <ul>
            {approvedLinks.map((entry) => (
              <li key={entry.proposalId}>
                <span>{entry.title}</span>
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
        </section>
      ) : null}
    </section>
  );
}

export type { WorkPromotionProposal };
