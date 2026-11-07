import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CodeThreadId } from "@octant/contracts";
import {
  decodeProviderCloudJobId,
  decodeProviderCloudInputDigest,
  MAX_PROVIDER_CLOUD_INPUT,
  type ProviderCloudRequest,
  type ProviderCloudResponse,
} from "@octant/contracts/provider-cloud-sessions";
import type { ProviderCloudSessionClient } from "@octant/client-runtime/provider-cloud-session-client";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantAlert } from "../ui/base/OctantAlert";

type Ready = Extract<ProviderCloudResponse, { readonly status: "ready" }>;

export function ProviderCloudSessions(props: {
  readonly client: ProviderCloudSessionClient;
  readonly threadId: CodeThreadId;
}) {
  const [view, setView] = useState<Ready>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [acknowledged, setAcknowledged] = useState<
    NonNullable<
      Extract<ProviderCloudRequest, { readonly kind: "start" }>["acknowledgedUnknownJobs"]
    >
  >([]);
  const textId = useId();
  const consentId = useId();
  const context = useMemo(
    () => ({ client: props.client, threadId: props.threadId }),
    [props.client, props.threadId],
  );
  const active = useRef(context);
  active.current = context;
  useEffect(() => {
    const abort = new AbortController();
    setView(undefined);
    setBusy(true);
    setMessage("");
    setText("");
    setProvider("");
    setModel("");
    setReviewed(false);
    setConsent(false);
    setAcknowledged([]);
    void context.client
      .execute({ kind: "list", threadId: context.threadId }, abort.signal)
      .then((result) => {
        if (abort.signal.aborted || active.current !== context) return;
        if (result.status === "ready") setView(result);
        else setMessage("Cloud sessions are unavailable for this local Code thread.");
        setBusy(false);
      });
    return () => abort.abort();
  }, [context]);
  const send = async (command: ProviderCloudRequest) => {
    const owner = context;
    setBusy(true);
    setMessage("");
    const result = await owner.client.execute(command);
    if (active.current !== owner) return;
    if (result.status === "ready") setView(result);
    else {
      if (result.reason !== "busy") setView(undefined);
      setMessage(
        result.reason === "busy"
          ? "An earlier cloud task may still be active. Check its status or acknowledge an uncertain submission before reviewing a new task."
          : result.reason === "unsupported-budget"
            ? "This provider cannot enforce the required cloud spend bound. Keep this task local."
            : "The request could not be confirmed. Refresh saved sessions; remote work may still be running.",
      );
    }
    setBusy(false);
  };
  const profiles = view?.profiles.filter((item) => item.supported && item.enabled) ?? [];
  const selected = profiles.find((item) => String(item.instanceId) === provider) ?? profiles[0];
  const selectedModel = selected?.models.find((id) => String(id) === model) ?? selected?.models[0];
  const resetReview = () => {
    setReviewed(false);
    setConsent(false);
    setAcknowledged([]);
  };
  const run = async () => {
    if (selected === undefined || selectedModel === undefined || !reviewed || !consent) return;
    const owner = context;
    const snapshot = text;
    setBusy(true);
    try {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot));
      if (active.current !== owner) return;
      const digest = [...new Uint8Array(bytes)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      await send({
        kind: "start",
        jobId: decodeProviderCloudJobId(crypto.randomUUID()),
        threadId: owner.threadId,
        instanceId: selected.instanceId,
        modelId: selectedModel,
        input: snapshot,
        reviewedInputDigest: decodeProviderCloudInputDigest(digest),
        cloudExecutionConsent: true,
        ...(acknowledged.length === 0 ? {} : { acknowledgedUnknownJobs: acknowledged }),
      });
      if (active.current === owner) resetReview();
    } catch {
      if (active.current === owner)
        setMessage("The reviewed text could not be prepared; no cloud request was sent.");
    } finally {
      if (active.current === owner) setBusy(false);
    }
  };
  return (
    <details className="provider-cloud-sessions">
      <summary>Provider cloud sessions</summary>
      <p>
        Run a separate task in this provider's remote sandbox. Your local Code thread and checkout
        stay local.
      </p>
      {message === "" ? null : <OctantAlert tone="warning">{message}</OctantAlert>}
      {busy && view === undefined ? (
        <p role="status">Reading cloud-session availability…</p>
      ) : profiles.length === 0 ? (
        <p>
          Enable a supported endpoint in Settings → Octant Harness → Model endpoints to review a
          cloud task.
        </p>
      ) : (
        <>
          <label>
            Provider
            <OctantSelectField
              aria-label="Cloud provider"
              disabled={busy}
              value={selected === undefined ? "" : String(selected.instanceId)}
              options={profiles.map((item) => ({ id: String(item.instanceId), label: item.label }))}
              onValueChange={(value) => {
                setProvider(value);
                setModel("");
                resetReview();
              }}
            />
          </label>
          <label>
            Model
            <OctantSelectField
              aria-label="Cloud model"
              disabled={busy}
              value={selectedModel === undefined ? "" : String(selectedModel)}
              options={(selected?.models ?? []).map((id) => ({
                id: String(id),
                label: String(id),
              }))}
              onValueChange={(value) => {
                setModel(value);
                resetReview();
              }}
            />
          </label>
          <label htmlFor={textId}>Task text to send</label>
          <OctantTextarea
            id={textId}
            rows={5}
            maxLength={MAX_PROVIDER_CLOUD_INPUT}
            disabled={busy}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              resetReview();
            }}
          />
          <p>
            Only this text leaves Octant. Files, history, host tools and credentials are not
            attached. Check anything you paste for secrets.
          </p>
          {reviewed ? (
            <>
              <pre aria-label="Reviewed cloud input">{text}</pre>
              <p>
                The provider can execute commands in its sandbox without local approval callbacks.
                Network is disabled for the bundled OpenAI adapter. Model and sandbox charges are
                separate; no hard per-task billing cap is promised.
              </p>
              {(view?.jobs ?? [])
                .filter(
                  (job) =>
                    job.state === "submission-uncertain" &&
                    job.remoteId === undefined &&
                    job.uncertaintyAcknowledgedAt === undefined,
                )
                .map((job) => (
                  <label key={job.id}>
                    <OctantCheckbox
                      checked={acknowledged.some((item) => String(item.jobId) === String(job.id))}
                      disabled={busy}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setAcknowledged((items) =>
                          checked
                            ? [
                                ...items.filter((item) => String(item.jobId) !== String(job.id)),
                                { jobId: job.id, expectedVersion: job.version },
                              ]
                            : items.filter((item) => String(item.jobId) !== String(job.id)),
                        );
                      }}
                    />
                    I understand the earlier task “{job.input.slice(0, 80)}” from {job.createdAt}{" "}
                    may still be running and billing; I approve a new submission, not a retry or
                    cancellation.
                  </label>
                ))}
              <label htmlFor={consentId}>
                <OctantCheckbox
                  id={consentId}
                  checked={consent}
                  disabled={busy}
                  onChange={(event) => setConsent(event.currentTarget.checked)}
                />
                I approve sending this exact text and running this task in {selected?.label}.
              </label>
              <OctantButton
                disabled={busy || !consent || selectedModel === undefined}
                onClick={() => void run()}
                size="sm"
              >
                {busy ? "Starting…" : "Run in provider cloud"}
              </OctantButton>
            </>
          ) : (
            <OctantButton
              disabled={busy || text.trim().length === 0 || selectedModel === undefined}
              onClick={() => setReviewed(true)}
              size="sm"
              variant="outline"
            >
              Review cloud task
            </OctantButton>
          )}
        </>
      )}
      <OctantButton
        disabled={busy}
        onClick={() => void send({ kind: "list", threadId: props.threadId })}
        size="sm"
        variant="ghost"
      >
        Refresh saved sessions
      </OctantButton>
      {(view?.jobs ?? []).map((job) => (
        <article key={job.id}>
          <p>
            {job.state === "submission-uncertain"
              ? "Submission uncertain — do not retry this task automatically."
              : job.state === "cancel-requested"
                ? "Cancellation requested — remote work may still be running."
                : `Last observed: ${job.state}`}
          </p>
          <p>Observed at {job.updatedAt}</p>
          {job.uncertaintyAcknowledgedAt === undefined ? null : (
            <p>
              Unknown work acknowledged locally. This does not stop or delete the provider's task.
            </p>
          )}
          {job.remoteId === undefined ? null : <p>Provider session: {job.remoteId}</p>}
          <p>Usage and total provider charges are not confirmed.</p>
          {job.output === "" ? null : (
            <>
              <p>Untrusted provider output{job.truncated ? " (truncated)" : ""}</p>
              <pre>{job.output}</pre>
            </>
          )}
          {job.remoteId === undefined ? null : (
            <>
              <OctantButton
                disabled={busy}
                onClick={() => void send({ kind: "read", jobId: job.id })}
                size="sm"
                variant="outline"
              >
                Check remote status
              </OctantButton>
              {["completed", "failed", "cancelled", "unavailable"].includes(job.state) ? null : (
                <OctantButton
                  disabled={busy}
                  onClick={() => void send({ kind: "cancel", jobId: job.id })}
                  size="sm"
                  variant="outline"
                >
                  Request cancellation
                </OctantButton>
              )}
            </>
          )}
        </article>
      ))}
    </details>
  );
}
