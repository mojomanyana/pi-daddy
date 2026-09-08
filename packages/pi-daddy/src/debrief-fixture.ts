import { readFile } from "node:fs/promises";
import { createDebriefPresenter, type DebriefCheckpoint, type DebriefPersistence } from "./debrief.ts";
import { blindView, blindChoice, dataKey, dataDigest, detached, freeze, type BlindChoice } from "./debrief-contract.ts";
import { parseRetentionJson } from "./retention-json.ts";
const root = new URL("../contracts/debrief/v1/", import.meta.url);
const json = async (path: string) => parseRetentionJson(await readFile(new URL(path, root), "utf8")) as any;
/** Explicit frozen demo only. No case writer or durable blind/attention qualification is fabricated. */
export async function createFixtureDebrief() {
  const cases = await json("work-capture/fixtures/cases.json"), batch = await json("work-capture/fixtures/batch.json");
  if (cases.length !== 7 || batch.candidateIds.length !== 7) throw new Error("fixture inventory changed");
  const items = cases.map((candidate: any, i: number) => ({ candidate, caseManifestId: batch.candidateIds[i], priorDecisionId: null, disposition: "unresolved" })).sort((a: any, b: any) => a.caseManifestId.localeCompare(b.caseManifestId));
  const view = blindView(await json("intervention/fixtures/blind-view.json"));
  let choice: BlindChoice | null = null, revealed = false, state: DebriefCheckpoint | null = null;
  const persistence: DebriefPersistence = { durability: "fixture-memory", load: () => detached(state), compareAndSwap(expected, next) {
    if (expected !== (state ? dataDigest(state) : null)) throw new Error("stale fixture checkpoint"); state = freeze(detached(next));
  } };
  return createDebriefPresenter({ scope: "manual-frozen-fixture-v1", fixture: true, persistence,
    reviewer: { list: (offset, limit) => ({ total: 7, offset, items: items.slice(offset, offset + limit) }), history: () => [] },
    blind: { view: () => view, readArtifact: async (label, digest) => {
      if (!view.cards.some(c => c.label === label && c.artifactDigests.includes(digest))) throw new Error("artifact outside fixture blind view");
      return readFile(new URL(`intervention/fixtures/artifact-${digest}.txt`, root));
    }, choose(input) {
      const next = blindChoice(input, view); if (revealed && dataKey(choice) !== dataKey(next)) throw new Error("fixture choice locked"); choice = next; return next;
    }, async reveal() {
      if (!choice) throw new Error("quality first"); const saved = await json("intervention/fixtures/reveal.json");
      revealed = true; return { ...saved, choice };
    } },
  });
}
