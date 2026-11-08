// EXPERIMENTAL physical phantom validation report. A thin wrapper: the logic (type-checked and tested) lives in
// src/experimental/validation/cli.ts. Usage: npx tsx scripts/phantom-report.ts --help
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPhantomReport } from "../src/experimental/validation/cli";

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await runPhantomReport(process.argv.slice(2), { cwd: process.cwd(), repoRoot: path.resolve(frontend, "..") });
for (const m of result.messages) console.log(m);
process.exit(result.code);
