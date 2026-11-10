import { cellWidth, truncate } from "./dashboard-render.ts";

/** Keep related content together on wide terminals without filling the entire row with decoration. */
export function sectionHeading(title: string, width: number): string {
  const remaining = Math.min(width, 100) - cellWidth(title) - 2;
  return remaining >= 3 ? title + "  " + "─".repeat(remaining) : truncate(title, width);
}

export function previewWidth(destination: string, expanded: boolean, width: number): number | undefined {
  if (width < 82 || (!expanded && (width < 92 || !["now", "work", "reviews"].includes(destination)))) return;
  return Math.min(84, Math.floor(width * 0.57));
}

const sgr = (value: string, code: string) => (value ? `\x1b[${code}m${value}\x1b[0m` : "");

/** Apply terminal styles only to already-sanitized and measured display text. */
export function colorSessionLine(line: string, role: "header" | "navigation" | "footer" | "body"): string {
  if (role === "header") {
    const parts = /^(PI DADDY)(.*?)( · Connected)?$/.exec(line);
    return parts ? sgr(parts[1]!, "1;36") + parts[2] + sgr(parts[3] ?? "", "32") : line;
  }
  if (role === "navigation")
    return line.includes("[") ? line.replace(/\[[^\]]+\]/, (s) => sgr(s, "1;7")) : sgr(line, "1");
  if (role === "footer")
    return line.replace(
      /(^| · )(↑↓|Enter|Esc|PgUp\/PgDn|1–6|[?rqxpfs])/g,
      (_, space: string, key: string) => space + sgr(key, "1;36"),
    );
  const divider = line.indexOf(" │ ");
  if (divider >= 0) return paintCell(line.slice(0, divider)) + sgr(" │ ", "36") + paintCell(line.slice(divider + 3));
  return paintCell(line);
}

function paintCell(cell: string): string {
  const text = cell.trimEnd();
  const padding = cell.slice(text.length);
  if (text.startsWith("> ")) return sgr(text, "1;7") + padding;
  const rule = /^(.*?)  (─{3,})$/.exec(text);
  if (rule) {
    const title = rule[1]!;
    const attention = /^(?:Next step|Needs |Waiting for your review|NEXT ACTION)/i.test(title);
    return (
      sgr(
        title,
        attention ? "1;33" : /^(Recently finished|Saved results|What happened)/.test(title) ? "1;32" : "1;36",
      ) +
      "  " +
      sgr(rule[2]!, "36") +
      padding
    );
  }
  if (/^  /.test(text)) {
    const status =
      /( · )(Failed|Blocked|Run failed|Last attempt failed|Unavailable|Awaiting decision|Needs you|Live status unknown|Running|Finished|Saved|Available)(?= |$| ·)/;
    return (
      text.replace(status, (_, separator, state) => {
        const color = /^(Failed|Blocked|Last attempt failed|Run failed)$/.test(state)
          ? "90"
          : state === "Unavailable"
            ? "1;31"
            : /Awaiting|Needs you|unknown/.test(state)
              ? "33"
              : state === "Running"
                ? "36"
                : "32";
        return separator + sgr(state, color);
      }) + padding
    );
  }
  if (text === "/bookie-work review") return sgr(text, "1;36") + padding;
  if (/^(?:!|LAST OBSERVED|Disconnected)/.test(text)) return sgr(text, "1;33") + padding;
  return cell;
}
