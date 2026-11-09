import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEcosystemVersionInventory, type VersionInventoryPorts } from "../extensions/ecosystem-versions.ts";

function fixture(bookieName = "bookie-pi-skills") {
  const commands: ReturnType<ExtensionAPI["getCommands"]> = [];
  const disk = new Map([
    ["/host", "1.1.0"],
    ["/daddy", "0.47.0"],
    ["/principal", "4.11.2"],
    ["/harness", "0.26.2"],
    ["/scout", "0.1.1"],
    ["/bookie", "0.0.0"],
  ]);
  const reports = [{ id: "principal-pi-skills", root: "/principal", version: "4.11.2" }];
  let configured: ReturnType<VersionInventoryPorts["configured"]> = [
    { source: "npm:principal-pi-skills@4.11.2", scope: "project" as const, installedPath: "/principal" },
  ];
  const ports: VersionInventoryPorts = {
    hostVersion: "1.1.0",
    hostRoot: "/host",
    ownRoot: "/daddy",
    readVersion: (root, names) =>
      names.includes(
        (
          {
            "/host": "@earendil-works/pi-coding-agent",
            "/daddy": "pi-daddy",
            "/principal": "principal-pi-skills",
            "/harness": "skill-harness",
            "/scout": "pi-scout-research",
            "/bookie": bookieName,
          } as Record<string, string>
        )[root],
      )
        ? (disk.get(root) ?? null)
        : null,
    configured: () => configured,
  };
  const api = {
    getCommands: () => commands,
    events: {
      on: () => () => undefined,
      emit: (_channel: string, request: unknown) => {
        for (const report of reports) (request as { report(value: unknown): void }).report(report);
      },
    },
  };
  const read = createEcosystemVersionInventory(api, "/daddy", ports);
  return {
    commands,
    disk,
    reports,
    read: () => read({} as ExtensionContext),
    configured: (value: typeof configured) => {
      configured = value;
    },
  };
}
test("keeps loaded versions stable across disk updates and gives pin-aware scope-specific commands", () => {
  const f = fixture();
  assert.equal(f.read().rows.find((row) => row.id === "principal-pi-skills")?.state, "current");
  f.disk.set("/principal", "4.11.3");
  f.disk.set("/daddy", "0.48.0");
  f.disk.set("/host", "1.2.0");
  for (const id of ["pi", "pi-daddy", "principal-pi-skills"])
    assert.equal(f.read().rows.find((row) => row.id === id)?.state, "reload-required");
  const principal = f.read().rows.find((row) => row.id === "principal-pi-skills")!;
  assert.equal(principal.loadedVersion, "4.11.2");
  assert.equal(principal.installedVersion, "4.11.3");
  assert.deepEqual(principal.commands, [
    "pi install --local npm:principal-pi-skills@<version>",
    "node '/principal/scripts/install-agents.mjs' install",
    "node '/principal/scripts/install-agents.mjs' check",
  ]);
});
test("installed old packages remain unreported rather than being described as loaded", () => {
  const f = fixture();
  f.reports.length = 0;
  const row = f.read().rows.find((row) => row.id === "principal-pi-skills")!;
  assert.equal(row.state, "not-reported");
  assert.equal(row.loadedVersion, null);
  assert.equal(row.installedVersion, "4.11.2");
});
test("duplicate sources cannot choose an arbitrary installed generation or update scope", () => {
  const f = fixture();
  f.configured([
    { source: "npm:principal-pi-skills@4.11.2", scope: "project", installedPath: "/principal" },
    { source: "npm:principal-pi-skills@4.10.0", scope: "project", installedPath: "/other" },
  ]);
  const row = f.read().rows.find((row) => row.id === "principal-pi-skills")!;
  assert.equal(row.state, "multiple");
  assert.equal(row.source, null);
  assert.deepEqual(row.commands, ["pi list", "pi config"]);
});

test("discovers installed local and git packages even before they support loaded-generation reports", () => {
  for (const source of ["/principal", "git:github.com/example/principal@v4.11.0"]) {
    const f = fixture();
    f.reports.length = 0;
    f.configured([{ source, scope: "project", installedPath: "/principal" }]);
    const row = f.read().rows.find((item) => item.id === "principal-pi-skills")!;
    assert.equal(row.state, "not-reported");
    assert.equal(row.installedVersion, "4.11.2");
    assert.equal(row.loadedVersion, null);
    assert.equal(row.source, source);
    assert.deepEqual(row.commands.slice(0, 2), ["pi list", "pi config"]);
  }
});

