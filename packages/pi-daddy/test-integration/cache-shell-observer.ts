/** Namespace-local observer exit witness for trusted fixtures only; no process adoption or signaling. */
import { readBoundedFile } from "../src/kernel/bounded-read.ts";
import { cacheProcessTerminated, isCacheOwner } from "../src/kernel/cache-owner.ts";
export async function finishShellObserverWitness(path: string): Promise<{ count: number; terminated: true }> {
  const read = await readBoundedFile(path, { maxBytes: 8192, timeoutMs: 1000 });
  if (!read.ok) throw Error(`fixture observer witness: ${read.why}: ${read.detail}`);
  const owners: unknown = JSON.parse(read.text);
  if (!Array.isArray(owners) || !owners.length || owners.length > 32 || !owners.every(isCacheOwner))
    throw Error("fixture observer witness must name 1..32 actual identities");
  const deadline = performance.now() + 2000;
  while (true) {
    if ((await Promise.all(owners.map((owner) => cacheProcessTerminated(owner)))).every(Boolean))
      return { count: owners.length, terminated: true };
    if (performance.now() >= deadline) throw Error("fixture observer remained alive before namespace teardown");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
