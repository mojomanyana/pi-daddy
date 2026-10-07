/** Versioned, execution-bound worker facts. These records never grant capabilities. */
export interface CapturedWorkerIdentity {
  revision: 1;
  executionId: string;
  nonce: string;
  root: string;
  rootDevice: string;
  rootInode: string;
  bootId: string;
  pidNamespace: string;
  helperPid: number;
  helperStartTicks: string;
  helperSha256: string;
  workerPid: number;
  ownershipPath: string;
  receiptPath: string;
}
export interface CapturedWorkerReceipt {
  state: "settled";
  identity: CapturedWorkerIdentity;
  workerCode: number | null;
  workerSignal: number;
  reason: "worker-exit" | "owner-loss" | "cancelled" | "helper-signal" | "ownership-write-failed" | "start-failed";
  reapedAll: true;
}
export type CapturedWorkerCleanup =
  | { state: "settled"; identity: CapturedWorkerIdentity; receipt: CapturedWorkerReceipt }
  | { state: "unknown"; identity?: CapturedWorkerIdentity; reason: string }
  | { state: "not-started"; reason: string };
