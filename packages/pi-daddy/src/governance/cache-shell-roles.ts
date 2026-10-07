/** Session-local root-issued native roles. Caller strings never issue/select authority.
 * CP1 kernel connector birth identity selects the row; root composition supplies actual current grants
 * and independently verified spawn/native context. This is NOT that production issuer/validator.
 * Attachment permits a public refusal, not payload/execution. Old generation leases never revive.
 * Native vectors not representable by the Record backend must bypass before issuance, never normalize.
 */
import { isCacheOwner, type CacheOwnerIdentity } from "../kernel/cache-owner.ts";
import { frozenPersonalInvocation, type PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
import type { CacheShellRequest } from "../kernel/cache-shell-protocol.ts";
export interface CacheShellRole {
  readonly cacheShellRole: unique symbol;
}
export interface CacheShellLease {
  readonly cacheShellLease: unique symbol;
}
interface Row {
  key: string;
  generation: number;
  invocation: Readonly<PersonalCacheInvocation>;
  environment: readonly string[];
  authorize(): boolean;
}
const key = (owner: CacheOwnerIdentity) => JSON.stringify([owner.bootId, owner.pid, owner.startTicks]);
export class CacheShellRoles {
  private rows = new Map<string, Row>();
  private byRole = new Map<CacheShellRole, Row>();
  private leases = new WeakMap<CacheShellLease, { row: Row; generation: number }>();
  private generation = 0;
  private limit: number;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw Error("cache shell role limit must be1..32");
    this.limit = limit;
  }
  issue(
    owner: CacheOwnerIdentity,
    workspace: string,
    input: PersonalCacheInvocation,
    authorize: () => boolean,
  ): CacheShellRole {
    if (
      !isCacheOwner(owner) ||
      !workspace.startsWith("/") ||
      workspace.includes("\0") ||
      workspace !== input.cwd ||
      typeof authorize !== "function" ||
      this.rows.has(key(owner)) ||
      this.rows.size >= this.limit
    )
      throw Error("cache shell role identity/workspace/owner bound invalid");
    const invocation = frozenPersonalInvocation(input),
      role = Object.freeze({}) as CacheShellRole;
    const environment = Object.entries(input.env).map(([name, value]) => `${name}=${value}`);
    const executed = Object.entries(invocation.env).map(([name, value]) => `${name}=${value}`);
    // Record enumeration must survive freezing; a changed input must not issue a mismatched native role.
    if (environment.some((text, index) => text !== executed[index]) || environment.length !== executed.length)
      throw Error("cache shell environment order unsupported by current backend");
    const row: Row = {
      key: key(owner),
      invocation,
      environment: Object.freeze(executed),
      authorize,
      generation: ++this.generation,
    };
    this.rows.set(row.key, row);
    this.byRole.set(role, row);
    return role;
  }
  attached(owner: CacheOwnerIdentity): boolean {
    return isCacheOwner(owner) && this.rows.has(key(owner));
  }
  bind(owner: CacheOwnerIdentity): CacheShellLease | undefined {
    const row = isCacheOwner(owner) ? this.rows.get(key(owner)) : undefined;
    if (!row) return;
    const lease = Object.freeze({}) as CacheShellLease;
    this.leases.set(lease, { row, generation: row.generation });
    return lease;
  }
  private row(lease: CacheShellLease) {
    const bound = this.leases.get(lease);
    return bound && this.rows.get(bound.row.key) === bound.row && bound.generation === bound.row.generation
      ? bound.row
      : undefined;
  }
  invocation(lease: CacheShellLease) {
    return this.row(lease)?.invocation;
  }
  authorized(lease: CacheShellLease): boolean {
    const row = this.row(lease);
    return !!row && row.authorize() === true && this.row(lease) === row;
  }
  matches(lease: CacheShellLease, request: CacheShellRequest): boolean {
    const row = this.row(lease),
      value = row?.invocation;
    return (
      !!value &&
      request.shell === value.shell &&
      request.cwd === value.cwd &&
      request.args.length === 2 &&
      request.args[0] === "-c" &&
      request.args[1] === value.command &&
      request.environment.length === row.environment.length &&
      request.environment.every((text, index) => text === row.environment[index])
    );
  }
  advance(role: CacheShellRole, authorize: () => boolean): void {
    const row = this.byRole.get(role);
    if (!row) throw Error("cache shell role foreign or released");
    row.generation = ++this.generation;
    row.authorize = authorize;
  }
  release(role: CacheShellRole): void {
    const row = this.byRole.get(role);
    if (!row) return;
    this.rows.delete(row.key);
    this.byRole.delete(role);
  }
  clear(): void {
    this.rows.clear();
    this.byRole.clear();
  }
  size(): number {
    return this.rows.size;
  }
}
