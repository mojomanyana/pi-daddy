/** Compare stable major.minor.patch versions. Build metadata does not affect precedence. */
export function compareStableVersions(left: string, right: string): number | undefined {
  const format = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const a = format.exec(left);
  const b = format.exec(right);
  if (!a || !b) return undefined;
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(a[i]);
    const y = BigInt(b[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
