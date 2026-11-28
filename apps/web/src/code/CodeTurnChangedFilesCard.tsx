import "../styles/code-thread.css";
import type { CodeCheckoutId } from "@octant/contracts/code";
import type { CodeTurnChangedFile, CodeTurnChangedFiles } from "@octant/contracts/code-operations";
import { ChevronDown, FileText } from "../ui/icons";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

/** Rows shown before the rest fold behind one line; a long list must not bury the reply. */
const VISIBLE_AT_REST = 5;

interface ChangedFileGroup {
  readonly repository: string;
  readonly files: ReadonlyArray<CodeTurnChangedFile>;
}

function groupByRepository(
  files: ReadonlyArray<CodeTurnChangedFile>,
): ReadonlyArray<ChangedFileGroup> {
  const groups: Array<{ readonly repository: string; readonly files: CodeTurnChangedFile[] }> = [];
  const byRepo = new Map<string, CodeTurnChangedFile[]>();
  for (const file of files) {
    const repo = file.repository ?? "Repository";
    let bucket = byRepo.get(repo);
    if (bucket === undefined) {
      bucket = [];
      byRepo.set(repo, bucket);
      groups.push({ repository: repo, files: bucket });
    }
    bucket.push(file);
  }
  return groups;
}

/**
 * What changed in the checkout while one turn ran.
 *
 * The host compares two states of a folder, so this is an observation and never
 * an attribution: the copy says "changed while this ran", not "wrote" or
 * "created", because a file the person saved from an editor during the turn is
 * recorded exactly like one the provider wrote.
 *
 * When files carry a `repository` label (multi-repository threads), rows are
 * grouped under each repository's heading. Single-repository turns omit
 * `repository` and keep the flat list unchanged.
 */
export function CodeTurnChangedFilesCard(props: {
  readonly changedFiles: CodeTurnChangedFiles;
  readonly onReviewFile?: (path: string, checkoutId?: CodeCheckoutId) => void;
  readonly reviewUnavailable?: string;
  readonly comparison?: "current-checkout" | "captured-turn";
}) {
  const { files, total, truncated } = props.changedFiles;
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (total === 0 && !truncated) return null;
  const shown = open ? files : files.slice(0, VISIBLE_AT_REST);
  const folded = files.length - shown.length;
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const grouped = files.some((file) => file.repository !== undefined);
  const renderRow = (file: CodeTurnChangedFile) => {
    const slash = file.path.lastIndexOf("/");
    const rowKey = file.repository === undefined ? file.path : `${file.repository}:${file.path}`;
    return (
      <li className="code-turn-files__row" key={rowKey} title={file.path}>
        <FileText aria-hidden="true" size={14} />
        {props.onReviewFile === undefined ? (
          <span className="code-turn-files__path">
            {slash === -1 ? null : (
              <span className="code-turn-files__directory">{file.path.slice(0, slash + 1)}</span>
            )}
            <span className="code-turn-files__name">{file.path.slice(slash + 1)}</span>
          </span>
        ) : (
          <OctantButton
            type="button"
            variant="link"
            className="code-turn-files__path"
            aria-label={
              file.repository === undefined
                ? `Review ${file.path}`
                : `Review ${file.path} in ${file.repository}`
            }
            onClick={() => props.onReviewFile?.(file.path, file.checkoutId)}
          >
            {file.path}
          </OctantButton>
        )}
        {file.binary === true ? (
          <span className="code-turn-files__binary">Binary</span>
        ) : (
          <span className="code-turn-files__counts">
            <span className="code-turn-files__insertions">{`+${file.insertions.toLocaleString("en")}`}</span>
            <span className="code-turn-files__deletions">{`−${file.deletions.toLocaleString("en")}`}</span>
          </span>
        )}
      </li>
    );
  };
  return (
    <section aria-label="Files changed while this ran" className="code-turn-files">
      <header className="code-turn-files__head">
        <h3 className="code-turn-files__title">
          {total === 1 ? "1 file changed while this ran" : `${total} files changed while this ran`}
        </h3>
        {/* Totals cover the rows listed, so a truncated record does not claim
            a sum it never saw. */}
        {truncated ? null : (
          <span className="code-turn-files__counts">
            <span className="code-turn-files__insertions">{`+${insertions.toLocaleString("en")}`}</span>
            <span className="code-turn-files__deletions">{`−${deletions.toLocaleString("en")}`}</span>
          </span>
        )}
      </header>
      {shown.length === 0 ? null : grouped ? (
        <div className="code-turn-files__groups" id={listId}>
          {groupByRepository(shown).map((group) => (
            <div className="code-turn-files__group" key={group.repository}>
              <h4 className="code-turn-files__repo">{group.repository}</h4>
              <ul
                aria-label={`Files changed in ${group.repository}`}
                className="code-turn-files__list"
              >
                {group.files.map(renderRow)}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className="code-turn-files__list" id={listId}>
          {shown.map(renderRow)}
        </ul>
      )}
      {files.length <= VISIBLE_AT_REST ? null : (
        <OctantButton
          aria-controls={listId}
          aria-expanded={open}
          className="code-turn-files__fold"
          onClick={() => setOpen((current) => !current)}
          type="button"
          variant="link"
        >
          {open ? "Show fewer" : `Show ${folded} more`}
          <ChevronDown aria-hidden="true" data-open={open} size={12} />
        </OctantButton>
      )}
      <p className="code-turn-files__note">
        {grouped
          ? "Observed across this thread's repositories."
          : "Checkout-only observation; extra Project folders are not included."}
      </p>
      {props.reviewUnavailable === undefined ? null : (
        <p className="code-turn-files__note" role="status">
          {props.reviewUnavailable}
        </p>
      )}
      {truncated ? (
        <p className="code-turn-files__note" role="status">
          {files.length === 0
            ? "More changed than could be listed here. Review shows the current checkout comparison."
            : props.comparison === "captured-turn"
              ? `Showing ${files.length} of ${total}. Some captured paths are omitted.`
              : `Showing ${files.length} of ${total}. Review shows the current checkout comparison.`}
        </p>
      ) : null}
    </section>
  );
}