test("a loaded local package cannot borrow the source and update commands of a different npm installation", () => {
  const f = fixture();
  f.configured([
    { source: "npm:principal-pi-skills@4.10.0", scope: "project", installedPath: "/configured-principal" },
  ]);
  const row = f.read().rows.find((item) => item.id === "principal-pi-skills")!;
  assert.equal(row.state, "multiple");
  assert.equal(row.source, null);
  assert.deepEqual(row.commands, ["pi list", "pi config"]);
});

test("Scout loaded generation and local Bookie availability remain separate from publication and compatibility", () => {
  const f = fixture();
  f.configured([
    { source: "npm:pi-scout-research@0.1.1", scope: "project", installedPath: "/scout" },
    { source: "/bookie", scope: "project", installedPath: "/bookie" },
  ]);
  f.reports.push({ id: "pi-scout-research", root: "/scout", version: "0.1.1" });
  const scout = f.read().rows.find((x) => x.id === "pi-scout-research")!;
  assert.equal(scout.state, "current");
  f.disk.set("/scout", "0.1.2");
  assert.equal(f.read().rows.find((x) => x.id === "pi-scout-research")!.state, "reload-required");
  const bookie = f.read().rows.find((x) => x.id === "bookie-pi-skills")!;
  assert.equal(bookie.state, "not-reported");
  assert.equal(bookie.installedVersion, "0.0.0");
  assert.equal(bookie.loadedVersion, null);
  assert.deepEqual(bookie.commands, ["pi list", "pi config"]);
});

test("Bookie public and legacy package names retain loaded identity and exact npm update target", () => {
  for (const name of ["pi-bookie", "bookie-pi-skills", "@bookie/pi-extension"]) {
    const f = fixture(name);
    f.disk.set("/bookie", "0.1.0");
    f.reports.push({ id: "bookie-pi-skills", root: "/bookie", version: "0.1.0" });
    f.configured([{ source: `npm:${name}@0.1.0`, scope: "project", installedPath: "/bookie" }]);
    const row = f.read().rows.find((item) => item.id === "bookie-pi-skills")!;
    assert.equal(row.state, "current", name);
    assert.equal(row.loadedVersion, "0.1.0", name);
    assert.equal(row.installedVersion, "0.1.0", name);
    assert.equal(row.source, `npm:${name}@0.1.0`, name);
    assert.deepEqual(row.commands, [`pi install --local npm:${name}@<version>`], name);
  }
});

test("configured Bookie aliases remain visible when installed bytes are unavailable", () => {
  for (const name of ["pi-bookie", "bookie-pi-skills", "@bookie/pi-extension"]) {
    const f = fixture(name);
    f.configured([{ source: `npm:${name}@0.1.0`, scope: "user" }]);
    const row = f.read().rows.find((item) => item.id === "bookie-pi-skills")!;
    assert.equal(row.state, "unavailable", name);
    assert.equal(row.loadedVersion, null, name);
    assert.equal(row.installedVersion, null, name);
    assert.equal(row.source, `npm:${name}@0.1.0`, name);
    assert.deepEqual(row.commands, [`pi install npm:${name}@<version>`], name);
  }
});

test("only a live command inside the selected Bookie package proves it loaded; the running version stays unknown", () => {
  const f = fixture("pi-bookie");
  f.configured([{ source: "npm:pi-bookie", scope: "user", installedPath: "/bookie" }]);
  const cmd = {
    name: "bookie-work",
    source: "extension",
    sourceInfo: { path: "/bookie-neighbor/src/index.ts" },
  } as const;
  const row = () => f.read().rows.find((x) => x.id === "bookie-pi-skills")!;
  f.commands.push(cmd as (typeof f.commands)[number]);
  assert.equal(row().commandAvailable, undefined);
  f.commands[0] = { ...f.commands[0]!, sourceInfo: { ...f.commands[0]!.sourceInfo, path: "/bookie/src/index.ts" } };
  assert.equal(row().commandAvailable, true);
  assert.equal(row().loadedVersion, null);
});
