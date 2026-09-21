interface Finalizer {
  label: string;
  run: () => void | Promise<void>;
}

const FINALIZER_ERRORS = Symbol("pi-daddy.finalizer-errors");

type ErrorWithFinalizers = Error & { [FINALIZER_ERRORS]?: unknown[] };

/**
 * Run every finalizer without allowing one of their failures to replace the operation's primary error.
 *
 * Error identity is preserved when possible: refusal codes and `instanceof` checks are part of callers'
 * control flow. Finalizer failures are attached and added to the primary message instead of wrapping it.
 */
export async function runWithFinalizers<T>(operation: () => Promise<T>, finalizers: readonly Finalizer[]): Promise<T> {
  let primaryPresent = false;
  let primary: unknown;
  let result: T | undefined;

  try {
    result = await operation();
  } catch (error) {
    primaryPresent = true;
    primary = error;
  }

  const failures: Array<{ label: string; error: unknown }> = [];
  for (const finalizer of finalizers) {
    try {
      await finalizer.run();
    } catch (error) {
      failures.push({ label: finalizer.label, error });
    }
  }

  if (primaryPresent) {
    if (failures.length > 0) throw appendFinalizerFailures(primary, failures);
    throw primary;
  }
  if (failures.length === 1) throw failures[0].error;
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      failures.map((failure) => `${failure.label}: ${String(failure.error)}`).join("; "),
    );
  }
  return result as T;
}

/** True when a primary error retained a finalizer failure of the requested kind. */
export function hasFinalizerError(error: unknown, predicate: (value: unknown) => boolean): boolean {
  return error instanceof Error && (error as ErrorWithFinalizers)[FINALIZER_ERRORS]?.some(predicate) === true;
}

function appendFinalizerFailures(primary: unknown, failures: ReadonlyArray<{ label: string; error: unknown }>): unknown {
  if (primary instanceof Error) {
    const target = primary as ErrorWithFinalizers;
    try {
      const prior = target[FINALIZER_ERRORS] ?? [];
      Object.defineProperty(target, FINALIZER_ERRORS, {
        configurable: true,
        value: [...prior, ...failures.map((failure) => failure.error)],
      });
      target.message = [
        target.message,
        ...failures.map((failure) => `${failure.label}: ${String(failure.error)}`),
      ].join("; ");
      return target;
    } catch {
      // A frozen foreign error cannot be annotated. Keep it as the first AggregateError member and cause.
    }
  }
  return new AggregateError(
    [primary, ...failures.map((failure) => failure.error)],
    [String(primary), ...failures.map((failure) => `${failure.label}: ${String(failure.error)}`)].join("; "),
    { cause: primary },
  );
}
