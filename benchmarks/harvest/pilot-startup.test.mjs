import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("pilot preserves the normal profile, substitutes only Daddy and supplies missing peers", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pi-pilot-config-"));
  t.after(() => rmSync(temp,{recursive:true,force:true}));
  const profile = join(temp,"profile"), repo = join(temp,"repo"), scripts = join(repo,"benchmarks","harvest");
  const products = join(repo,"packages","pi-daddy","src","products");
  for (const p of [profile,scripts,products,join(repo,".pi")]) mkdirSync(p,{recursive:true});
  const helper = join(scripts,"prepare-pilot.mjs");
  cpSync(new URL("./pilot-checkouts.mjs", import.meta.url),join(scripts,"pilot-checkouts.mjs"));
  cpSync(new URL("./prepare-pilot.mjs",import.meta.url),helper);
  cpSync(new URL("../../packages/pi-daddy/src/products/ecosystem-release.json",import.meta.url),join(products,"ecosystem-release.json"));
  writeFileSync(join(repo,"packages","pi-daddy","package.json"), JSON.stringify({name:"pi-daddy"}));
  const personal = JSON.stringify({packages:["npm:pi-daddy@1.1.3","npm:pi-bookie","npm:my-extra"],extensions:["./private.ts"]});
  writeFileSync(join(profile,"settings.json"),personal);
  const path=join(repo,".pi","settings.json");
  writeFileSync(path,JSON.stringify({packages:["npm:pi-scout-research"],defaultThinkingLevel:"medium"}));
  const run=()=> {const r=spawnSync(process.execPath,[helper],{env:{...process.env, PI_SCOUT_CHECKOUT:"", PI_BOOKIE_CHECKOUT:"",PI_CODING_AGENT_DIR:profile},encoding:"utf8"});assert.equal(r.status,0,r.stderr);};
  run();
  const result=readFileSync(path,"utf8");
  run();assert.equal(readFileSync(path,"utf8"),result);
  assert.equal(readFileSync(join(profile,"settings.json"),"utf8"),personal);
  assert.deepEqual(JSON.parse(result),{packages:["npm:pi-scout-research",{source:"npm:pi-daddy@1.1.3",autoload:false,extensions:["-extensions/grants.ts"]},"../packages/pi-daddy","npm:principal-pi-skills","npm:skill-harness"],defaultThinkingLevel:"medium"});
});

test("a checkout missing creation time uses a stable separate workspace for the live package", (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-workspace-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repo = join(temp, "mounted"), home = join(temp, "home"), profile = join(home, ".pi", "agent");
  const scripts = join(repo, "benchmarks", "harvest"), candidate = join(repo, "packages", "pi-daddy");
  const products = join(candidate, "src", "products");
  for (const path of [profile, scripts, products]) mkdirSync(path, { recursive: true });
  cpSync(new URL("./pilot-checkouts.mjs", import.meta.url),join(scripts,"pilot-checkouts.mjs"));
  cpSync(new URL("./prepare-pilot.mjs", import.meta.url), join(scripts, "prepare-pilot.mjs"));
  cpSync(new URL("../../packages/pi-daddy/src/products/ecosystem-release.json", import.meta.url), join(products, "ecosystem-release.json"));
  writeFileSync(join(candidate, "package.json"), JSON.stringify({ name: "pi-daddy" }));
  const hook = join(temp, "missing-birthtime.cjs");
  writeFileSync(hook, `
    const fs = require("node:fs");
    const stat = fs.statSync;
    fs.statSync = (path, options) => {
      const result = stat(path, options);
      if (options?.bigint && (path === process.env.MOUNT || process.env.NO_NATIVE === "1")) result.birthtimeNs = 0n;
      return result;
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const run = (more = {}) => spawnSync(process.execPath, ["--require", hook, join(scripts, "prepare-pilot.mjs"), "--print-workspace"], {
    encoding: "utf8", env: { ...process.env, PI_SCOUT_CHECKOUT:"", PI_BOOKIE_CHECKOUT:"", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: profile, MOUNT: repo, ...more },
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const workspace = first.stdout.trim();
  assert.ok(workspace.startsWith(join(home, ".local", "share", "pi-daddy", "harvest-pilot") + (process.platform === "win32" ? "\\" : "/")));
  assert.ok(JSON.parse(readFileSync(join(workspace, ".pi", "settings.json"))).packages.includes(candidate));
  assert.equal(existsSync(join(repo, ".pi")), false);
  assert.equal(run().stdout.trim(), workspace);
  const unavailable = run({ NO_NATIVE: "1" });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /Both candidate folders failed/);
});

for (const [scoutName, bookieName, override] of [["pi-scout-research","bookie-pi-skills",false], ["pi-harvest-scout","pi-harvest-bookie",false], ["custom-scout","custom-bookie",true]]) test(`paired checkouts ${scoutName} and ${bookieName} replace installed copies and survive a second launch`, t => {
  const temp = mkdtempSync(join(tmpdir(),"pi-scout-pilot-"));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const repo = join(temp,"bench"), scripts=join(repo,"benchmarks","harvest"), profile=join(temp,"profile");
  const products=join(repo,"packages","pi-daddy","src","products"), scout=join(temp,scoutName);
  const bookie=join(temp,bookieName,"packages","pi-extension");
  for (const p of [profile,scripts,products,join(scout,"lib"),bookie]) mkdirSync(p,{recursive:true});
  cpSync(new URL("./pilot-checkouts.mjs", import.meta.url),join(scripts,"pilot-checkouts.mjs"));
  cpSync(new URL("./prepare-pilot.mjs",import.meta.url), join(scripts,"prepare-pilot.mjs"));
  cpSync(new URL("../../packages/pi-daddy/src/products/ecosystem-release.json",import.meta.url),join(products,"ecosystem-release.json"));
  writeFileSync(join(scout,"package.json"),JSON.stringify({name:"pi-scout-research"}));
  writeFileSync(join(scout,"lib","research-model.mjs"),"");
  writeFileSync(join(bookie,"package.json"),JSON.stringify({name:"pi-bookie"}));
  const original=JSON.stringify({packages:["npm:pi-scout-research@1.0.2","npm:pi-bookie@1.0.4"]});
  writeFileSync(join(profile,"settings.json"),original);
  for(let i=0;i<2;i++){
    const result=spawnSync(process.execPath,[join(scripts,"prepare-pilot.mjs"),"--print-workspace"],{encoding:"utf8",env:{...process.env, PI_SCOUT_CHECKOUT:override ? scout : "", PI_BOOKIE_CHECKOUT:override ? join(temp,bookieName) : "", PI_CODING_AGENT_DIR:profile}});
    assert.equal(result.status,0,result.stderr);
    const {packages}=JSON.parse(readFileSync(join(result.stdout.trim(),".pi","settings.json")));
    assert.equal(packages.filter(p=>p===scout).length,1);
    assert.deepEqual(packages.find(p=>p.source==="npm:pi-scout-research@1.0.2")?.extensions,[]);
    assert.equal(packages.filter(p=>p===bookie).length,1);
    assert.deepEqual(packages.find(p=>p.source==="npm:pi-bookie@1.0.4")?.extensions,[]);
    assert.equal(readFileSync(join(profile,"settings.json"),"utf8"),original);
  }
});
