import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEcosystemVersionInventory, type VersionInventoryPorts } from "../extensions/ecosystem-versions.ts";

function fixture() {
  const disk = new Map([
    ["/host", "1.1.0"],
    ["/daddy", "0.47.0"],
    ["/principal", "4.11.2"],
    ["/harness", "0.26.2"],
  ]);
  const reports = [{ id: "principal-pi-skills", root: "/principal", version: "4.11.2" }];
  let configured = [
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
          } as Record<string, string>
        )[root],
      )
        ? (disk.get(root) ?? null)
        : null,
    configured: () => configured,
  };
  const api = {
    events: {
      emit: (_channel: string, request: unknown) => {
        for (const report of reports) (request as { report(value: unknown): void }).report(report);
      },
    },
  } as Pick<ExtensionAPI, "events">;
  const read = createEcosystemVersionInventory(api, "/daddy", ports);
  return {
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
