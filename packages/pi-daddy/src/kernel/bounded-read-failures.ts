import { BoundedReadCleanupError } from "./bounded-read.ts";

/** Independent failed readers remain typed, with every original recovery capability intact. */
export class CollectedBoundedReadCleanupError extends BoundedReadCleanupError {
  readonly errors: readonly BoundedReadCleanupError[];
  constructor(errors: readonly BoundedReadCleanupError[]) {
    const members = Object.freeze([...errors]);
    super(members, async () => {
      const outcomes = await Promise.allSettled(members.map((error) => error.cleanup()));
      const failed = members.filter((_error, index) => outcomes[index].status === "rejected");
      if (failed.length) throw collectBoundedReadFailures(failed);
    });
    this.name = "CollectedBoundedReadCleanupError";
    this.message = `${members.length} bounded reader descriptor cleanups unresolved; retain and explicitly retry`;
    this.errors = members;
  }
}

/** Preserve singleton identity; flatten only our typed collection, never arbitrary caller errors. */
export function collectBoundedReadFailures(errors: readonly unknown[]): BoundedReadCleanupError | undefined {
  const members = [
    ...new Set(
      errors.flatMap((error) =>
        error instanceof CollectedBoundedReadCleanupError
          ? error.errors
          : error instanceof BoundedReadCleanupError
            ? [error]
            : [],
      ),
    ),
  ];
  const existing = errors.find(
    (error) =>
      error instanceof CollectedBoundedReadCleanupError &&
      error.errors.length === members.length &&
      error.errors.every((member, index) => member === members[index]),
  );
  return (
    (existing as CollectedBoundedReadCleanupError | undefined) ??
    (members.length > 1 ? new CollectedBoundedReadCleanupError(members) : members[0])
  );
}
