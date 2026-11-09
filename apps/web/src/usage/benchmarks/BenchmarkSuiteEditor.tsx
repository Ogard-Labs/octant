import { OctantCheckbox } from "../../ui/base/OctantCheckbox";
import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { BenchmarkRegexFlags } from "@octant/contracts";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantTextarea } from "../../ui/base/OctantTextarea";
import { SurfaceSection } from "../../surface/SurfaceHeader";
import type { ModelChoice } from "./benchmarkModels";
import {
  blankCase,
  blankCheck,
  CHECK_KIND_WORDS,
  CODE_CHECK_KINDS,
  contenderKey,
  draftToSaveRequest,
  REGEX_FLAGS,
  type CaseDraft,
  type CheckDraft,
  type CheckKind,
  type SuiteDraft,
} from "./benchmarkPresentation";
import type { BenchmarkSuiteSaveRequest } from "@octant/contracts";

export interface CodeProjectChoice {
  readonly id: string;
  readonly name: string;
}

export interface BenchmarkSuiteEditorProps {
  readonly initial: SuiteDraft;
  readonly codeProjects: ReadonlyArray<CodeProjectChoice>;
  readonly models: ReadonlyArray<ModelChoice>;
  /** Saves the request; resolves to the sentence to show when it was refused. */
  readonly onSave: (request: BenchmarkSuiteSaveRequest) => Promise<string | undefined>;
  readonly onCancel: () => void;
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="usage-workspace__field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

/**
 * Where a suite is written: its cases, each case's checks, and an optional
 * judge. Nothing leaves the form until Save, and the contract has the last word
 * on what a valid suite is, so a refusal always comes back as a sentence.
 */
export function BenchmarkSuiteEditor(props: BenchmarkSuiteEditorProps) {
  const [draft, setDraft] = useState(props.initial);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);

  const updateCase = (key: string, patch: Partial<CaseDraft>) =>
    setDraft((current) => ({
      ...current,
      cases: current.cases.map((candidate) =>
        candidate.key === key ? { ...candidate, ...patch } : candidate,
      ),
    }));

  const save = async () => {
    const result = draftToSaveRequest(draft);
    if (result.status === "invalid") {
      setMessage(result.message);
      return;
    }
    setPending(true);
    setMessage(undefined);
    const refusal = await props.onSave(result.request);
    setPending(false);
    if (refusal !== undefined) setMessage(refusal);
  };

  const judgeKey = contenderKey(draft.judge.providerInstanceId, draft.judge.modelId);
  const judgeOptions = props.models.map((model) => ({ id: model.key, label: model.label }));
  // A stored judge whose account is gone is still shown, so the select never
  // claims a model the host does not offer.
  if (
    draft.judge.enabled &&
    draft.judge.modelId !== "" &&
    !judgeOptions.some((option) => option.id === judgeKey)
  ) {
    judgeOptions.push({ id: judgeKey, label: draft.judge.modelId });
  }

