/**
 * The author-facing subset of the harness endpoint wire protocol: what an
 * outside provider driver reads from the host and what it may write back.
 *
 * The schemas live in `@octant/contracts`, where the host's proxy reads them;
 * this module re-exports them so a driver author depends on the provider SDK
 * alone. The host decodes every line a driver writes against these schemas
 * and stops the driver at the first one that does not decode, so an author
 * checks a driver against them (with `runOutsideDriverConformance`) before
 * anyone installs it.
 */
export {
  decodeOutsideDriverFailureData,
  decodeOutsideDriverInitializeResult,
  decodeOutsideDriverProbeResult,
  decodeOutsideDriverSessionOpenResult,
  decodeOutsideDriverSessionSendResult,
  decodeOutsideDriverToHostMessage,
  HOST_HARNESS_ENDPOINT_PROTOCOL_VERSIONS,
  OUTSIDE_DRIVER_METHODS,
  OutsideDriverCapabilityClaims,
  OutsideDriverFailureData,
  OutsideDriverHttpChunkParams,
  OutsideDriverHttpEndParams,
  OutsideDriverHttpRequestParams,
  OutsideDriverHttpResponse,
  OutsideDriverInitializeParams,
  OutsideDriverInitializeResult,
  OutsideDriverMessage,
  OutsideDriverMessageId,
  OutsideDriverProbeResult,
  OutsideDriverRequest,
  OutsideDriverSessionCancelParams,
  OutsideDriverSessionEventParams,
  OutsideDriverSessionOpenParams,
  OutsideDriverSessionOpenResult,
  OutsideDriverSessionRef,
  OutsideDriverSessionReleaseParams,
  OutsideDriverSessionSendParams,
  OutsideDriverSessionSendResult,
  OutsideDriverStreamEvent,
  OutsideDriverToHostMessage,
  OutsideDriverUsage,
  OutsideProviderDriverProtocolVersion,
} from "@octant/contracts/outside-driver-protocol";
