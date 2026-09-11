import { readFile, writeFile, mkdir, symlink, realpath, readdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadDashboardHarness, type DashboardHarnessArtifact } from "../src/dashboard-harness.ts";
import { hash } from "./debrief-durable-fixture.ts";
export async function connectedHarness(root: string) {
  const sources = new URL("fixtures/dashboard-host/", import.meta.url), modules=join(root,"harness");await mkdir(modules,{mode:0o700});await writeFile(join(modules,"package.json"),'{"type":"module"}');
  await mkdir(join(modules,"node_modules"));await symlink(await realpath(new URL("../node_modules/typebox",import.meta.url)),join(modules,"node_modules/typebox"));
  const pins=JSON.parse(await readFile(new URL("provenance.json",sources),"utf8"));
  for(const pin of pins){const bytes=await readFile(new URL(pin.target,sources),"utf8");if(hash(bytes)!==pin.sha256||pin.commit!=="127b349310dd8f28e5d6b12148a063fce66a77dd")throw Error("pinned host source drift");
    const dest=join(modules,pin.path.replace(/\.ts$/,".js"));await mkdir(dirname(dest),{recursive:true});const core=relative(dirname(dest),join(modules,"core.js"));
    const mapped=bytes.replace(/from (["'])@skill-harness\/core\1/g,()=>`from ${JSON.stringify(core.startsWith(".")?core:"./"+core)}`);
    const result=ts.transpileModule(mapped,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext},reportDiagnostics:true});if(result.diagnostics?.length)throw Error("host compile diagnostics");await writeFile(dest,result.outputText);
  }
  await writeFile(join(modules,"core.js"),["work-capture","work-signals","intervention","factory-calibration"].map(n=>`export * from './packages/core/src/${n}.js';`).join("\n"));
  const files:Record<string,string>={};async function walk(dir:string){for(const d of await readdir(dir,{withFileTypes:true})){if(d.name==="node_modules")continue;const p=join(dir,d.name);if(d.isDirectory())await walk(p);else files[relative(modules,p)]=hash(await readFile(p));}}await walk(modules);
  const typeboxRoot=await realpath(new URL("../node_modules/typebox",import.meta.url));const artifact:DashboardHarnessArtifact={version:"dashboard-harness-artifact-v1",sourceCommit:"127b349310dd8f28e5d6b12148a063fce66a77dd",files,typeboxRoot,typeboxPackageSha256:hash(await readFile(join(typeboxRoot,"package.json")))};
  await writeFile(join(root,"harness-artifact.json"),JSON.stringify(artifact));const loaded=await loadDashboardHarness(modules,artifact,root),api=loaded.api as any;
  const archiveRoot=join(root,"archive");await mkdir(archiveRoot,{mode:0o700});return {api,archiveRoot,modules,pins,artifactDigest:loaded.artifactDigest,loadedDirectory:loaded.directory};
}