  return (
    <form
      aria-label="Suite editor"
      className="benchmark-editor"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SurfaceSection label={draft.expectedRevision === undefined ? "New suite" : "Edit suite"}>
        <Field label="Name">
          <OctantInput
            aria-label="Suite name"
            maxLength={80}
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
            value={draft.name}
          />
        </Field>
        <Field label="Description">
          <OctantTextarea
            aria-label="Suite description"
            maxLength={500}
            onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
            rows={2}
            value={draft.description}
          />
        </Field>
      </SurfaceSection>

      <SurfaceSection
        actions={
          <>
            <OctantButton
              onClick={() => setDraft({ ...draft, cases: [...draft.cases, blankCase("prompt")] })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Plus aria-hidden="true" size={14} />
              Add prompt case
            </OctantButton>
            <OctantButton
              onClick={() => setDraft({ ...draft, cases: [...draft.cases, blankCase("code")] })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Plus aria-hidden="true" size={14} />
              Add Code case
            </OctantButton>
          </>
        }
        label="Cases"
      >
        {draft.cases.map((candidate, index) => (
          <fieldset className="benchmark-case" key={candidate.key}>
            <legend>
              Case {index + 1}
              {candidate.kind === "code" ? ", Code" : ""}
            </legend>
            <div className="benchmark-case__row">
              <Field label="Kind">
                <OctantSelectField
                  aria-label={`Kind of case ${index + 1}`}
                  onValueChange={(value) =>
                    updateCase(candidate.key, { kind: value === "code" ? "code" : "prompt" })
                  }
                  options={[
                    { id: "prompt", label: "Prompt" },
                    { id: "code", label: "Code" },
                  ]}
                  value={candidate.kind}
                />
              </Field>
              <Field label="Title">
                <OctantInput
                  aria-label={`Title of case ${index + 1}`}
                  maxLength={120}
                  onChange={(event) =>
                    updateCase(candidate.key, { title: event.currentTarget.value })
                  }
                  value={candidate.title}
                />
              </Field>
              <OctantButton
                aria-label={`Remove case ${index + 1}`}
                disabled={draft.cases.length === 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    cases: draft.cases.filter((other) => other.key !== candidate.key),
                  })
                }
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" size={14} />
              </OctantButton>
            </div>
            {candidate.kind === "code" ? (
              <div className="benchmark-case__row">
                <Field label="Code Project">
                  <OctantSelectField
                    aria-label={`Code Project of case ${index + 1}`}
                    onValueChange={(value) => updateCase(candidate.key, { codeProjectId: value })}
                    options={[
                      { id: "", label: "Choose a Code Project" },
                      ...props.codeProjects.map((project) => ({
                        id: project.id,
                        label: project.name,
                      })),
                      ...(candidate.codeProjectId !== "" &&
                      !props.codeProjects.some((project) => project.id === candidate.codeProjectId)
                        ? [
                            {
                              id: candidate.codeProjectId,
                              label: "A Project this Mac does not list",
                            },
                          ]
                        : []),
                    ]}
                    value={candidate.codeProjectId}
                  />
                </Field>
                <Field label="Branch or tag">
                  <OctantInput
                    aria-label={`Branch or tag of case ${index + 1}`}
                    maxLength={200}
                    onChange={(event) =>
                      updateCase(candidate.key, { ref: event.currentTarget.value })
                    }
                    value={candidate.ref}
                  />
                </Field>
              </div>
            ) : null}
            <Field label="Prompt">
              <OctantTextarea
                aria-label={`Prompt of case ${index + 1}`}
                onChange={(event) =>
                  updateCase(candidate.key, { prompt: event.currentTarget.value })
                }
                rows={4}
                value={candidate.prompt}
              />
            </Field>
            <Field label="Reference answer">
              <OctantTextarea
                aria-label={`Reference answer of case ${index + 1}`}
                onChange={(event) =>
                  updateCase(candidate.key, { referenceAnswer: event.currentTarget.value })
                }
                rows={2}
                value={candidate.referenceAnswer}
              />
            </Field>
            <Field label="Rubric line">
              <OctantInput
                aria-label={`Rubric line of case ${index + 1}`}
                maxLength={1_000}
                onChange={(event) =>
                  updateCase(candidate.key, { rubric: event.currentTarget.value })
                }
                value={candidate.rubric}
              />
            </Field>
            <ChecksEditor
              caseNumber={index + 1}
              checks={candidate.checks}
              onChange={(checks) => updateCase(candidate.key, { checks })}
            />
          </fieldset>
        ))}
      </SurfaceSection>

      <SurfaceSection label="Judge">
        <label className="benchmark-editor__toggle">
          <OctantCheckbox
            checked={draft.judge.enabled}
            onChange={(event) =>
              setDraft({
                ...draft,
                judge: { ...draft.judge, enabled: event.currentTarget.checked },
              })
            }
          />
          <span>Score each answer with a judge model</span>
        </label>
        {draft.judge.enabled ? (
          <>
            <Field label="Judge model">
              <OctantSelectField
                aria-label="Judge model"
                onValueChange={(value) => {
                  const model = props.models.find((candidate) => candidate.key === value);
                  if (model === undefined) return;
                  setDraft({
                    ...draft,
                    judge: {
                      ...draft.judge,
                      providerInstanceId: model.providerInstanceId,
                      modelId: model.modelId,
                    },
                  });
                }}
                options={[{ id: "", label: "Choose a model" }, ...judgeOptions]}
                value={draft.judge.modelId === "" ? "" : judgeKey}
              />
            </Field>
            <Field label="Judge rubric">
              <OctantTextarea
                aria-label="Judge rubric"
                maxLength={2_000}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    judge: { ...draft.judge, rubric: event.currentTarget.value },
                  })
                }
                rows={3}
                value={draft.judge.rubric}
              />
            </Field>
          </>
        ) : null}
      </SurfaceSection>

      {message === undefined ? null : (
        <OctantAlert tone="warning">
          <p>{message}</p>
        </OctantAlert>
      )}
      <div className="benchmark-editor__actions">
        <OctantButton disabled={pending} type="submit">
          Save suite
        </OctantButton>
        <OctantButton disabled={pending} onClick={props.onCancel} type="button" variant="outline">
          Cancel
        </OctantButton>
      </div>
    </form>
  );
}

