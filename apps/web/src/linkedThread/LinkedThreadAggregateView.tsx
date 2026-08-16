import type { LinkedThreadAggregate, LinkedThreadAggregateStatus } from "@octant/contracts";

export interface LinkedThreadAggregateViewProps {
  readonly aggregate: LinkedThreadAggregate;
}

const STATUS_LABELS: Record<LinkedThreadAggregateStatus, string> = {
  created: "Created",
  queued: "Queued",
  partial: "Partial",
  rejected: "Rejected",
  failed: "Failed",
};

export function LinkedThreadAggregateView(props: LinkedThreadAggregateViewProps) {
  const aggregate = props.aggregate;
  return (
    <section aria-label="Linked-thread aggregate" className="linked-thread-aggregate">
      <div className="linked-thread-aggregate__header">
        <span
          aria-label="Aggregate status"
          className="linked-thread-aggregate__status"
          role="status"
        >
          {STATUS_LABELS[aggregate.status]}
        </span>
        <span className="linked-thread-aggregate__count">
          {aggregate.results.length} of {aggregate.requestedCount} peer outcomes recorded
        </span>
      </div>

      {aggregate.skillName === undefined ? null : (
        <p className="linked-thread-aggregate__skill">
          Skill <strong>{aggregate.skillName}</strong>
        </p>
      )}

      <ul aria-label="Per-thread results" className="linked-thread-aggregate__results">
        {aggregate.results.map((result) => (
          <li key={result.targetIndex} data-status={result.status}>
            <div className="linked-thread-aggregate__result-header">
              {result.threadId === undefined ? (
                <span>{result.label}</span>
              ) : (
                <a aria-label={result.label} href={`/threads/${String(result.threadId)}`}>
                  {result.label}
                </a>
              )}
              <span>{result.status}</span>
            </div>
            {result.reason === undefined ? null : (
              <p className="linked-thread-aggregate__reason">{result.reason}</p>
            )}
            {result.resultRefId === undefined ? null : (
              <p className="linked-thread-aggregate__ref">Result ref {result.resultRefId}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
