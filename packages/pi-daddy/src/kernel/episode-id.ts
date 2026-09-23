import { randomUUID } from "node:crypto";

/** Stable identity for one root session and every governed descendant it starts. */
export type EpisodeId = `episode:${string}`;

const EPISODE_ID_RE = /^episode:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isEpisodeId(value: unknown): value is EpisodeId {
  return typeof value === "string" && EPISODE_ID_RE.test(value);
}

export function newEpisodeId(): EpisodeId {
  return `episode:${randomUUID()}`;
}

export function assertEpisodeId(value: unknown, field = "episodeId"): asserts value is EpisodeId {
  if (!isEpisodeId(value)) throw new TypeError(`${field} must be a pi-daddy episode id`);
}