function ChecksEditor(props: {
  readonly caseNumber: number;
  readonly checks: ReadonlyArray<CheckDraft>;
  readonly onChange: (checks: ReadonlyArray<CheckDraft>) => void;
}) {
  const update = (key: string, patch: Partial<CheckDraft>) =>
    props.onChange(
      props.checks.map((check) => (check.key === key ? { ...check, ...patch } : check)),
    );
  return (
    <div className="benchmark-checks">
      <div className="benchmark-checks__head">
        <span className="usage-workspace__note">Checks on the answer</span>
        <OctantButton
          onClick={() => props.onChange([...props.checks, blankCheck()])}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus aria-hidden="true" size={14} />
          Add check
        </OctantButton>
      </div>
      {props.checks.map((check, index) => {
        const name = `check ${index + 1} of case ${props.caseNumber}`;
        return (
          <div className="benchmark-check" key={check.key}>
            <OctantSelectField
              aria-label={`Kind of ${name}`}
              onValueChange={(value) => update(check.key, { kind: value as CheckKind })}
              options={CODE_CHECK_KINDS.map((kind) => ({
                id: kind,
                label: CHECK_KIND_WORDS[kind],
              }))}
              value={check.kind}
            />
            <CheckFields check={check} name={name} update={(patch) => update(check.key, patch)} />
            <OctantButton
              aria-label={`Remove ${name}`}
              onClick={() =>
                props.onChange(props.checks.filter((other) => other.key !== check.key))
              }
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" size={14} />
            </OctantButton>
          </div>
        );
      })}
    </div>
  );
}

function CheckFields(props: {
  readonly check: CheckDraft;
  readonly name: string;
  readonly update: (patch: Partial<CheckDraft>) => void;
}) {
  const { check } = props;
  switch (check.kind) {
    case "contains":
    case "not-contains":
      return (
        <>
          <OctantInput
            aria-label={`Text of ${props.name}`}
            onChange={(event) => props.update({ text: event.currentTarget.value })}
            value={check.text}
          />
          <label className="benchmark-editor__toggle">
            <OctantCheckbox
              checked={check.caseSensitive}
              onChange={(event) => props.update({ caseSensitive: event.currentTarget.checked })}
            />
            <span>Match case</span>
          </label>
        </>
      );
    case "equals":
      return (
        <>
          <OctantInput
            aria-label={`Text of ${props.name}`}
            onChange={(event) => props.update({ text: event.currentTarget.value })}
            value={check.text}
          />
          <label className="benchmark-editor__toggle">
            <OctantCheckbox
              checked={check.trim}
              onChange={(event) => props.update({ trim: event.currentTarget.checked })}
            />
            <span>Ignore surrounding space</span>
          </label>
        </>
      );
    case "matches":
      return (
        <>
          <OctantInput
            aria-label={`Pattern of ${props.name}`}
            onChange={(event) => props.update({ pattern: event.currentTarget.value })}
            value={check.pattern}
          />
          <OctantSelectField
            aria-label={`Flags of ${props.name}`}
            onValueChange={(value) => props.update({ flags: value as BenchmarkRegexFlags })}
            options={REGEX_FLAGS.map((flags) => ({
              id: flags,
              label: flags === "" ? "No flags" : `Flags ${flags}`,
            }))}
            value={check.flags}
          />
        </>
      );
    case "valid-json":
      return <span className="usage-workspace__note">The whole answer must parse as JSON.</span>;
    case "command-exits-zero":
      return (
        <>
          <OctantInput
            aria-label={`Command of ${props.name}`}
            onChange={(event) => props.update({ command: event.currentTarget.value })}
            value={check.command}
          />
          <OctantInput
            aria-label={`Time limit in seconds of ${props.name}`}
            inputMode="numeric"
            onChange={(event) => props.update({ timeoutSeconds: event.currentTarget.value })}
            value={check.timeoutSeconds}
          />
        </>
      );
    case "max-files-changed":
      return (
        <OctantInput
          aria-label={`File count of ${props.name}`}
          inputMode="numeric"
          onChange={(event) => props.update({ count: event.currentTarget.value })}
          value={check.count}
        />
      );
  }
}
