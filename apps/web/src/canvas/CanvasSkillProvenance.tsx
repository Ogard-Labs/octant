import type { CanvasSkillContribution } from "@octant/contracts/canvas-skill";

export interface CanvasSkillProvenanceProps {
  readonly contribution: CanvasSkillContribution;
}

/**
 * Read-only provenance for a trusted Canvas skill contribution. It shows the
 * skill's pinned identity, version, source kind, digest, supported source
 * kinds, contributed layouts, and presentation rule kinds so a user can audit
 * where a layout came from. It renders no actions and no source references:
 * displaying a contribution never grants authority, and installing, selecting,
 * or mentioning a skill only surfaces this presentation metadata.
 */
export function CanvasSkillProvenance(props: CanvasSkillProvenanceProps) {
  const { contribution } = props;
  const shortDigest = String(contribution.digest)
    .replace(/^sha256:/, "")
    .slice(0, 12);
  return (
    <section
      className="canvas-skill-provenance"
      data-testid="canvas-skill-provenance"
      aria-label="Trusted skill contribution"
    >
      <h3 className="canvas-skill-provenance__title">Contributed by a trusted skill</h3>
      <dl className="canvas-skill-provenance__facts">
        <div>
          <dt>Skill</dt>
          <dd data-testid="canvas-skill-provenance-id">{String(contribution.qualifiedId)}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd data-testid="canvas-skill-provenance-version">
            {contribution.version === undefined ? "unversioned" : String(contribution.version)}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd data-testid="canvas-skill-provenance-source-kind">{contribution.sourceKind}</dd>
        </div>
        <div>
          <dt>Digest</dt>
          <dd data-testid="canvas-skill-provenance-digest">sha256:{shortDigest}…</dd>
        </div>
      </dl>
      <div className="canvas-skill-provenance__supported">
        <span className="canvas-skill-provenance__label">Supported sources</span>
        <ul data-testid="canvas-skill-provenance-supported-sources">
          {contribution.supportedSources.map((kind) => (
            <li key={kind}>{kind}</li>
          ))}
        </ul>
      </div>
      {contribution.layouts.length > 0 ? (
        <div className="canvas-skill-provenance__layouts">
          <span className="canvas-skill-provenance__label">Layouts</span>
          <ul data-testid="canvas-skill-provenance-layouts">
            {contribution.layouts.map((layout) => (
              <li key={String(layout.layoutId)}>{layout.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {contribution.presentationRules.length > 0 ? (
        <div className="canvas-skill-provenance__rules">
          <span className="canvas-skill-provenance__label">Presentation rules</span>
          <ul data-testid="canvas-skill-provenance-rules">
            {contribution.presentationRules.map((rule) => (
              <li key={String(rule.ruleId)}>
                {rule.kind}: {rule.target}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="canvas-skill-provenance__note" data-testid="canvas-skill-provenance-note">
        Presentation only. This skill contributes layouts and rules and grants no authority.
      </p>
    </section>
  );
}
