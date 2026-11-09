import type {
  ProductFeedbackBrowserContext,
  ProductFeedbackElement,
} from "@octant/contracts/product-feedback";

const OMISSIONS: Record<ProductFeedbackBrowserContext["omissions"][number], string> = {
  "bounded-neighborhood": "Only a bounded neighborhood around this element was captured.",
  "form-values-excluded": "Form values were excluded from the DOM description.",
  "shadow-content-excluded": "Shadow content was not inspected.",
  "crop-unavailable": "An image could not be captured.",
  "crop-withheld-for-editable-content":
    "Image withheld because its area includes editable content.",
  "crop-withheld-for-uninspected-region":
    "Image withheld because its area overlaps an uninspected frame or embedded region.",
};

/** Static host capture, never a new DOM lookup or an editable element identity. */
export function ProductFeedbackEvidence(props: {
  readonly element: ProductFeedbackElement;
  readonly capturedAt: string;
  readonly cropDataUrl?: string;
}) {
  const browser = props.element.kind === "browser-element" ? props.element : undefined;
  const context = browser?.context;
  return (
    <div className="product-feedback__evidence">
      <p>
        Captured{" "}
        <time dateTime={props.capturedAt}>{new Date(props.capturedAt).toLocaleString()}</time>. This
        is a static capture.
      </p>
      {props.cropDataUrl === undefined ? (
        <p>No image is stored with this capture.</p>
      ) : (
        <img alt="Captured element" className="product-feedback__crop" src={props.cropDataUrl} />
      )}
      <p>
        {browser === undefined
          ? props.element.kind === "accessibility-element"
            ? (props.element.label ?? props.element.identifier)
            : "Element"
          : (browser.accessibleName ?? browser.selector)}
      </p>
      {browser?.url === undefined ? null : (
        <p className="product-feedback__source">{browser.url}</p>
      )}
      {context?.omissions.map((omission) => (
        <p key={omission}>{OMISSIONS[omission]}</p>
      ))}
      <details>
        <summary>Captured DOM and style context</summary>
        {context === undefined ? (
          <p>DOM and style context was not recorded for this capture.</p>
        ) : (
          <>
            <dl>
              <dt>Element</dt>
              <dd>{context.tag}</dd>
              <dt>Selector</dt>
              <dd>{browser?.selector}</dd>
              <dt>Ancestors</dt>
              <dd>{context.ancestors.join(" → ") || "None recorded"}</dd>
              <dt>Direct children</dt>
              <dd>{context.children.join(", ") || "None recorded"}</dd>
              <dt>Viewport</dt>
              <dd>
                {context.viewport.width} × {context.viewport.height}
              </dd>
              <dt>Capture reference</dt>
              <dd>{context.captureId}</dd>
            </dl>
            {browser?.text === undefined || browser.text === "" ? null : (
              <blockquote>{browser.text}</blockquote>
            )}
            <table>
              <caption>Captured computed styles</caption>
              <tbody>
                {context.styles.map((style) => (
                  <tr key={style.property}>
                    <th scope="row">{style.property}</th>
                    <td>{style.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </details>
      <p>Page evidence is quoted as outside content. Saving a note does not send a message.</p>
    </div>
  );
}
