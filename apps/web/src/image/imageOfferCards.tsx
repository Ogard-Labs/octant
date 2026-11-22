import type {
  ImageGenerationProfileView,
  ServiceOffer,
  ServiceOfferDecision,
} from "@octant/contracts";
import { imageOfferModelChoices } from "@octant/client-runtime/service-offer-client";
import { useId, useState } from "react";
import { Image as ImageIcon, X } from "../ui/icons";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";

interface ImageOfferCardProps {
  readonly offer: ServiceOffer;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  readonly keptIn: "project" | "thread";
  readonly busy: boolean;
  readonly decide: (answer: ServiceOfferDecision) => void;
}

export function ImageSaveOfferCard({ offer: pending, busy, decide: answer }: ImageOfferCardProps) {
  if (pending.kind !== "save") return null;
  const decide = (decision: "save" | "cancel") => answer({ offerId: pending.offerId, decision });
  return (
    <article aria-label="Image save request" className="follow-up-card">
      <div className="follow-up-card__head">
        <span className="follow-up-card__kind">
          <ImageIcon aria-hidden="true" size={12} /> Image · asked by the agent
        </span>
        <OctantIconButton
          disabled={busy}
          label="Don't save the image"
          onClick={() => void decide("cancel")}
          size="icon-xs"
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </OctantIconButton>
      </div>
      <p className="follow-up-card__title">Save this image as a new file?</p>
      <p className="follow-up-card__summary">
        The agent wants to save an image this thread generated in the folder it works in. An
        existing file is never replaced.
      </p>
      <p className="follow-up-card__prompt" title={pending.relativePath}>
        {pending.relativePath}
      </p>
      <div className="follow-up-card__actions">
        <OctantButton
          disabled={busy}
          onClick={() => void decide("cancel")}
          size="xs"
          type="button"
          variant="ghost"
        >
          Don't save
        </OctantButton>
        <OctantButton disabled={busy} onClick={() => void decide("save")} size="xs" type="button">
          Save
        </OctantButton>
      </div>
    </article>
  );
}

export function ImageGenerateOfferCard(props: ImageOfferCardProps) {
  const { offer: pending, busy } = props;
  const [selected, setSelected] = useState<string>();
  const [remember, setRemember] = useState(false);
  const rememberId = useId();
  if (pending.kind !== "generate") return null;
  const references = pending.references;
  const choices = imageOfferModelChoices(
    props.profiles,
    pending.suggested,
    references !== undefined,
  );
  const choice = choices.find((candidate) => candidate.id === selected) ?? choices[0];
  const title = pending.revision
    ? "Revise this image with an image model?"
    : "Generate this image?";

  function decide(decision: "generate" | "agent-draws" | "cancel") {
    if (decision !== "generate") {
      props.decide({ offerId: pending.offerId, decision });
    } else if (choice !== undefined) {
      props.decide({
        offerId: pending.offerId,
        decision,
        profileInstanceId: choice.profileInstanceId,
        modelId: choice.modelId,
        rememberForThread: references === undefined && remember,
        ...(references === undefined ? {} : { referenceImagesConfirmed: true }),
      });
    }
  }

  return (
    <article aria-label="Image generation request" className="follow-up-card">
      <div className="follow-up-card__head">
        <span className="follow-up-card__kind">
          <ImageIcon aria-hidden="true" size={12} /> Image · asked by the agent
        </span>
        <OctantIconButton
          disabled={busy}
          label="Cancel image generation"
          onClick={() => void decide("cancel")}
          size="icon-xs"
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </OctantIconButton>
      </div>
      <p className="follow-up-card__title">{title}</p>
      <p className="follow-up-card__summary">
        An image model gives a far better picture than one the agent draws as SVG. It is billed to
        the image provider you set up
        {pending.variantCount > 1 ? `, ${String(pending.variantCount)} images` : ""}.
      </p>
      <p className="follow-up-card__prompt" title={pending.prompt}>
        {pending.prompt}
      </p>
      {references === undefined ? null : (
        <div className="follow-up-card__summary">
          <p>These images will be sent to the selected image provider:</p>
          <ul>
            {references.map((reference, index) => (
              <li key={index}>
                {reference.label}
                {reference.signedIn === true ? " (signed-in page)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="follow-up-card__confirm">
        <OctantSelectField
          aria-label="Image model"
          disabled={busy}
          onValueChange={setSelected}
          options={choices.map((candidate) => ({ id: candidate.id, label: candidate.label }))}
          value={choice?.id ?? ""}
        />
        {references === undefined ? (
          <label className="follow-up-card__summary" htmlFor={rememberId}>
            <OctantCheckbox
              checked={remember}
              disabled={busy}
              id={rememberId}
              onChange={(event) => setRemember(event.currentTarget.checked)}
            />{" "}
            {props.keptIn === "project"
              ? "Don't ask again in this Project"
              : "Don't ask again in this thread"}
          </label>
        ) : null}
      </div>
      <div className="follow-up-card__actions">
        <OctantButton
          disabled={busy}
          onClick={() => void decide("agent-draws")}
          size="xs"
          type="button"
          variant="ghost"
        >
          Let the agent draw it
        </OctantButton>
        <OctantButton
          disabled={busy || choice === undefined}
          onClick={() => void decide("generate")}
          size="xs"
          type="button"
        >
          Generate
        </OctantButton>
      </div>
    </article>
  );
}
