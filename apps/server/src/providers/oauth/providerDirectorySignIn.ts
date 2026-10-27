import type { ProviderInstanceId } from "@octant/contracts";
import {
  decodeHostOAuthDescriptor,
  type HostOAuthDescriptor,
  type HostOAuthSignInState,
} from "@octant/contracts/host-oauth";
import {
  AZURE_FOUNDRY_DIRECTORY_SIGN_IN,
  GATEWAY_DIRECTORY_SIGN_IN,
  azureFoundryDirectoryDescriptor,
  gatewayDirectoryDescriptor,
} from "@octant/domain";
import type { PrincipalKind } from "@octant/domain/remote-access-policy";
import {
  encodeDirectoryOAuthCredential,
  readDirectoryOAuthCredential,
  sameDirectoryOAuthBinding,
  type DirectoryOAuthBinding,
  type DirectoryOAuthCredential,
} from "@octant/provider-sdk/directory-oauth";
import type {
  ProviderOAuthCommand,
  ProviderOAuthRouteDependencies,
  ProviderOAuthView,
} from "./providerOAuthRoutes";

/** Whether a sign-in command names an organization (directory or issuer) sign-in. */
export function isDirectorySignIn(descriptorId: string): boolean {
  return (
    descriptorId === AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId ||
    descriptorId === GATEWAY_DIRECTORY_SIGN_IN.descriptorId
  );
}

/**
 * An organization sign-in for one Azure AI Foundry instance (its Microsoft
 * Entra ID tenant) or one OpenAI-compatible or Anthropic-compatible gateway
 * (its organization's own issuer). Unlike a catalog offer, its descriptor is
 * built from the instance's own configuration on every command, never from
 * the request: the directory, client, resource, and endpoint the broker
 * binds the grant to are the ones the server holds. Neither directory offers
 * client-side revocation, so signing out deletes this computer's grant and
 * says the organization session was not ended.
 */
export async function dispatchDirectorySignIn(input: {
  readonly dependencies: ProviderOAuthRouteDependencies;
  readonly command: ProviderOAuthCommand;
  readonly principal: PrincipalKind;
  readonly actorId: string;
}): Promise<ProviderOAuthView> {
  const { dependencies, command, principal, actorId } = input;
  const target = signInTarget(dependencies, command.instanceId);
  if (target.kind === "refused") return target;
  const { descriptor, binding, copy } = target;
  // The command names the sign-in its panel showed; one that names another
  // kind's sign-in for this instance is refused, not quietly redirected.
  if (command.descriptorId !== descriptor.descriptorId)
    return { kind: "refused", reason: "invalid" };
  const signedOut = (
    termsRequired = dependencies.service.offer(descriptor).oauth.termsRequired,
  ): ProviderOAuthView => ({
    kind: "signed-out",
    termsRequired,
    termsSummary: copy.termsSummary,
    accountLabel: copy.accountLabel,
  });
  if (command.kind === "acknowledge") {
    const recorded = dependencies.service.acknowledgeTerms({
      principalKind: principal,
      actorId,
      descriptor,
    });
    if (recorded.kind === "refused") return { kind: "refused", reason: recorded.reason };
    return signedOut(false);
  }
  if (command.kind === "begin") {
    // A device code is begun only for an instance the person opted in, and
    // only by the host-local command that asks for one; Settings never does.
    if (command.flow === "device-code" && target.deviceCodeSignIn !== true) {
      return { kind: "refused", reason: "device-code-not-enabled" };
    }
    const started = await dependencies.service.begin({
      principalKind: principal,
      actorId,
      descriptor:
        command.flow === "device-code" ? { ...descriptor, flow: "device-code" } : descriptor,
    });
    return finish(input, target, started);
  }
  if (command.kind === "poll") {
    const state = await dependencies.service.status({
      principalKind: principal,
      attemptId: command.attemptId,
      descriptor,
    });
    return finish(input, target, state);
  }
  const pointer = await readPointer(dependencies, command.instanceId);
  const held =
    pointer !== undefined && sameDirectoryOAuthBinding(pointer, binding) ? pointer : undefined;
  if (command.kind === "status") {
    if (held === undefined) return signedOut();
    const refreshed = await dependencies.service.refresh({
      principalKind: principal,
      descriptor,
      credentialRef: held.credentialRef,
    });
    if (refreshed.kind === "refreshed") {
      return { kind: "signed-in", accountLabel: held.accountLabel };
    }
    if (refreshed.kind === "sign-in-again") {
      // The broker keeps a grant the organization wants repeated in person,
      // so its pointer stays; every other reason already dropped the grant.
      if (refreshed.reason === "interaction-required") {
        return { kind: "expired", accountLabel: held.accountLabel, reason: refreshed.reason };
      }
      await dependencies.credentials?.delete(command.instanceId).catch(() => undefined);
      return { kind: "expired", accountLabel: held.accountLabel };
    }
    if (refreshed.kind === "refused") return { kind: "refused", reason: refreshed.reason };
    return { kind: "refused", reason: "unavailable" };
  }
  // Sign out. The broker forgets the grant; the directory is never told.
  if (pointer === undefined) return signedOut();
  const forgotten = await dependencies.service.signOut({
    principalKind: principal,
    descriptor,
    credentialRef: pointer.credentialRef,
    forgetWhenNotRevoked: true,
  });
  if (forgotten.kind === "refused") return { kind: "refused", reason: forgotten.reason };
  if (forgotten.kind !== "signed-out" && forgotten.kind !== "signed-out-locally") {
    return { kind: "refused", reason: "unavailable" };
  }
  await dependencies.credentials?.delete(command.instanceId);
  return {
    kind: "signed-out-locally",
    termsRequired: false,
    termsSummary: copy.termsSummary,
    accountLabel: copy.accountLabel,
  };
}

