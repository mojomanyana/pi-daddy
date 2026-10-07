/** Authority metadata: only ENOENT is absence; damage and unresolved cleanup preserve failure. */
import { readBoundedFile } from "./bounded-read.ts";
export async function readAuthorityText(path: string): Promise<string> {
  const read = await readBoundedFile(path, { maxBytes: 1024 * 1024, timeoutMs: 2_000 });
  if (read.ok) return read.text;
  const error = new Error(`Cannot read ${path}: ${read.why} (${read.detail})`);
  if ("code" in read && read.code) Object.assign(error, { code: read.code });
  throw error;
}
export async function readOptionalAuthorityText(path: string): Promise<string | undefined> {
  try {
    return await readAuthorityText(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
