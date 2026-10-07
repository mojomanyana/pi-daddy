/** UNTESTED (per request). Narrow explicit GNU fixture profile; never infer eligibility from script names.
 * Exact effective invocation, installed runtime byte pins, regular members, manifest grammar and preload
 * absence are checked before issuance. Updating any runtime image requires a new source/semantic audit,
 * not automatically learning a new digest. Fingerprints remain personal best effort, not atomic freshness.
 */
import { createHash } from "node:crypto";
import { lstat, realpath, statfs } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseChecksumMembers } from "../kernel/cache-checksum-members.ts";
import type { PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
import type { CacheProductReaders } from "../executors/cache-product-readers.ts";
import type { PersonalCacheProfile } from "./cache-personal-runtime.ts";
const runtime = [
  ["/bin/bash", "3efccc187bafa75ff1e37d246270ab3e7aa559f242c7a52bf3ec2a1b5450bdbd"],
  ["/usr/bin/gnusha256sum", "d8ed629ca1c81da690bf2ee300a7f549deb0af20c861bda15ebdc1314fb93681"],
  ["/lib64/ld-linux-x86-64.so.2", "bda779ea9e9ad234f60315477d7cfd0bdde861cd8ddd9df8cdaf62f18c4cec14"],
  ["/usr/lib/x86_64-linux-gnu/libc.so.6", "85e64f97e348786a8fb4d9f3d52fec289e2fb86bba20f0731dfe61990525e0f7"],
  ["/usr/lib/x86_64-linux-gnu/libcrypto.so.3", "5385f0436ac2e284ba8c5fb1488874057c29c04be72dea32add832694f381e28"],
  ["/usr/lib/x86_64-linux-gnu/libtinfo.so.6", "085dbbe5dc38619276bdd0af37ae588969b1308baded09a2990ce8824a602912"],
  ["/usr/lib/x86_64-linux-gnu/libz.so.1", "47b61967895b30e8c0c6818dd633ffeb87711cf637c688f981896f0dd84ce23b"],
  ["/usr/lib/x86_64-linux-gnu/libzstd.so.1", "060eeb79531d435306665fd78329d8a9dd579f95876c5960bb67937825362a80"],
  ["/etc/ld.so.cache", "62c3750b75b93822019b431441247b30676dc2dfb1884a73db4ffe7dc84a8857"],
] as const;
export class CacheChecksumProfile {
  readonly profile: PersonalCacheProfile;
  readonly roots: readonly string[];
  private readonly readers: CacheProductReaders;
  private readonly manifest: string;
  private readonly members: readonly string[];
  reason = "not yet admitted";
  private constructor(cwd: string, manifest: string, members: readonly string[], readers: CacheProductReaders) {
    this.readers = readers;
    this.manifest = manifest;
    this.members = members;
    this.roots = [cwd, "/usr/bin", "/usr/lib/x86_64-linux-gnu", "/etc"];
    this.profile = Object.freeze({
      id: `gnu-sha256-check:${manifest}`,
      revision: "fixture-runtime-v1",
      contract: "personal-best-effort-v1",
      cwd,
      shell: "/bin/bash",
      command: `LC_ALL=C exec /usr/bin/gnusha256sum --strict -c ${manifest}`,
      env: Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }),
      effects: "none",
      external: "none",
      deterministic: true,
      inputs: Object.freeze([
        ...[join(cwd, manifest), ...members.map((name) => join(cwd, name)), ...runtime.map(([path]) => path)].map(
          (path) => Object.freeze({ path, kind: "file" as const }),
        ),
        Object.freeze({ path: "/etc/ld.so.preload", kind: "existence" as const }),
      ]),
    });
  }
  static async create(cwd: string, manifest: string, readers: CacheProductReaders): Promise<CacheChecksumProfile> {
    if (
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      isAbsolute(manifest) ||
      !/^[A-Za-z0-9_./-]+$/.test(manifest) ||
      manifest.startsWith("-") ||
      manifest.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw Error("cache GNU profile requires a literal workspace-relative manifest");
    cwd = await realpath(cwd);
    const bytes = await readers.read(join(cwd, manifest), 65536);
    const parsed = parseChecksumMembers(bytes, { maxBytes: 65536, maxMembers: 48 });
    if (parsed.kind !== "members") throw Error(parsed.reason);
    if (parsed.members.some((member) => isAbsolute(member.path)))
      throw Error("cache GNU members must stay workspace-relative");
    return new CacheChecksumProfile(
      cwd,
      manifest,
      parsed.members.map((member) => member.path),
      readers,
    );
  }
  matches(invocation: Readonly<PersonalCacheInvocation>): boolean {
    const profile = this.profile;
    return (
      invocation.cwd === profile.cwd &&
      invocation.shell === profile.shell &&
      invocation.command === profile.command &&
      JSON.stringify(invocation.env) === JSON.stringify(profile.env)
    );
  }
  /** Pending qualification cannot perform more I/O after its owning call/epoch stops. */
  async admit(invocation: Readonly<PersonalCacheInvocation>, continueAdmission: () => boolean = () => true): Promise<boolean> {
    if (!this.matches(invocation)) {
      this.reason = "unsupported effective command/environment/cwd";
      return false;
    }
    const decline = (reason: string) => {
      this.reason = reason;
      return false;
    };
    if (!continueAdmission()) return decline("profile admission stopped before input I/O");
    try {
      await lstat("/etc/ld.so.preload");
      return decline("loader preload exists; effects/dependencies unsupported");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const [path, expected] of runtime) {
      if (!continueAdmission()) return decline("profile admission stopped during input I/O");
      const filesystem = await statfs(path, { bigint: true });
      if (!continueAdmission()) return decline("profile admission stopped during input I/O");
      if (![0xef53n, 0x01021994n].includes(filesystem.type))
        return decline("runtime filesystem unsupported; ordinary execution");
      const bytes = await this.readers.read(path, 16 * 1024 * 1024);
      if (!continueAdmission()) return decline("profile admission stopped during input I/O");
      if (createHash("sha256").update(bytes).digest("hex") !== expected)
        return decline("installed GNU/Bash/runtime differs from supported fixture; ordinary execution");
    }
    const parsed = parseChecksumMembers(await this.readers.read(join(this.profile.cwd, this.manifest), 65536), {
      maxBytes: 65536,
      maxMembers: 48,
    });
    if (!continueAdmission()) return decline("profile admission stopped during manifest I/O");
    if (parsed.kind !== "members") return decline(parsed.reason);
    if (JSON.stringify(parsed.members.map((member) => member.path)) !== JSON.stringify(this.members))
      return decline("manifest membership changed; restart cold to discover the new closure");
    for (const name of [this.manifest, ...this.members]) {
      if (!continueAdmission()) return decline("profile admission stopped during member I/O");
      const path = join(this.profile.cwd, name), canonical = await realpath(path);
      if (!continueAdmission()) return decline("profile admission stopped during member I/O");
      const inside = relative(this.profile.cwd, canonical);
      if (inside === ".." || inside.startsWith("../") || isAbsolute(inside))
        return decline("manifest/member resolves outside workspace");
      const info = await lstat(canonical);
      if (!continueAdmission()) return decline("profile admission stopped during member I/O");
      if (!info.isFile()) return decline("manifest/member is not regular");
      const filesystem = await statfs(canonical, { bigint: true });
      if (!continueAdmission()) return decline("profile admission stopped during member I/O");
      if (![0xef53n, 0x01021994n].includes(filesystem.type))
        return decline("input filesystem is not supported local ext4/tmpfs; ordinary execution");
    }
    this.reason = "eligible explicit pinned GNU fixture; personal best effort";
    return true;
  }
}
