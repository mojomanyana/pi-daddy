/** Strict JSON framing for retention metadata/native records. Floats in native usage remain supported. */
export function parseRetentionJson(text: string, maxBytes = 64 * 1024): unknown {
  if (Buffer.byteLength(text) > maxBytes) throw new TypeError("retention JSON exceeds bounds");
  const value: unknown = JSON.parse(text);
  const stack: Array<{ object: boolean; key: boolean; seen: Set<string> }> = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
    const token = match[0], top = stack.at(-1);
    if (token === "{" || token === "[") {
      if (stack.length >= 64) throw new TypeError("retention JSON exceeds depth");
      stack.push({ object: token === "{", key: token === "{", seen: new Set() });
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") { if (top?.object) top.key = true; }
    else if (token.startsWith('"') && top?.object && top.key) {
      const key = JSON.parse(token) as string;
      if (top.seen.has(key)) throw new TypeError("duplicate retention JSON member");
      top.seen.add(key); top.key = false;
    } else if (/^-?\d/.test(token) && !Number.isFinite(Number(token))) throw new TypeError("non-finite retention JSON number");
  }
  return value;
}
