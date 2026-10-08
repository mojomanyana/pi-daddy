/** Measured transport matrix. Reachability alone never qualifies a backend or changes execution location. */
import { defaultExec, type HerdrExec, type HerdrProbe } from "./herdr-cli.ts";
export const QUALIFIED_HERDR_VERSION = "0.8.2";
export const QUALIFIED_HERDR_PROTOCOL = 20;
export async function qualifyHerdr(probe: HerdrProbe, exec: HerdrExec = defaultExec): Promise<HerdrProbe> {
  if (!probe.ok) return probe;
  try {
    if (process.platform !== "linux" || process.arch !== "x64") throw Error("Herdr owned execution requires Linux x64");
    const [client, server] = await Promise.all([exec(["--version"]), exec(["status", "server"])]);
    if (client.code !== 0 || client.stdout.trim() !== "herdr " + QUALIFIED_HERDR_VERSION)
      throw Error("Herdr client version is not qualified");
    const fields = Object.fromEntries(
      server.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
    if (
      server.code !== 0 ||
      fields.status !== "running" ||
      fields.version !== QUALIFIED_HERDR_VERSION ||
      fields.protocol !== String(QUALIFIED_HERDR_PROTOCOL) ||
      fields.compatible !== "yes"
    )
      throw Error("Herdr server version/protocol is not qualified");
    return { ...probe, qualified: true };
  } catch (error) {
    return { ...probe, qualified: false, qualificationReason: String(error) };
  }
}
