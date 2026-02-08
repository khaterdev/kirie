import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/mcp/stdio-server.ts",
  ],
  format: "esm",
  dts: true,
  clean: true,
  target: "node22",
});
