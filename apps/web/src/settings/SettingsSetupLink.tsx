import { OctantButton } from "../ui/base/OctantButton";
import { openExternalUrl, type ExternalUrlHost } from "../shell/openExternalUrl";

/** Setup links are fixed product URLs opened in the person's browser. */
export function SettingsSetupLink(props: {
  readonly host: ExternalUrlHost | undefined;
  readonly href: string;
  readonly children: string;
}) {
  return (
    <a
      href={props.href}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        event.preventDefault();
        openExternalUrl(props.host, props.href);
      }}
    >
      {props.children}
    </a>
  );
}

/**
 * A setup step's own action, such as getting a network provider's app. It
 * stands after the step's sentences rather than inside one, so the design
 * system makes it a button, not bare link text.
 */
export function SettingsSetupAction(props: {
  readonly host: ExternalUrlHost | undefined;
  readonly href: string;
  readonly children: string;
}) {
  return (
    <OctantButton
      className="settings-setup-action"
      onClick={() => openExternalUrl(props.host, props.href)}
      size="sm"
      type="button"
      variant="secondary"
    >
      {props.children}
    </OctantButton>
  );
}
