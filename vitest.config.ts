import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const pkgs = [
  "units", "math", "ir", "machine", "geometry",
  "strategies", "planner", "analysis", "compiler",
  "gcode-parser", "post-rs274", "post-makera",
];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      pkgs.map((p) => [`@cam/${p}`, resolve(__dirname, `packages/${p}/src/index.ts`)]),
    ),
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
