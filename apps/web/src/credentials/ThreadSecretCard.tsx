import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import type {
  ThreadSecretAnswer,
  ThreadSecretAnswerField,
  ThreadSecretCommandResult,
  ThreadSecretFailure,
  ThreadSecretLifetime,
  ThreadSecretRequestCard,
  ThreadSecretSource,
} from "@octant/contracts/thread-secrets";
import { isHoldableSecretValue } from "@octant/domain/secret-guard-policy";
import { OctantAlert } from "../ui/base/OctantAlert";
import { octantButtonClassName, OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { Check, ExternalLink, Eye, EyeOff, Minus, ShieldCheck, X } from "../ui/icons";
import "./threadSecrets.css";

type Card = ThreadSecretRequestCard;
type CardField = Card["fields"][number];

/** One field's unsent answer. Nothing of another source's is kept when it changes. */
interface Draft {
  readonly source: ThreadSecretSource;
  readonly text: string;
  readonly freshEachUse: boolean;
  readonly rememberedId: string;
}

const EMPTY: Draft = { source: "pasted", text: "", freshEachUse: false, rememberedId: "" };

const LIFETIMES: Readonly<
  Record<ThreadSecretLifetime, { readonly label: string; readonly until: string }>
> = {
  "this-command": { label: "This command", until: "for one command" },
  "this-turn": { label: "This turn", until: "until this turn ends" },
  "1-hour": { label: "1 hour", until: "for 1 hour" },
  "24-hours": { label: "24 hours", until: "for 24 hours" },
  "until-archived": { label: "Until archived", until: "until this thread is archived" },
  remember: {
    label: "Remember",
    until: "until this thread is archived, and Octant remembers it for later cards",
  },
};

const SOURCES: Readonly<Record<ThreadSecretSource, string>> = {
  pasted: "Value",
  onepassword: "1Password",
  remembered: "Remembered",
};

const FAILURES: Readonly<Record<ThreadSecretFailure, string>> = {
  declined: "This request was declined.",
  expired: "This request has ended.",
  revoked: "This request has ended.",
  locked: "Unlock 1Password on this computer, then try again, or enter the value.",
  missing: "Nothing was found there. Check it, or enter the value.",
  unavailable: "Octant could not save it. Try again, or enter the value.",
  "not-linked": "1Password answers work only on this computer, with a linked store.",
  "invalid-reference": "That reference does not name one secret. Check it, or enter the value.",
  "refused-by-strict": "Strict does not allow that. Choose a shorter time.",
  "lifetime-not-offered": "That time is not offered for this secret. Choose another.",
  "unsupported-mode": "This thread takes no secrets.",
};

const NOT_A_REFERENCE = "Use a 1Password reference like op://vault/item/field.";
const NOT_TAKEN = "This window could not send it. Try again.";
const MAX_VALUE_LENGTH = 4096;
const TOO_LONG = "That is longer than 4,096 characters, so none of it was pasted.";
const UNKNOWN_OUTCOME =
  "The result is not known. What you entered was cleared and is not sent again.";

/** The host's answer, or that it refused the request with nothing read from it. */
export type ThreadSecretReply = ThreadSecretCommandResult | { readonly status: "not-taken" };

/**
 * Asks the person for a secret. What is typed stays in this card until it is
 * sent to the host, and is in no state, storage or message but that one.
 */
export function ThreadSecretCard(props: {
  readonly card: Card;
  readonly answer: (answer: ThreadSecretAnswer) => Promise<ThreadSecretReply>;
}) {
  const { card } = props;
  if (card.state === "pending" || card.state === "saving")
    return <PendingCard key={card.id} {...props} />;
  const saved = card.state === "saved";
  return (
    <div className="thread-secret-result" role="status" data-state={card.state}>
      {saved ? <Check size={14} aria-hidden="true" /> : <Minus size={14} aria-hidden="true" />}
      <span>
        {card.label} ·{" "}
        {saved ? "Saved securely" : card.state === "declined" ? "Declined" : "Closed"}
      </span>
    </div>
  );
}

function PendingCard({ card, answer }: Parameters<typeof ThreadSecretCard>[0]) {
  const id = useId();
  const multiple = card.fields.length > 1 || card.fields[0]?.name !== card.name;
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [lifetime, setLifetime] = useState(card.defaultLifetime);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // Enter and a click can both submit before a render.
  const inFlight = useRef(false);
  const busy = sending || card.state === "saving";
  const shownError = error ?? (card.failure === undefined ? undefined : FAILURES[card.failure]);
  const draftOf = (field: CardField): Draft => drafts[field.name] ?? EMPTY;
  const set = (field: CardField, next: Partial<Draft>) => {
    setError(undefined);
    setDrafts((current) => ({
      ...current,
      [field.name]: { ...(current[field.name] ?? EMPTY), ...next },
    }));
  };
  const complete = card.fields.every((field) => isComplete(draftOf(field), card, field));
  const tooPlain = card.fields.some((field) => {
    const draft = draftOf(field);
    return (
      field.secret &&
      draft.source === "pasted" &&
      draft.text.trim() !== "" &&
      !isHoldableSecretValue(draft.text)
    );
  });

  const send = async (value: ThreadSecretAnswer) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(undefined);
    // Emptied before it leaves, so no browser offers to keep it as a sign-in.
    const typed = drafts;
    setDrafts({});
    try {
      const result = await answer(value);
      if (result.status === "refused" || result.status === "not-taken") {
        setDrafts(typed);
        setError(result.status === "refused" ? FAILURES[result.failure] : NOT_TAKEN);
      } else if (result.status === "gone") setError(FAILURES.expired);
    } catch {
      setError(UNKNOWN_OUTCOME);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !complete) return;
    const wrong = card.fields.some((field) => {
      const draft = draftOf(field);
      return draft.source === "onepassword" && !/^op:\/\/\S/u.test(draft.text.trim());
    });
    if (wrong) {
      setError(NOT_A_REFERENCE);
      return;
    }
    void send({
      id: card.id,
      action: "save",
      lifetime,
      fields: card.fields.map((field) => answerOf(draftOf(field), card, field)),
    });
  };

  // On click, not pointer down: the press that follows would take focus back.
  // A click that ends a selection leaves it, so the reason can be copied.
  const onClick = (event: MouseEvent<HTMLFormElement>) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("input, button, a, label, [role='combobox'], [role='option']")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const empty = card.fields.findIndex((field) => !isComplete(draftOf(field), card, field));
    document.getElementById(`${id}-${Math.max(empty, 0)}`)?.focus();
  };

  const describedBy = `${id}-privacy${shownError === undefined ? "" : ` ${id}-error`}`;
  const fields = card.fields.map((field, index) => (
    <SecretField
      key={field.name}
      id={`${id}-${index}`}
      card={card}
      field={field}
      draft={draftOf(field)}
      labelled={multiple}
      disabled={busy}
      invalid={shownError !== undefined}
      describedBy={describedBy}
      onChange={(next) => set(field, next)}
      onProblem={setError}
      action={
        multiple ? null : (
          <OctantButton type="submit" disabled={busy || !complete} aria-busy={busy}>
            Save securely
          </OctantButton>
        )
      }
    />
  ));
  const link = card.url === undefined ? undefined : new URL(card.url);

  return (
    <form
      noValidate
      className="thread-secret-card"
      aria-labelledby={`${id}-title`}
      autoComplete="off"
      onSubmit={onSubmit}
      onClick={onClick}
    >
      <div className="thread-secret-card__heading">
        {multiple ? (
          <p id={`${id}-title`} className="thread-secret-card__title">
            {card.label}
          </p>
        ) : (
          <label id={`${id}-title`} htmlFor={`${id}-0`} className="thread-secret-card__title">
            {card.label}
          </label>
        )}
        <p className="thread-secret-card__reason">{card.reason}</p>
      </div>
      {link === undefined ? null : (
        <div className="thread-secret-card__link">
          <a
            className={octantButtonClassName({ variant: "outline", size: "sm" })}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open {link.host}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          <p className="thread-secret-card__address">{link.href}</p>
        </div>
      )}
      {multiple ? <div className="thread-secret-card__fields">{fields}</div> : fields}
      {card.kind === "account-password" ? (
        <p className="thread-secret-card__warning">
          An account password unlocks this whole computer, not only what the agent asked for. Octant
          cannot fill in a system dialog: type it into a system dialog yourself.
        </p>
      ) : null}
      {tooPlain ? (
        <p className="thread-secret-card__note">
          Too short to hide if a command prints it. A longer value is hidden.
        </p>
      ) : null}
      {shownError === undefined ? null : (
        <OctantAlert role="alert" tone="danger">
          <p id={`${id}-error`}>{shownError}</p>
        </OctantAlert>
      )}
      <div className="thread-secret-card__footer">
        <p id={`${id}-privacy`} className="thread-secret-card__privacy">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>{privacyNote(card, lifetime)}</span>
        </p>
        <div className="thread-secret-card__actions">
          <OctantSelectField
            aria-label="Keep for"
            className="thread-secret-card__lifetime"
            disabled={busy}
            options={card.lifetimes.map((value) => ({ id: value, label: LIFETIMES[value].label }))}
            value={lifetime}
            onValueChange={(value) => {
              const next = card.lifetimes.find((candidate) => candidate === value);
              if (next !== undefined) setLifetime(next);
            }}
          />
          <OctantButton
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void send({ id: card.id, action: "decline" })}
          >
            Decline
          </OctantButton>
          {multiple ? (
            <OctantButton type="submit" disabled={busy || !complete} aria-busy={busy}>
              Save securely
            </OctantButton>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function SecretField(props: {
  readonly id: string;
  readonly card: Card;
  readonly field: CardField;
  readonly draft: Draft;
  readonly labelled: boolean;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly onChange: (next: Partial<Draft>) => void;
  readonly onProblem: (problem: string) => void;
  readonly action: React.ReactNode;
}) {
  const { card, field, draft, id } = props;
  const [revealed, setRevealed] = useState(false);
  // What was shown has gone; the next value starts hidden.
  useEffect(() => {
    if (draft.text === "") setRevealed(false);
  }, [draft.text]);
  const remembered = rememberedFor(card, field);
  const sources = card.sources.filter((source) => source !== "remembered" || remembered.length > 0);
  const typed = draft.source === "pasted";
  const lines = typed ? linesOf(draft.text) : 1;
  const masked = lines === 1 && typed && field.secret && !(revealed && !props.disabled);
  // An input keeps one line and cuts at its limit, both without a word.
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (!typed) return;
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    const pasted = event.clipboardData.getData("text/plain");
    // An image or a file has no text to answer with.
    if (pasted === "") return;
    // Over a count of lines there is no text to paste into: it is replaced.
    const text =
      lines > 1
        ? pasted
        : value.slice(0, selectionStart ?? value.length) +
          pasted +
          value.slice(selectionEnd ?? value.length);
    if (text.length > MAX_VALUE_LENGTH) {
      event.preventDefault();
      props.onProblem(TOO_LONG);
    } else if (lines > 1 || linesOf(text) > 1) {
      event.preventDefault();
      // What was shown has gone; what replaces it starts hidden.
      setRevealed(false);
      props.onChange({ text: linesOf(text) > 1 ? text : text.replace(/[\r\n]+$/u, "") });
    }
  };
  return (
    <div className="thread-secret-card__field">
      {props.labelled ? (
        <label htmlFor={id} className="thread-secret-card__label">
          {field.label}
        </label>
      ) : null}
      <div className="thread-secret-card__row">
        {sources.length > 1 ? (
          <OctantSelectField
            aria-label={`Source for ${field.label}`}
            className="thread-secret-card__source"
            disabled={props.disabled}
            options={sources.map((source) => ({ id: source, label: SOURCES[source] }))}
            value={draft.source}
            onValueChange={(value) => {
              const source = sources.find((candidate) => candidate === value);
              if (source === undefined || source === draft.source) return;
              setRevealed(false);
              props.onChange({ ...EMPTY, source, rememberedId: remembered[0]?.id ?? "" });
            }}
          />
        ) : null}
        {draft.source === "remembered" ? (
          <div className="thread-secret-card__input thread-secret-card__remembered">
            <OctantSelectField
              aria-label={`Remembered value for ${field.label}`}
              disabled={props.disabled}
              options={remembered.map((entry) => ({
                id: entry.id,
                label: entry.source === "onepassword" ? `${entry.name} · 1Password` : entry.name,
              }))}
              value={draft.rememberedId}
              onValueChange={(rememberedId) => props.onChange({ rememberedId })}
            />
          </div>
        ) : (
          <div className="thread-secret-card__input">
            <OctantInput
              id={id}
              // A field masked by style alone still reads its value aloud.
              type={masked ? "password" : "text"}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              data-mono={typed ? undefined : ""}
              placeholder={typed ? field.placeholder : "op://vault/item/field"}
              maxLength={typed ? MAX_VALUE_LENGTH : 512}
              readOnly={lines > 1}
              value={lines > 1 ? `${String(lines)} lines pasted` : draft.text}
              disabled={props.disabled}
              aria-invalid={props.invalid || undefined}
              aria-describedby={props.describedBy}
              onChange={(event) => props.onChange({ text: event.target.value })}
              onPaste={onPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
              }}
            />
            {lines > 1 ? (
              <OctantIconButton
                className="thread-secret-card__reveal"
                type="button"
                label={`Clear ${field.label}`}
                size="icon-xs"
                disabled={props.disabled}
                onClick={() => props.onChange({ text: "" })}
              >
                <X size={12} />
              </OctantIconButton>
            ) : typed && field.secret ? (
              <OctantIconButton
                className="thread-secret-card__reveal"
                type="button"
                label={`Show ${field.label}`}
                size="icon-xs"
                aria-pressed={revealed}
                disabled={props.disabled}
                // Keeps focus, and the caret, in the input.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setRevealed((current) => !current)}
              >
                {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
              </OctantIconButton>
            ) : null}
          </div>
        )}
        {props.action}
      </div>
      {draft.source === "onepassword" ? (
        <label className="thread-secret-card__fresh">
          <OctantCheckbox
            checked={draft.freshEachUse}
            disabled={props.disabled}
            onChange={(event) => props.onChange({ freshEachUse: event.target.checked })}
          />
          Read it again at each use and keep no copy
        </label>
      ) : null}
    </div>
  );
}

/** A line break at the end adds no line: an input drops it, and so does a shell's `$(…)`. */
function linesOf(text: string): number {
  return text.replace(/[\r\n]+$/u, "").split(/\r\n|\r|\n/u).length;
}

/** The names a card's fields were saved under carry the request's, unless it has one unnamed value. */
function rememberedFor(card: Card, field: CardField): Card["remembered"] {
  const name = field.name === card.name ? card.name : `${card.name}_${field.name}`;
  return card.remembered.filter((entry) => entry.name === name);
}

function isComplete(draft: Draft, card: Card, field: CardField): boolean {
  return draft.source === "remembered"
    ? rememberedFor(card, field).some(({ id }) => id === draft.rememberedId)
    : draft.text.trim() !== "";
}

function answerOf(draft: Draft, card: Card, field: CardField): ThreadSecretAnswerField {
  switch (draft.source) {
    case "pasted":
      // Exactly as typed: spaces in a password matter.
      return { name: field.name, source: "pasted", value: draft.text };
    case "onepassword":
      return {
        name: field.name,
        source: "onepassword",
        store: "onepassword",
        reference: draft.text.trim(),
        freshEachUse: draft.freshEachUse,
      };
    case "remembered":
      return { name: field.name, source: "remembered", rememberedId: draft.rememberedId };
  }
}

/** What the agent asked for, in Octant's words: its kind, who can use it, and for how long. */
function privacyNote(card: Card, lifetime: ThreadSecretLifetime): string {
  const kind = card.kind === "account-password" ? "Account password" : "Token";
  const { until } = LIFETIMES[lifetime];
  return card.delivery === "handle"
    ? `${kind} kept out of chat. Only an Octant tool can use it, ${until}.`
    : `${kind} kept out of chat. Commands in this thread can read it ${until}.`;
}
