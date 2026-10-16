// packages/service-kit/src/index.ts
// What every service behind the template runtime shares: the HTTP surface the runtime calls (createJobServer) with its job slot, wire message and health
// check; the stop and the signals; the settings helpers that never print a secret; the https loader of a source; the type of a file read from its first
// bytes; the tools run with an argument list in a private directory; and the text and time helpers. Moved here from agents/document-pipeline, which imports
// them, so that agents/audio-snippets runs on the same code.
export { clip, errorText, flatText } from './text.ts';
export { OutOfTime, within } from './time.ts';
export {
  STATUS_CHIPS, TOKEN_SEARCH_MIN, assertHeaderValue, assertNoTokenIn, childEnv, envInt, given, hexOf, refuseSecretIn, refuseTokenIn, requiredEnv, shown, statusChip, statusSince,
  tokenForms,
} from './env.ts';
export type { StatusChip } from './env.ts';
export { MAX_BODY, WireError, parseWire, readBody } from './wire.ts';
export { JobSlot } from './slot.ts';
export { HealthMonitor } from './health.ts';
export type { HealthOptions } from './health.ts';
export { HEARTBEAT_MS, STOPPING_TEXT, createJobServer, operatorsText } from './server.ts';
export type { JobServerOptions, Refusal } from './server.ts';
export { SHUTDOWN_WAIT_MS, lifecycle, listen, stopOnSignals } from './lifecycle.ts';
export type { Lifecycle, LifecycleOptions, ShutdownOutcome } from './lifecycle.ts';
export { fetchUrlBytes, sha256Hex } from './source.ts';
export type { SourceRefusal, UrlBytes, UrlFetchOptions } from './source.ts';
export { ascii, sniffBy } from './sniff.ts';
export type { Signature } from './sniff.ts';
export { runTool, toolFailure, withPrivateDir } from './tools.ts';
export type { RunTool, ToolFailure } from './tools.ts';
