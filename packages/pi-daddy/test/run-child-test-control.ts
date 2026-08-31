import { AsyncLocalStorage } from "node:async_hooks";

interface RunChildTestControl {
  hardDeadlineAtAfterSpawn(): number;
}

const TEST_CONTROL = Symbol.for("pi-daddy.internal.run-child-test-control");
const controls = new AsyncLocalStorage<RunChildTestControl>();
(globalThis as Record<symbol, unknown>)[TEST_CONTROL] = controls;

export function withRunChildTestControl<T>(
  control: RunChildTestControl,
  run: () => Promise<T>,
): Promise<T> {
  return controls.run(control, run);
}
