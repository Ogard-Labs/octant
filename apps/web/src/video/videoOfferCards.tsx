import type {
  ServiceOffer,
  ServiceOfferDecision,
  VideoClipOptions,
  VideoGenerateOffer,
} from "@octant/contracts";
import {
  describeVideoOffer,
  videoOfferChoices,
} from "@octant/client-runtime/video-offer-description";
import { useId, useState } from "react";
import VideoGlyph from "lucide-react/icons/video";
import { X } from "../ui/icons";
import { makeIcon } from "../ui/icons/makeIcon";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";

interface VideoOfferCardProps {
  readonly offer: ServiceOffer;
  readonly keptIn: "project" | "thread";
  readonly busy: boolean;
  readonly decide: (answer: ServiceOfferDecision) => void;
}

const VideoIcon = makeIcon("video", VideoGlyph);

const ROLE_LABELS: Record<VideoGenerateOffer["images"][number]["role"], string> = {
  "first-frame": "First frame",
  "last-frame": "Last frame",
  reference: "Reference",
};

export function VideoGenerateOfferCard(props: VideoOfferCardProps) {
  const { offer: pending, busy } = props;
  const [chosen, setChosen] = useState<VideoClipOptions>();
  const [remember, setRemember] = useState(false);
  const rememberId = useId();
  if (pending.kind !== "video-generate") return null;
  const options = chosen ?? pending.options;
  const choices = videoOfferChoices(pending);
  const described = describeVideoOffer(pending, options);
  const change = (next: Partial<VideoClipOptions>) => setChosen({ ...options, ...next });

  const decide = (decision: "video-generate" | "cancel") => {
    if (decision === "cancel") {
      props.decide({ offerId: pending.offerId, decision });
      return;
    }
    props.decide({
      offerId: pending.offerId,
      decision,
      options,
      rememberForThread: pending.canRemember && remember,
    });
  };

  return (
    <article aria-label="Video generation request" className="follow-up-card">
      <div className="follow-up-card__head">
        <span className="follow-up-card__kind">
          <VideoIcon aria-hidden="true" size={12} /> Video · asked by the agent
        </span>
        <OctantIconButton
          disabled={busy}
          label="Cancel video generation"
          onClick={() => decide("cancel")}
          size="icon-xs"
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </OctantIconButton>
      </div>
      <p className="follow-up-card__title">Make this video clip?</p>
      <p className="follow-up-card__prompt" title={pending.prompt}>
        {pending.prompt}
      </p>
      {pending.images.length === 0 ? null : (
        <div className="follow-up-card__summary">
          <p>These images will be sent to {pending.providerName}:</p>
          <ul>
            {pending.images.map((image, index) => (
              <li key={index}>
                {ROLE_LABELS[image.role]}: {image.label}
                {image.signedIn === true ? " (signed-in page)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="follow-up-card__summary">
        {pending.profileName} · {pending.model.displayName}
      </p>
      <div className="follow-up-card__confirm">
        <OctantSelectField
          aria-label="Clip length"
          disabled={busy || choices.durations.length < 2}
          onValueChange={(value) => change({ durationSeconds: Number(value) })}
          options={choices.durations.map((seconds) => ({
            id: String(seconds),
            label: `${String(seconds)} s`,
          }))}
          value={String(options.durationSeconds)}
        />
        <OctantSelectField
          aria-label="Resolution"
          disabled={busy || choices.resolutions.length < 2}
          onValueChange={(value) => change({ resolution: value })}
          options={choices.resolutions.map((resolution) => ({ id: resolution, label: resolution }))}
          value={options.resolution}
        />
        <OctantSelectField
          aria-label="Aspect ratio"
          disabled={busy || choices.aspectRatios.length < 2}
          onValueChange={(value) => change({ aspectRatio: value })}
          options={choices.aspectRatios.map((ratio) => ({ id: ratio, label: ratio }))}
          value={options.aspectRatio}
        />
        <OctantSelectField
          aria-label="Audio"
          disabled={busy || choices.audio.length < 2}
          onValueChange={(value) => change({ audio: value === "on" })}
          options={choices.audio.map((audio) => ({
            id: audio ? "on" : "off",
            label: audio ? "With audio" : "No audio",
          }))}
          value={options.audio ? "on" : "off"}
        />
      </div>
      <p className="follow-up-card__summary">{described.price}</p>
      {described.stop === undefined ? null : (
        <p className="follow-up-card__summary">{described.stop}</p>
      )}
      <p className="follow-up-card__summary">{described.retention}</p>
      {described.refusal === undefined ? null : (
        <p className="follow-up-card__summary">{described.refusal}</p>
      )}
      {pending.canRemember ? (
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
      <div className="follow-up-card__actions">
        <OctantButton
          disabled={busy}
          onClick={() => decide("cancel")}
          size="xs"
          type="button"
          variant="ghost"
        >
          Don't make it
        </OctantButton>
        <OctantButton
          disabled={busy || !described.approvable}
          onClick={() => decide("video-generate")}
          size="xs"
          type="button"
        >
          Generate
        </OctantButton>
      </div>
    </article>
  );
}

export function VideoSaveOfferCard({ offer: pending, busy, decide: answer }: VideoOfferCardProps) {
  if (pending.kind !== "video-save") return null;
  const decide = (decision: "video-save" | "cancel") =>
    answer({ offerId: pending.offerId, decision });
  return (
    <article aria-label="Video save request" className="follow-up-card">
      <div className="follow-up-card__head">
        <span className="follow-up-card__kind">
          <VideoIcon aria-hidden="true" size={12} /> Video · asked by the agent
        </span>
        <OctantIconButton
          disabled={busy}
          label="Don't save the clip"
          onClick={() => decide("cancel")}
          size="icon-xs"
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </OctantIconButton>
      </div>
      <p className="follow-up-card__title">Save this video clip as a new file?</p>
      <p className="follow-up-card__summary">
        The agent wants to save a clip this thread made in the folder it works in (
        {(pending.sizeBytes / 1_000_000).toFixed(1)} MB). An existing file is never replaced.
      </p>
      <p className="follow-up-card__prompt" title={pending.relativePath}>
        {pending.relativePath}
      </p>
      <div className="follow-up-card__actions">
        <OctantButton
          disabled={busy}
          onClick={() => decide("cancel")}
          size="xs"
          type="button"
          variant="ghost"
        >
          Don't save
        </OctantButton>
        <OctantButton disabled={busy} onClick={() => decide("video-save")} size="xs" type="button">
          Save
        </OctantButton>
      </div>
    </article>
  );
}
