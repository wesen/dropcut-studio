#!/usr/bin/env node
/**
 * dropcut — headless CAM compiler.
 *
 * Usage:
 *   dropcut compile <script.js> [-m machine] [-o out.nc] [--no-sim] [--quiet]
 *   dropcut examples
 *   dropcut example <name> [-o out.js]
 *   dropcut machines
 *   dropcut check <program.nc> [-m machine]
 *
 * Exists partly to be useful and partly to keep the project honest: everything
 * must work without a UI, which is what makes the core testable in Node and
 * runnable in a worker.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { formatCertificate, formatDuration } from "@cam/analysis";
import { describeProvenance } from "@cam/ir";
import type { Diagnostic } from "@cam/ir";
import { getMachine, machineIds } from "@cam/machine";
import { parseGcode } from "@cam/gcode-parser";
import { EXAMPLES, exampleByName } from "@cam/script-host";
import { compileScript } from "./compile.js";

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly machine: string;
  readonly out: string | null;
  readonly simulate: boolean;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let machine = "linuxcnc";
  let out: string | null = null;
  let simulate = true;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-m" || a === "--machine") machine = argv[++i] ?? machine;
    else if (a === "-o" || a === "--out") out = argv[++i] ?? null;
    else if (a === "--no-sim") simulate = false;
    else if (a === "-q" || a === "--quiet") quiet = true;
    else positional.push(a);
  }

  return { command: positional[0] ?? "help", positional: positional.slice(1), machine, out, simulate, quiet };
}

const RESET = "[0m";
const DIM = "[2m";
const RED = "[31m";
const YELLOW = "[33m";
const GREEN = "[32m";

function printDiagnostics(diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    const colour = d.severity === "error" ? RED : d.severity === "warning" ? YELLOW : DIM;
    const where = d.provenance?.script
      ? ` ${DIM}(line ${d.provenance.script.line})${RESET}`
      : d.gcodeLine !== undefined
        ? ` ${DIM}(gcode line ${d.gcodeLine + 1})${RESET}`
        : d.provenance
          ? ` ${DIM}(${describeProvenance(d.provenance)})${RESET}`
          : "";
    console.error(`  ${colour}${d.severity.toUpperCase()}${RESET} ${d.code}: ${d.message}${where}`);
  }
}

function cmdCompile(args: Args): number {
  const path = args.positional[0];
  if (!path) {
    console.error("usage: dropcut compile <script.js> [-m machine] [-o out.nc]");
    return 2;
  }

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const started = Date.now();
  const result = compileScript(source, {
    machineId: args.machine,
    skipSimulation: !args.simulate,
  });

  if (!result.ok) {
    console.error(`${RED}compile failed${RESET} at the ${result.stage} stage:`);
    printDiagnostics(result.diagnostics);
    return 1;
  }

  const elapsed = Date.now() - started;

  if (!args.quiet) {
    console.error(`${GREEN}compiled${RESET} for ${result.machine.name} in ${elapsed} ms`);
    for (const s of result.summaries) {
      console.error(`  ${DIM}${s.operationId.padEnd(12)}${RESET} ${s.description}`);
    }
    console.error(
      `  ${result.emitted.document.lines.length} lines · ` +
      `cut ${result.time.cutLength.toFixed(0)} mm · ` +
      `est ${formatDuration(result.time.total)} ${DIM}(${result.time.model})${RESET}`,
    );
    if (result.diagnostics.length > 0) {
      console.error("");
      printDiagnostics(result.diagnostics);
    }
    console.error("");
    console.error(formatCertificate(result.program.certificate));
  }

  if (args.out) {
    writeFileSync(args.out, result.emitted.document.text + "\n", "utf8");
    if (!args.quiet) console.error(`\nwrote ${args.out}`);
  } else {
    console.log(result.emitted.document.text);
  }
  return 0;
}

function cmdCheck(args: Args): number {
  const path = args.positional[0];
  if (!path) {
    console.error("usage: dropcut check <program.nc> [-m machine]");
    return 2;
  }
  const machine = getMachine(args.machine);
  const text = readFileSync(path, "utf8");
  const parsed = parseGcode(text, {
    rapidRate: machine.rapidRate,
    supportedG: machine.supportedG,
    supportedM: machine.supportedM,
  });

  console.error(`${path}: ${parsed.lineCount} lines, ${parsed.segments.length} moves, ` +
    `tools ${parsed.toolsUsed.join(", ") || "none"}`);
  console.error(`  bounds X ${parsed.bounds.minX.toFixed(1)}..${parsed.bounds.maxX.toFixed(1)} ` +
    `Y ${parsed.bounds.minY.toFixed(1)}..${parsed.bounds.maxY.toFixed(1)} ` +
    `Z ${parsed.bounds.minZ.toFixed(1)}..${parsed.bounds.maxZ.toFixed(1)}`);
  console.error(`  estimated ${formatDuration(parsed.totalSeconds)}`);

  if (parsed.headers.length > 0) {
    console.error(`  ${parsed.headers.length} structured header record(s)`);
  }

  const errors = parsed.diagnostics.filter((d) => d.severity === "error");
  if (parsed.diagnostics.length > 0) {
    console.error("");
    printDiagnostics(parsed.diagnostics.slice(0, 40));
    if (parsed.diagnostics.length > 40) {
      console.error(`  ${DIM}... and ${parsed.diagnostics.length - 40} more${RESET}`);
    }
  }
  return errors.length > 0 ? 1 : 0;
}

function cmdExamples(): number {
  for (const e of EXAMPLES) console.log(`${e.name.padEnd(20)} ${e.description}`);
  return 0;
}

function cmdExample(args: Args): number {
  const name = args.positional[0];
  const example = name ? exampleByName(name) : undefined;
  if (!example) {
    console.error(`unknown example "${name ?? ""}". Available: ${EXAMPLES.map((e) => e.name).join(", ")}`);
    return 2;
  }
  if (args.out) {
    writeFileSync(args.out, example.source, "utf8");
    console.error(`wrote ${args.out}`);
  } else {
    console.log(example.source);
  }
  return 0;
}

function cmdMachines(): number {
  for (const id of machineIds()) {
    const m = getMachine(id);
    console.log(
      `${id.padEnd(12)} ${m.name.padEnd(24)} ${m.dialect.padEnd(10)} ` +
      `arcs:${m.interpolation.arcXY ? "XY" : "-"}${m.interpolation.arcXZ ? "/XZ" : ""}` +
      `${m.interpolation.arcYZ ? "/YZ" : ""}`,
    );
  }
  return 0;
}

function usage(): number {
  console.log(`dropcut — headless CAM compiler

  compile <script.js> [-m machine] [-o out.nc] [--no-sim] [-q]
  check   <program.nc> [-m machine]
  example <name> [-o out.js]
  examples
  machines

machines: ${machineIds().join(", ")}`);
  return 0;
}

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case "compile": return cmdCompile(args);
    case "check": return cmdCheck(args);
    case "examples": return cmdExamples();
    case "example": return cmdExample(args);
    case "machines": return cmdMachines();
    default: return usage();
  }
}

// Only run when invoked directly, so tests can import `main` freely.
if (process.argv[1] && process.argv[1].endsWith("main.ts")) {
  process.exitCode = main(process.argv.slice(2));
}
