import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type {
  ImageGenerationGenerateOffer,
  ImageGenerationOffer,
  ImageGenerationOfferDecision,
  ImageGenerationProfileView,
  ImageGenerationScopeId,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";
import { Image as ImageIcon, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import "../followUps/follow-up-suggestions.css";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";

const ACTIVE_OFFER_POLL_MS = 500;
const IDLE_OFFER_POLL_MS = 5_000;

interface ModelChoice {
  readonly id: string;
  readonly label: string;
  readonly profileInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

/** Every profile and model the person can generate with, the agent's suggestion first. */
function modelChoices(
  profiles: ReadonlyArray<ImageGenerationProfileView>,
  suggested: ImageGenerationGenerateOffer["suggested"],
): ReadonlyArray<ModelChoice> {
  const choices = profiles.flatMap((profile) =>
    profile.modelAllowlist.map((modelId) => {
      const source = profile.sourceLabels?.find(
        (candidate) => String(candidate.modelId) === String(modelId),
      )?.label;
      return {
        id: `${String(profile.instanceId)}::${String(modelId)}`,
        label: `${profile.displayName} · ${source ?? String(modelId)}`,
        profileInstanceId: profile.instanceId,
        modelId,
      };
    }),
  );
  const suggestedId = `${String(suggested.profileInstanceId)}::${String(suggested.modelId)}`;
  const first = choices.find((choice) => choice.id === suggestedId);
  // The window's profile list can lag the host's by a read; the suggestion is
  // still one the host can run, so it is offered under its own name.
  return first === undefined
    ? [
        {
          id: suggestedId,
          label: String(suggested.modelId),
          profileInstanceId: suggested.profileInstanceId,
          modelId: suggested.modelId,
        },
        ...choices,
      ]
    : [first, ...choices.filter((choice) => choice.id !== suggestedId)];
}

/**
 * The thread's agent asking to generate a picture with an image model instead
 * of drawing it itself, as a card at the foot of the thread. The person picks
 * the profile and model, may tell this thread not to ask again, or lets the
 * agent draw it after all. Nothing is spent until Generate, which the host
 * checks against the profiles it can run. The host lists only this window's
 * offers for this thread, oldest first.
 */
export function ImageGenerationOfferPrompt(props: {
  readonly client: ImageGenerationClient | undefined;
  readonly threadKind: "chat-thread" | "work-thread" | "code-thread";
  readonly scopeId: ImageGenerationScopeId | undefined;
  readonly profiles: ReadonlyArray<ImageGenerationProfileView>;
  /** A running turn is polled often, because its call is waiting on the answer. */
  readonly turnActive: boolean;
  readonly className?: string;
}) {
  const { client, scopeId, threadKind, turnActive } = props;
  const [offers, setOffers] = useState<ReadonlyArray<ImageGenerationOffer>>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const revision = useThreadActivityRevision("toolApprovals");
  const rememberId = useId();

  useEffect(() => {
    setOffers([]);
  }, [client, scopeId, threadKind]);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (client === undefined || scopeId === undefined) return;
      try {
        const listed = await client.offers({ threadKind, scopeId });
        if (signal.aborted) return;
        setOffers((current) => (samePollingData(current, listed.offers) ? current : listed.offers));
      } catch {
        if (!signal.aborted) setOffers((current) => (current.length === 0 ? current : []));
      }
    },
    [client, scopeId, threadKind],
  );
  useVisibleRefresh(
    refresh,
    revision,
    turnActive
      ? ACTIVE_OFFER_POLL_MS
      : revision === undefined
        ? IDLE_OFFER_POLL_MS
        : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const pending = offers[0];
  const pendingId = pending === undefined ? undefined : String(pending.offerId);
  // A new offer starts from the agent's suggestion and asks again next time
  // unless the person ticks the box for it.
  useEffect(() => {
    setSelected(undefined);
    setRemember(false);
    setMessage(undefined);
  }, [pendingId]);

  if (pending === undefined || client === undefined) return null;
  const choices =
    pending.kind === "generate" ? modelChoices(props.profiles, pending.suggested) : [];
  const choice = choices.find((candidate) => candidate.id === selected) ?? choices[0];

  async function decide(decision: "generate" | "agent-draws" | "save" | "cancel") {
    if (pending === undefined || client === undefined || busy) return;
    let answer: ImageGenerationOfferDecision;
    if (decision === "generate") {
      if (choice === undefined) return;
      answer = {
        offerId: pending.offerId,
        decision,
        profileInstanceId: choice.profileInstanceId,
        modelId: choice.modelId,
        rememberForThread: remember,
      };
    } else {
      answer = { offerId: pending.offerId, decision };
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await client.decideOffer(answer);
      if (result.kind === "image-offer-refused") {
        setMessage(result.reason);
        return;
      }
      // Answered or gone, the offer leaves this card; the agent's tool result
      // says what happened, and a generated image appears in this thread.
      setOffers((current) => current.filter((offer) => offer.offerId !== pending.offerId));
    } catch {
      setMessage("Your answer could not be sent. The request is still waiting; try again.");
    } finally {
      setBusy(false);
    }
  }

  if (pending.kind === "save") {
    return (
      <section
        aria-label="Asked by the agent"
        className={`follow-up-cards ${props.className ?? ""}`}
      >
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
            <OctantButton
              disabled={busy}
              onClick={() => void decide("save")}
              size="xs"
              type="button"
            >
              Save
            </OctantButton>
          </div>
        </article>
        {message === undefined ? null : (
          <OctantAlert className="follow-up-cards__error" tone="danger">
            {message}
          </OctantAlert>
        )}
      </section>
    );
  }

  const title = pending.revision
    ? "Revise this image with an image model?"
    : "Generate this image?";
  return (
    <section aria-label="Asked by the agent" className={`follow-up-cards ${props.className ?? ""}`}>
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
        <div className="follow-up-card__confirm">
          <OctantSelectField
            aria-label="Image model"
            disabled={busy}
            onValueChange={setSelected}
            options={choices.map((candidate) => ({ id: candidate.id, label: candidate.label }))}
            value={choice?.id ?? ""}
          />
          <label className="follow-up-card__summary" htmlFor={rememberId}>
            <OctantCheckbox
              checked={remember}
              disabled={busy}
              id={rememberId}
              onChange={(event) => setRemember(event.currentTarget.checked)}
            />{" "}
            Don't ask again in this thread
          </label>
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
      {message === undefined ? null : (
        <OctantAlert className="follow-up-cards__error" tone="danger">
          {message}
        </OctantAlert>
      )}
    </section>
  );
}
