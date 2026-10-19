// Guards against animations that silently do nothing because their @keyframes is missing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf-8");
const KEYWORDS = new Set([
  "none", "both", "forwards", "backwards", "infinite", "linear", "alternate", "reverse", "normal",
  "ease", "ease-in", "ease-out", "ease-in-out", "running", "paused",
]); // fmt: skip

describe("styles.css", () => {
  it("defines @keyframes for every animation it uses", () => {
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const used = new Set<string>();
    for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;]+);/g)) {
      const first = m[1].trim().split(/\s+/)[0];
      if (!KEYWORDS.has(first) && !first.startsWith("var(") && !/^[\d.]/.test(first)) used.add(first);
    }
    const missing = [...used].filter((n) => !defined.has(n));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(10);
  });
});
