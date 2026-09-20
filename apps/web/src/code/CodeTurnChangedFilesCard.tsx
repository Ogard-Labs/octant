import type { CodeTurnChangedFiles } from "@octant/contracts/code-operations";
import { ChevronDown, FileText } from "lucide-react";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

/** Rows shown before the rest fold behind one line; a long list must not bury the reply. */
const VISIBLE_AT_REST = 5;

/**
 * What changed in the checkout while one turn ran.
 *
 * The host compares two states of a folder, so this is an observation and never
 * an attribution: the copy says "changed while this ran", not "wrote" or
 * "created", because a file the person saved from an editor during the turn is
 * recorded exactly like one the provider wrote.
 */
export function CodeTurnChangedFilesCard(props: { readonly changedFiles: CodeTurnChangedFiles }) {
  const { files, total, truncated } = props.changedFiles;
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (total === 0 && !truncated) return null;
  const shown = open ? files : files.slice(0, VISIBLE_AT_REST);
  const folded = files.length - shown.length;
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
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
            <span className="code-turn-files__insertions">{`+${insertions.toLocaleString()}`}</span>
            <span className="code-turn-files__deletions">{`−${deletions.toLocaleString()}`}</span>
          </span>
        )}
      </header>
      {shown.length === 0 ? null : (
        <ul className="code-turn-files__list" id={listId}>
          {shown.map((file) => {
            const slash = file.path.lastIndexOf("/");
            return (
              <li className="code-turn-files__row" key={file.path} title={file.path}>
                <FileText aria-hidden="true" size={14} strokeWidth={1.7} />
                <span className="code-turn-files__path">
                  {slash === -1 ? null : (
                    <span className="code-turn-files__directory">
                      {file.path.slice(0, slash + 1)}
                    </span>
                  )}
                  <span className="code-turn-files__name">{file.path.slice(slash + 1)}</span>
                </span>
                {file.binary === true ? (
                  <span className="code-turn-files__binary">Binary</span>
                ) : (
                  <span className="code-turn-files__counts">
                    <span className="code-turn-files__insertions">{`+${file.insertions.toLocaleString()}`}</span>
                    <span className="code-turn-files__deletions">{`−${file.deletions.toLocaleString()}`}</span>
                  </span>
                )}
              </li>
            );
          })}
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
      {truncated ? (
        <p className="code-turn-files__note" role="status">
          {files.length === 0
            ? "More changed than could be listed here. Review has the whole change."
            : `Showing ${files.length} of ${total}. Review has the whole change.`}
        </p>
      ) : null}
    </section>
  );
}
