/** Internal coordinator values, NOT request-provided authority or source-consistency certificates. */
import type { CachePayloadLimits, CachePayloadToken } from "./cache-payloads.ts";
export interface CacheWorkspace {
  readonly cacheWorkspace: unique symbol;
}
export interface CacheObservation {
  readonly cacheObservation: unique symbol;
}
export interface CacheDirtyToken {
  readonly cacheDirtyToken: unique symbol;
}
export interface CacheRunTicket {
  readonly cacheRunTicket: unique symbol;
}
export interface CacheResultRef {
  readonly cacheResultRef: unique symbol;
}
export interface CacheGraphLimits {
  workspaces: number;
  observations: number;
  entries: number;
  runs: number;
  edges: number;
  keyBytes: number;
  output: CachePayloadLimits;
}
export interface CacheExecution {
  executionId: string;
  startedAt: string;
  endedAt: string;
}
export interface CacheOutcome extends CacheExecution {
  output: string;
}
export interface WorkspaceState {
  name: string;
  token: CacheWorkspace;
  inputs: Map<string, InputState>;
  entries: Map<string, ResultState>;
}
export interface InputState {
  scope: WorkspaceState;
  key: string;
  fingerprint: string;
  token: CacheObservation;
  pending?: CacheDirtyToken;
  live: boolean;
  users: Set<Consumer>;
}
export interface ConsumerBase {
  scope: WorkspaceState;
  key: string;
  inputs: Set<InputState>;
  parents: Set<ResultState>;
  live: boolean;
}
export interface RunState extends ConsumerBase {
  kind: "run";
  token: CacheRunTicket;
  eligible: boolean;
  order: number;
}
export interface ResultState extends ConsumerBase {
  kind: "result";
  token: CacheResultRef;
  payload: CachePayloadToken;
  execution: Readonly<CacheExecution>;
  users: Set<Consumer>;
}
export type Consumer = RunState | ResultState;
