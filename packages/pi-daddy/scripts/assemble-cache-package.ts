/** UNTESTED (per request). Preserve the existing dist entry/bin paths while shipping compiled composition. */
import { readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
async function files(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await files(path)));
    else paths.push(path);
  }
  return paths;
}
const moved = await files(join(dist, "src"));
for (const entry of await readdir(join(dist, "src"))) await rename(join(dist, "src", entry), join(dist, entry));
await rmdir(join(dist, "src"));
for (const oldPath of moved) {
  const path = join(dist, relative(join(dist, "src"), oldPath));
  if (path.endsWith(".map")) {
    const value = JSON.parse(await readFile(path, "utf8"));
    value.sources = value.sources.map((source: string) => relative(dirname(path), resolve(dirname(oldPath), source)));
    await writeFile(path, JSON.stringify(value));
  } else if (/index\.(?:js|d\.ts)$/.test(path)) {
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("../extensions/", "./extensions/"));
  }
}
for (const path of await files(join(dist, "extensions")))
  if (path.endsWith(".js") || path.endsWith(".d.ts"))
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("../src/", "../"));