type SignInTarget =
  | {
      readonly kind: "target";
      readonly descriptor: HostOAuthDescriptor;
      readonly binding: DirectoryOAuthBinding;
      /** What the panel says before the directory names the account. */
      readonly copy: { readonly termsSummary: string; readonly accountLabel: string };
      /**
       * Whether the instance allows a device-code sign-in from the host-local
       * command. Only an Azure AI Foundry instance can opt in; a gateway signs
       * in on the loopback redirect alone.
       */
      readonly deviceCodeSignIn: boolean;
    }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The sign-in an instance's own configuration names, with the binding the
 * pointer will carry: an Azure AI Foundry tenant and its one audience, or a
 * gateway's own issuer and scope, each at the endpoint's origin.
 */
function signInTarget(
  dependencies: ProviderOAuthRouteDependencies,
  instanceId: ProviderInstanceId,
): SignInTarget {
  const instance = dependencies.readInstance?.(instanceId);
  if (instance === undefined) return { kind: "refused", reason: "unknown-instance" };
  if (
    instance.driverKind === "azure-foundry" &&
    instance.configuration.authentication === "directory-oauth"
  ) {
    const { directory } = instance.configuration;
    return targetFrom(
      azureFoundryDirectoryDescriptor(instance.configuration),
      AZURE_FOUNDRY_DIRECTORY_SIGN_IN,
      (endpointOrigin) => ({
        tenantId: directory.tenantId,
        clientId: directory.clientId,
        audience: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.audience,
        endpointOrigin,
      }),
      instance.configuration.deviceCodeSignIn === true,
    );
  }
  if (
    (instance.driverKind === "openai-compatible" ||
      instance.driverKind === "anthropic-compatible") &&
    instance.configuration.authentication === "directory-oauth"
  ) {
    const { directory } = instance.configuration;
    return targetFrom(
      gatewayDirectoryDescriptor(instance.configuration),
      GATEWAY_DIRECTORY_SIGN_IN,
      (endpointOrigin) => ({
        issuer: directory.issuer,
        clientId: directory.clientId,
        scope: directory.scope,
        endpointOrigin,
      }),
      false,
    );
  }
  return { kind: "refused", reason: "unsupported-driver" };
}

