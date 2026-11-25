import {
  decodeImageGenerationGenerateOffer,
  decodeImageGenerationSaveOffer,
  type ImageGenerationGenerateOffer,
  type ImageGenerationSaveOffer,
} from "@octant/contracts";
import { imageOfferModelChoices } from "@octant/client-runtime/service-offer-choices";
import { useId, useState } from "react";
import { Image as ImageIcon, X } from "../ui/icons";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { strictOfferCard, type OfferCardProps } from "../offers/strictOfferCard";

export const ImageGenerateOfferCard = strictOfferCard(
  decodeImageGenerationGenerateOffer,
  GenerateCard,
);
export const ImageSaveOfferCard = strictOfferCard(decodeImageGenerationSaveOffer, SaveCard);

function SaveCard({
  offer: pending,
  busy,
  decide: answer,
}: OfferCardProps<ImageGenerationSaveOffer>) {
  const decide = (decision: "save" | "cancel") => answer({ offerId: pending.offerId, decision });
  const iconSet = pending.fileCount;
  return (
    <article
      aria-label={iconSet === undefined ? "Image save request" : "Icon set save request"}
      className="follow-up-card"
    >
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
      {iconSet === undefined ? (
        <>
          <p className="follow-up-card__title">Save this image as a new file?</p>
          <p className="follow-up-card__summary">
            The agent wants to save an image this thread generated in the folder it works in. An
            existing file is never replaced.
          </p>
        </>
      ) : (
        <>
          <p className="follow-up-card__title">
            Save an icon set as {iconSet} new files in this directory?
          </p>
          <p className="follow-up-card__summary">
            The agent wants to resize an image this thread generated into icons in the folder it
            works in. If any of the files already exists, nothing is written.
          </p>
        </>
      )}
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

function GenerateCard(props: OfferCardProps<ImageGenerationGenerateOffer>) {
  const { offer: pending, busy } = props;
  const [selected, setSelected] = useState<string>();
  const [remember, setRemember] = useState(false);
  const rememberId = useId();
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
