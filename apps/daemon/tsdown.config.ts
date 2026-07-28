import { defineConfig } from "tsdown";

export default defineConfig({
  // index.ts starts the daemon as a side effect on import, so lifecycle.ts is
  // built as its own entry. That is what the CLI's `daemon` command imports via
  // the "./lifecycle" subpath export.
  entry: ["src/index.ts", "src/lifecycle.ts"],
  format: "esm",
  dts: true,
  clean: true,
  target: "node22",
});
