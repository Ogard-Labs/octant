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
