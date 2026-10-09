/** Check the live CLI contract; product release numbers are not compatibility boundaries. */
import { defaultExec, type HerdrExec, type HerdrProbe } from "./herdr-cli.ts";

export async function qualifyHerdr(probe: HerdrProbe, exec: HerdrExec = defaultExec): Promise<HerdrProbe> {
  if (!probe.ok) return probe;
  try {
    if (process.platform !== "linux" || process.arch !== "x64") throw Error("Herdr owned execution requires Linux x64");
    const reply = await exec(["status", "server", "--json"]);
    if (reply.code !== 0)
      throw Error("Herdr live server status failed: " + (reply.stderr.trim() || reply.stdout.trim()));
    const status = JSON.parse(reply.stdout);
    if (!status || status.status !== "running" || status.running !== true) throw Error("Herdr server is not running");
    // Our tab/pane CLI commands use the private protocol. Endpoint compatibility alone is insufficient.
    if (!Number.isSafeInteger(status.protocol) || status.protocol < 1 || status.compatible !== true)
      throw Error("Herdr client/server CLI protocol is incompatible or unavailable");
    // Legacy servers do not advertise an endpoint generation. Respect an explicit modern incompatibility.
    if (
      (status.endpoint_compatible !== undefined || status.capabilities?.endpoint_protocol_generation !== undefined) &&
      status.endpoint_compatible !== true
    )
      throw Error("Herdr client/server endpoint is incompatible or unavailable");
    return { ...probe, qualified: true };
  } catch (error) {
    return { ...probe, qualified: false, qualificationReason: String(error) };
  }
}
