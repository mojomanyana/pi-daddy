import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const candidates = {
  scout: { env: "PI_SCOUT_CHECKOUT", names: ["pi-scout-research", "pi-harvest-scout"], pkg: "pi-scout-research", subdir: "" },
  bookie: { env: "PI_BOOKIE_CHECKOUT", names: ["bookie-pi-skills", "pi-harvest-bookie"], pkg: "pi-bookie", subdir: "packages/pi-extension" },
};

export function pilotCheckout(component) {
  const { env, names, pkg, subdir } = candidates[component];
  const override = process.env[env];
  const roots = override ? [resolve(repo, override)] : names.map(name => resolve(repo, "..", name));
  for (const root of roots) {
    const manifest = join(root, subdir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === pkg) return root;
  }
  if (override) throw Error(`${env} must point to a checkout containing ${pkg}: ${roots[0]}`);
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(pilotCheckout(process.argv[2]) ?? "");
}
