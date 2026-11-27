import type { WebDashboardHandle } from "./web-dashboard.ts";

/** Owns a single panel start attempt until stop or session shutdown invalidates it. */
export class PanelServerLifecycle {
  current?: WebDashboardHandle;
  private pending?: Promise<WebDashboardHandle | undefined>;
  generation = 0;

  start(open: () => Promise<WebDashboardHandle>, publish: (handle: WebDashboardHandle) => void) {
    if (this.current) return Promise.resolve(this.current);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const start = async () => {
      const handle = await open();
      if (this.generation !== generation) {
        await handle.close();
        return undefined;
      }
      this.current = handle;
      publish(handle);
      return handle;
    };
    this.pending = start().finally(() => {
      if (this.generation === generation) this.pending = undefined;
    });
    return this.pending;
  }

  async stop() {
    this.generation++;
    const { current, pending } = this;
    this.current = undefined;
    this.pending = undefined;
    if (current) await current.close();
    else if (pending) await pending.catch(() => {});
    return Boolean(current || pending);
  }
}
