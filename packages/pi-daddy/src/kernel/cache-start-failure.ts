/** Trusted execution-adapter startup receipt. Never reconstruct cleanupVerified from client data. */
export class CacheStartFailure extends Error {
  readonly cleanupVerified: boolean;
  constructor(message: string, cleanupVerified: boolean, options?: ErrorOptions) {
    super(message, options);
    this.cleanupVerified = cleanupVerified;
  }
}
