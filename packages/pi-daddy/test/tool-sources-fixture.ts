import { fileURLToPath } from "node:url";

const natives = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const daddy = ["delegate", "delegate_all", "delegate_chain", "delegate_describe"];
/** Real Pi getAllTools includes public origins, including for inactive native tools. */
export function toolSources(names = [...natives, ...daddy]) {
  return names.map((name) => ({
    name,
    sourceInfo: natives.includes(name)
      ? { source: "builtin", path: `builtin:${name}` }
      : {
          source: "local",
          path: daddy.includes(name)
            ? fileURLToPath(new URL("../extensions/grants.ts", import.meta.url))
            : `/fixture/${name}.ts`,
        },
  }));
}