function targetFrom(
  built: HostOAuthDescriptor | undefined,
  copy: { readonly termsSummary: string; readonly accountLabel: string },
  bindingAt: (endpointOrigin: string) => DirectoryOAuthBinding,
  deviceCodeSignIn: boolean,
): SignInTarget {
  if (built === undefined) return { kind: "refused", reason: "endpoint-mismatch" };
  let descriptor: HostOAuthDescriptor;
  try {
    descriptor = decodeHostOAuthDescriptor(built);
  } catch {
    return { kind: "refused", reason: "invalid" };
  }
  if (descriptor.endpointOrigin === undefined) return { kind: "refused", reason: "invalid" };
  return {
    kind: "target",
    descriptor,
    binding: bindingAt(descriptor.endpointOrigin),
    copy: { termsSummary: copy.termsSummary, accountLabel: copy.accountLabel },
    deviceCodeSignIn,
  };
}

async function finish(
  input: {
    readonly dependencies: ProviderOAuthRouteDependencies;
    readonly command: ProviderOAuthCommand;
    readonly principal: PrincipalKind;
  },
  target: Extract<SignInTarget, { readonly kind: "target" }>,
  state: HostOAuthSignInState,
): Promise<ProviderOAuthView> {
  const { dependencies, command } = input;
  if (state.kind === "signed-in") {
    if (state.descriptorId !== target.descriptor.descriptorId) {
      return { kind: "refused", reason: "invalid" };
    }
    // The instance may have changed while the browser was open; a pointer is
    // stored only for the binding it holds now, and the broker refuses the
    // grant at the first request if it was signed in for another.
    const current = signInTarget(dependencies, command.instanceId);
    if (current.kind === "refused") return current;
    const accountLabel = state.accountLabel ?? current.copy.accountLabel;
    await forgetReplacedGrant(input, current.descriptor, state.credentialRef);
    await dependencies.credentials?.set(
      command.instanceId,
      encodeDirectoryOAuthCredential({
        kind: "directory-oauth",
        credentialRef: state.credentialRef,
        ...current.binding,
        accountLabel,
      }),
    );
    return { kind: "signed-in", accountLabel };
  }
  if (state.kind === "sign-in-again") {
    return { kind: "expired", accountLabel: target.copy.accountLabel };
  }
  if (state.kind === "refused") return { kind: "refused", reason: state.reason };
  if (state.kind === "awaiting-consent" && state.flow === "authorization-code-pkce") {
    return {
      kind: "awaiting-consent",
      attemptId: state.attemptId,
      flow: "authorization-code-pkce",
      authorizationUrl: state.authorizationUrl,
      expiresAt: state.expiresAt,
    };
  }
  // A device code is shown only to the host-local command that asked for one.
  if (state.kind === "awaiting-consent" && command.flow === "device-code") {
    return {
      kind: "awaiting-consent",
      attemptId: state.attemptId,
      flow: "device-code",
      verificationUri: state.verificationUri,
      userCode: state.userCode,
      expiresAt: state.expiresAt,
    };
  }
  return { kind: "refused", reason: "unavailable" };
}

/**
 * A new sign-in makes a new grant; the one it replaces, including a grant the
 * broker kept because the organization wanted the person present again, is
 * forgotten so no refresh token is left without a pointer. A grant that
 * cannot be forgotten now is left to the broker, and the new sign-in stands.
 */
async function forgetReplacedGrant(
  input: {
    readonly dependencies: ProviderOAuthRouteDependencies;
    readonly command: ProviderOAuthCommand;
    readonly principal: PrincipalKind;
  },
  descriptor: HostOAuthDescriptor,
  nextCredentialRef: string,
): Promise<void> {
  const prior = await readPointer(input.dependencies, input.command.instanceId);
  if (prior === undefined || prior.credentialRef === nextCredentialRef) return;
  await input.dependencies.service
    .signOut({
      principalKind: input.principal,
      descriptor,
      credentialRef: prior.credentialRef,
      forgetWhenNotRevoked: true,
    })
    .catch(() => undefined);
}

async function readPointer(
  dependencies: ProviderOAuthRouteDependencies,
  instanceId: ProviderInstanceId,
): Promise<DirectoryOAuthCredential | undefined> {
  if (dependencies.credentials === undefined) return undefined;
  try {
    return readDirectoryOAuthCredential(await dependencies.credentials.resolve(instanceId));
  } catch {
    return undefined;
  }
}
