import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const packages = [
  "units", "math", "ir", "machine", "geometry", "strategies", "planner",
  "analysis", "compiler", "gcode-parser", "post-rs274", "post-makera",
  "script-host", "viewer-three",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: Object.fromEntries(
      packages.map((p) => [`@cam/${p}`, resolve(__dirname, `../../packages/${p}/src/index.ts`)]),
    ),
  },
  build: {
    // Workers and top-level await need a modern target; see design doc XII.1.
    target: "es2022",
  },
  server: { port: 5173 },
});
