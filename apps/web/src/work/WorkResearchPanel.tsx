import { useState } from "react";
import type { WorkResearchBriefView } from "@octant/client-runtime/work-research-client";
import { AlertTriangle, BookOpen, FileText, Quote } from "lucide-react";
import type { WorkResearchMutationOutcome, WorkResearchStatus } from "./useWorkResearchController";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";

export interface WorkResearchPanelProps {
  readonly briefs: ReadonlyArray<WorkResearchBriefView>;
  readonly status: WorkResearchStatus;
  readonly onRetry?: () => void;
  readonly onCreateBrief?: (input: {
    readonly question: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onAddSource?: (input: {
    readonly briefId: string;
    readonly file: File;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onRevokeSource?: (input: {
    readonly briefId: string;
    readonly sourceId: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onRecordEvidence?: (input: {
    readonly briefId: string;
    readonly sourceId: string;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onRecordClaim?: (input: {
    readonly briefId: string;
    readonly text: string;
    readonly citationAnchors?: ReadonlyArray<string>;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onFinalizeReport?: (input: {
    readonly briefId: string;
  }) => Promise<WorkResearchMutationOutcome>;
}

const STATUS_COPY: Record<Exclude<WorkResearchStatus, "ready">, string> = {
  idle: "Research is unavailable for this Project.",
  loading: "Loading research…",
  unauthorized: "Research is not authorized in this window.",
  unavailable: "The host research service is unavailable.",
  failure: "Research could not be loaded.",
};

/**
 * Work research provenance.
 *
 * Every claim is shown with the citation anchors that support it, and a claim
 * the host marked unsupported is labeled with an icon *and* words so the
 * distinction never depends on colour alone. Sources display their confined
 * relative reference and host-classified availability; the renderer never
 * derives freshness or resolves a host path itself.
 *
 * When mutation handlers are supplied the panel also proposes commands: a
 * "New research brief" form creates a draft brief; an open brief can add a
 * file source from the approved Project folder, record evidence against one of
 * its sources, record a claim citing the evidence the user selected, revoke a
 * source, and finalize a report. Every form is a proposal only — the server
 * validates authority, policy, and provenance before any state changes, and
 * the panel re-reads the host projection rather than trusting the proposal.
 * Denials are shown in the host's own words, including the honest `stale`
 * outcome when a source file changed after it was added.
 */
export function WorkResearchPanel(props: WorkResearchPanelProps) {
  if (props.status !== "ready") {
    return (
      <section aria-label="Work research" className="work-research">
        <h3 className="work-research__title">Research</h3>
        <p className="work-research__empty" role="note">
          {STATUS_COPY[props.status]}
        </p>
        {props.onRetry !== undefined && props.status !== "loading" ? (
          <OctantButton
            className="work-research__retry"
            onClick={props.onRetry}
            type="button"
            variant="outline"
          >
            Retry
          </OctantButton>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label="Work research" className="work-research">
      <h3 className="work-research__title">Research</h3>
      {props.onCreateBrief === undefined ? null : (
        <NewBriefForm onCreateBrief={props.onCreateBrief} />
      )}
      {props.briefs.length === 0 ? (
        <p className="work-research__empty" role="note">
          This Project has no research briefs.
        </p>
      ) : (
        <ul className="work-research__briefs">
          {props.briefs.map((view) => (
            <li key={String(view.briefId)}>
              <BriefCard
                view={view}
                {...(props.onAddSource === undefined ? {} : { onAddSource: props.onAddSource })}
                {...(props.onRevokeSource === undefined
                  ? {}
                  : { onRevokeSource: props.onRevokeSource })}
                {...(props.onRecordEvidence === undefined
                  ? {}
                  : { onRecordEvidence: props.onRecordEvidence })}
                {...(props.onRecordClaim === undefined
                  ? {}
                  : { onRecordClaim: props.onRecordClaim })}
                {...(props.onFinalizeReport === undefined
                  ? {}
                  : { onFinalizeReport: props.onFinalizeReport })}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewBriefForm(props: {
  readonly onCreateBrief: (input: {
    readonly question: string;
  }) => Promise<WorkResearchMutationOutcome>;
}) {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const trimmed = question.trim();

  const submit = async () => {
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setMessage(undefined);
    const outcome = await props.onCreateBrief({ question: trimmed });
    setPending(false);
    if (outcome.kind === "accepted") {
      setQuestion("");
      return;
    }
    setMessage(outcome.message);
  };

  return (
    <form
      className="work-research__new-brief"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="work-research__new-brief-label" htmlFor="work-research-new-brief">
        Research question
      </label>
      <OctantInput
        className="work-research__new-brief-input"
        disabled={pending}
        id="work-research-new-brief"
        onChange={(event) => setQuestion(event.currentTarget.value)}
        value={question}
      />
      <OctantButton
        className="work-research__new-brief-submit"
        disabled={pending || trimmed.length === 0}
        type="submit"
      >
        New research brief
      </OctantButton>
      {message === undefined ? null : (
        <p className="work-research__new-brief-error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

function BriefCard(props: {
  readonly view: WorkResearchBriefView;
  readonly onAddSource?: (input: {
    readonly briefId: string;
    readonly file: File;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onRevokeSource?: (input: {
    readonly briefId: string;
    readonly sourceId: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onRecordEvidence?: (input: {
    readonly briefId: string;
    readonly sourceId: string;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onRecordClaim?: (input: {
    readonly briefId: string;
    readonly text: string;
    readonly citationAnchors?: ReadonlyArray<string>;
  }) => Promise<WorkResearchMutationOutcome>;
  readonly onFinalizeReport?: (input: {
    readonly briefId: string;
  }) => Promise<WorkResearchMutationOutcome>;
}) {
  const { brief, sources, claims, evidence, report, revokedSourceIds } = props.view;
  const revoked = new Set(revokedSourceIds.map(String));
  const open = brief.status !== "finalized" && brief.status !== "cancelled";
  const briefId = String(props.view.briefId);
  const sourceNames = new Map(
    sources.map((source) => [String(source.sourceId), source.displayName]),
  );
  // Only a fresh, unrevoked source can back new evidence; the host refuses the
  // rest, so the panel does not offer them.
  const citableSources = sources.filter(
    (source) => source.availability === "fresh" && !revoked.has(String(source.sourceId)),
  );

  return (
    <article className="work-research__brief" data-status={brief.status}>
      <header className="work-research__brief-header">
        <BookOpen aria-hidden="true" size={14} strokeWidth={1.8} />
        <span className="work-research__brief-status">{brief.status}</span>
        <span className="work-research__brief-meta">
          {sources.length} source{sources.length === 1 ? "" : "s"} · {evidence.length} evidence ·{" "}
          {claims.length} claim{claims.length === 1 ? "" : "s"}
        </span>
      </header>

      <ul className="work-research__questions">
        {brief.questions.map((question, index) => (
          <li key={`${String(brief.briefId)}-q${index}`}>{question}</li>
        ))}
      </ul>

      {sources.length > 0 ? (
        <section aria-label="Sources" className="work-research__sources">
          <h4>Sources</h4>
          <ul>
            {sources.map((source) => (
              <li key={String(source.sourceId)} data-availability={source.availability}>
                <FileText aria-hidden="true" size={13} strokeWidth={1.8} />
                <span className="work-research__source-name">{source.displayName}</span>
                <span className="work-research__source-ref">{source.sourceRef}</span>
                <span className="work-research__source-availability">
                  {revoked.has(String(source.sourceId)) ? "revoked" : source.availability}
                </span>
                {open &&
                props.onRevokeSource !== undefined &&
                !revoked.has(String(source.sourceId)) ? (
                  <RevokeSourceButton
                    briefId={briefId}
                    displayName={source.displayName}
                    onRevokeSource={props.onRevokeSource}
                    sourceId={String(source.sourceId)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open && props.onAddSource !== undefined ? (
        <AddSourceForm briefId={briefId} onAddSource={props.onAddSource} />
      ) : null}

      {evidence.length > 0 ? (
        <section aria-label="Evidence" className="work-research__evidence">
          <h4>Evidence</h4>
          <ul>
            {evidence.map((entry) => (
              <li key={String(entry.evidenceId)}>
                <span className="work-research__evidence-source">
                  {sourceNames.get(String(entry.sourceId)) ?? "Unknown source"}
                </span>
                <span className="work-research__evidence-excerpt">{entry.excerpt}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open && props.onRecordEvidence !== undefined && citableSources.length > 0 ? (
        <EvidenceForm
          briefId={briefId}
          onRecordEvidence={props.onRecordEvidence}
          sources={citableSources}
        />
      ) : null}

      {claims.length > 0 ? (
        <section aria-label="Claims" className="work-research__claims">
          <h4>Claims</h4>
          <ul>
            {claims.map((claim) => (
              <li key={String(claim.claimId)} data-unsupported={claim.unsupported}>
                {claim.unsupported ? (
                  <AlertTriangle aria-hidden="true" size={13} strokeWidth={1.8} />
                ) : (
                  <Quote aria-hidden="true" size={13} strokeWidth={1.8} />
                )}
                <span className="work-research__claim-text">{claim.text}</span>
                <span className="work-research__claim-support">
                  {claim.unsupported
                    ? "Unsupported"
                    : `${claim.citationAnchors.length} citation${
                        claim.citationAnchors.length === 1 ? "" : "s"
                      }`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open && props.onRecordClaim !== undefined ? (
        <ClaimForm briefId={briefId} evidence={evidence} onRecordClaim={props.onRecordClaim} />
      ) : null}

      {open && props.onFinalizeReport !== undefined && claims.length > 0 ? (
        <FinalizeReportButton briefId={briefId} onFinalizeReport={props.onFinalizeReport} />
      ) : null}

      {report === undefined ? null : (
        <p className="work-research__report" role="note">
          Report finalized with {report.claims.length} claim
          {report.claims.length === 1 ? "" : "s"} and {report.evidence.length} evidence entr
          {report.evidence.length === 1 ? "y" : "ies"}. This brief is now read-only.
        </p>
      )}
    </article>
  );
}

/**
 * Add one file source from the top level of the approved Project folder. The
 * panel proposes the picked file's basename and a user-written excerpt; the
 * host resolves the name directly beneath the bound root, re-reads the bytes,
 * and refuses anything it cannot observe there, so picking a file elsewhere can
 * only fail. A browser pick cannot name a subfolder, so the label states that
 * rule before the pick and the controller refuses a folder pick outright.
 */
function AddSourceForm(props: {
  readonly briefId: string;
  readonly onAddSource: (input: {
    readonly briefId: string;
    readonly file: File;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
}) {
  const [file, setFile] = useState<File | undefined>(undefined);
  // Remount token: clearing the picked file must also clear what the file
  // input shows, so an accepted source cannot be resubmitted by accident.
  const [pickerGeneration, setPickerGeneration] = useState(0);
  const [excerpt, setExcerpt] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const fileId = `work-research-source-file-${props.briefId}`;
  const excerptId = `work-research-source-excerpt-${props.briefId}`;
  const trimmed = excerpt.trim();

  const submit = async () => {
    if (file === undefined || trimmed.length === 0 || pending) return;
    setPending(true);
    setMessage(undefined);
    const outcome = await props.onAddSource({ briefId: props.briefId, file, excerpt: trimmed });
    setPending(false);
    if (outcome.kind === "accepted") {
      setFile(undefined);
      setPickerGeneration((generation) => generation + 1);
      setExcerpt("");
      return;
    }
    setMessage(outcome.message);
  };

  return (
    <form
      className="work-research__source-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="work-research__source-form-label" htmlFor={fileId}>
        Source file (top level of the Project folder)
      </label>
      <OctantInput
        className="work-research__source-form-file"
        disabled={pending}
        id={fileId}
        key={pickerGeneration}
        onChange={(event) => setFile(event.currentTarget.files?.[0])}
        type="file"
      />
      <label className="work-research__source-form-label" htmlFor={excerptId}>
        Source excerpt
      </label>
      <input
        className="work-research__source-form-input"
        disabled={pending}
        id={excerptId}
        onChange={(event) => setExcerpt(event.currentTarget.value)}
        value={excerpt}
      />
      <OctantButton
        className="work-research__source-form-submit"
        disabled={pending || file === undefined || trimmed.length === 0}
        type="submit"
      >
        Add source
      </OctantButton>
      {message === undefined ? null : (
        <p className="work-research__source-form-error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

function RevokeSourceButton(props: {
  readonly briefId: string;
  readonly displayName: string;
  readonly sourceId: string;
  readonly onRevokeSource: (input: {
    readonly briefId: string;
    readonly sourceId: string;
  }) => Promise<WorkResearchMutationOutcome>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setMessage(undefined);
    const outcome = await props.onRevokeSource({
      briefId: props.briefId,
      sourceId: props.sourceId,
    });
    setPending(false);
    if (outcome.kind === "rejected") setMessage(outcome.message);
  };

  return (
    <>
      <OctantButton
        aria-label={`Revoke ${props.displayName}`}
        className="work-research__source-revoke"
        disabled={pending}
        onClick={() => void submit()}
        type="button"
      >
        Revoke
      </OctantButton>
      {message === undefined ? null : (
        <span className="work-research__source-revoke-error" role="alert">
          {message}
        </span>
      )}
    </>
  );
}

/**
 * Record one bounded excerpt against a source of this brief. The host
 * re-observes the source before journaling, so a file the user edited since it
 * was added answers `stale` and the panel says exactly that.
 */
function EvidenceForm(props: {
  readonly briefId: string;
  readonly sources: WorkResearchBriefView["sources"];
  readonly onRecordEvidence: (input: {
    readonly briefId: string;
    readonly sourceId: string;
    readonly excerpt: string;
  }) => Promise<WorkResearchMutationOutcome>;
}) {
  const firstSourceId = String(props.sources[0]?.sourceId ?? "");
  const [sourceId, setSourceId] = useState(firstSourceId);
  const [excerpt, setExcerpt] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const sourceSelectId = `work-research-evidence-source-${props.briefId}`;
  const excerptId = `work-research-evidence-excerpt-${props.briefId}`;
  const trimmed = excerpt.trim();
  const selected = props.sources.some((source) => String(source.sourceId) === sourceId)
    ? sourceId
    : firstSourceId;

  const submit = async () => {
    if (selected.length === 0 || trimmed.length === 0 || pending) return;
    setPending(true);
    setMessage(undefined);
    const outcome = await props.onRecordEvidence({
      briefId: props.briefId,
      sourceId: selected,
      excerpt: trimmed,
    });
    setPending(false);
    if (outcome.kind === "accepted") {
      setExcerpt("");
      return;
    }
    setMessage(outcome.message);
  };

  return (
    <form
      className="work-research__evidence-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="work-research__evidence-form-label" htmlFor={sourceSelectId}>
        Evidence source
      </label>
      <OctantSelectField
        className="work-research__evidence-form-source"
        disabled={pending}
        id={sourceSelectId}
        onValueChange={setSourceId}
        options={props.sources.map((source) => ({
          id: String(source.sourceId),
          label: source.displayName,
        }))}
        value={selected}
      />
      <label className="work-research__evidence-form-label" htmlFor={excerptId}>
        Evidence excerpt
      </label>
      <OctantInput
        className="work-research__evidence-form-input"
        disabled={pending}
        id={excerptId}
        onChange={(event) => setExcerpt(event.currentTarget.value)}
        value={excerpt}
      />
      <OctantButton
        className="work-research__evidence-form-submit"
        disabled={pending || trimmed.length === 0}
        type="submit"
      >
        Record evidence
      </OctantButton>
      {message === undefined ? null : (
        <p className="work-research__evidence-form-error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

function ClaimForm(props: {
  readonly briefId: string;
  readonly evidence: WorkResearchBriefView["evidence"];
  readonly onRecordClaim: (input: {
    readonly briefId: string;
    readonly text: string;
    readonly citationAnchors?: ReadonlyArray<string>;
  }) => Promise<WorkResearchMutationOutcome>;
}) {
  const [text, setText] = useState("");
  const [anchors, setAnchors] = useState<ReadonlyArray<string>>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const inputId = `work-research-claim-${props.briefId}`;
  const trimmed = text.trim();
  // Only anchors still present in the host projection are cited; a claim with
  // none is recorded honestly and the host flags it unsupported.
  const cited = props.evidence
    .map((entry) => String(entry.citationAnchor))
    .filter((anchor) => anchors.includes(anchor));

  const submit = async () => {
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setMessage(undefined);
    const outcome = await props.onRecordClaim({
      briefId: props.briefId,
      text: trimmed,
      citationAnchors: cited,
    });
    setPending(false);
    if (outcome.kind === "accepted") {
      setText("");
      setAnchors([]);
      return;
    }
    setMessage(outcome.message);
  };

  return (
    <form
      className="work-research__claim-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="work-research__claim-form-label" htmlFor={inputId}>
        New claim
      </label>
      <OctantInput
        className="work-research__claim-form-input"
        disabled={pending}
        id={inputId}
        onChange={(event) => setText(event.currentTarget.value)}
        value={text}
      />
      {props.evidence.length === 0 ? null : (
        <fieldset className="work-research__claim-form-citations">
          <legend>Cite evidence</legend>
          {props.evidence.map((entry) => {
            const anchor = String(entry.citationAnchor);
            return (
              <label key={String(entry.evidenceId)}>
                <OctantCheckbox
                  checked={anchors.includes(anchor)}
                  disabled={pending}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setAnchors((current) =>
                      checked
                        ? [...current, anchor]
                        : current.filter((candidate) => candidate !== anchor),
                    );
                  }}
                />
                {entry.excerpt}
              </label>
            );
          })}
        </fieldset>
      )}
      <OctantButton
        className="work-research__claim-form-submit"
        disabled={pending || trimmed.length === 0}
        type="submit"
      >
        Add claim
      </OctantButton>
      {message === undefined ? null : (
        <p className="work-research__claim-form-error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

/**
 * Finalize the brief into a report. The host writes the deliverable through
 * the ordinary Work artifact workflow and then refuses every further
 * transition on the brief, so the panel offers this only while it is open.
 */
function FinalizeReportButton(props: {
  readonly briefId: string;
  readonly onFinalizeReport: (input: {
    readonly briefId: string;
  }) => Promise<WorkResearchMutationOutcome>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setMessage(undefined);
    const outcome = await props.onFinalizeReport({ briefId: props.briefId });
    setPending(false);
    if (outcome.kind === "rejected") setMessage(outcome.message);
  };

  return (
    <div className="work-research__finalize">
      <OctantButton
        className="work-research__finalize-submit"
        disabled={pending}
        onClick={() => void submit()}
        type="button"
      >
        Finalize report
      </OctantButton>
      {message === undefined ? null : (
        <p className="work-research__finalize-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
