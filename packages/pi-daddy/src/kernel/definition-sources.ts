/** Opt-in immutable copies of bytes already admitted by selected-resource discovery. Never authority. */
export interface DefinitionSource {
  readonly kind: "selected-skill" | "package" | "binding-manifest" | "delegated-agent";
  readonly path: string;
  /** Raw admitted bytes, including any BOM. Runtime sourceHash separately identifies decoded text. */
  readonly base64: string;
}
export interface DefinitionSourceSnapshot {
  readonly resources: readonly DefinitionSource[];
  /** Exact body dispatched to the child; some generic definitions trim their source body. */
  readonly body: string;
}
