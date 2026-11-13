// The responsive stylesheet must leave the phone layout (under 600 px wide) exactly as the client designed it: everything in
// it that changes how a screen looks sits behind a min-width of at least 600 px, and the few rules outside a media query
// are invisible wrappers, invisible touch-target padding, and a decoration that only ever existed from 720 px up.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/millimesh/responsive.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  prelude: string;
  body: string;
}

/** The top-level rules of a stylesheet (an @media block is one rule whose body holds the rules inside it). */
function topLevel(text: string): Rule[] {
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  let bodyStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ prelude: text.slice(start, bodyStart - 1).trim(), body: text.slice(bodyStart, i) });
        start = i + 1;
      }
    }
  }
  return rules;
}

const rules = topLevel(css);
const media = rules.filter((r) => r.prelude.startsWith("@media"));
const plain = rules.filter((r) => !r.prelude.startsWith("@media"));

describe("responsive.css keeps the phone layout as it is", () => {
  it("has media queries, and every one of them starts at 600 px or more (no max-width, nothing for a phone)", () => {
    expect(media.length).toBeGreaterThanOrEqual(6);
    for (const m of media) {
      const q = m.prelude.replace("@media", "").trim();
      for (const branch of q.split(",")) {
        const min = branch.match(/min-width:\s*(\d+)px/);
        expect(min, `no min-width in: ${m.prelude}`).not.toBeNull();
        expect(Number(min![1]), `starts too low: ${m.prelude}`).toBeGreaterThanOrEqual(600);
      }
      expect(m.prelude).not.toMatch(/max-width/);
    }
  });

  it("outside a media query it only adds invisible wrappers, hit-area padding and the dark-page disc switch-off", () => {
    const allowed = new Set([
      ".mm-coin-layout,\n.mm-coin-aside,\n.mm-camera-card,\n.mm-capture-body,\n.rv2-rest",
      ".mm-icon-btn",
      ".mm-icon-btn::after",
      ".mm-seg button",
      ".mm-seg button::after",
      ".mm-link:not(.mm-reset)",
      ".mm-link::after",
      ".mm-app .rv2-hero::before",
    ]);
    for (const r of plain) expect(allowed.has(r.prelude), `unexpected phone-wide rule: ${r.prelude}`).toBe(true);
  });

  it("the wrappers take no part in the phone layout (display: contents)", () => {
    const wrappers = plain.find((r) => r.prelude.includes(".mm-capture-body"))!;
    expect(wrappers.body.replace(/\s+/g, " ").trim()).toBe("display: contents;");
    for (const sel of [".mm-coin-layout", ".mm-coin-aside", ".mm-camera-card", ".mm-capture-body", ".rv2-rest"]) expect(wrappers.prelude).toContain(sel);
  });

  it("the hit-area padding is invisible: positioned, empty pseudo-elements only", () => {
    for (const r of plain.filter((x) => x.prelude.endsWith("::after"))) {
      expect(r.body).toMatch(/content:\s*""/);
      expect(r.body).toMatch(/position:\s*absolute/);
      expect(r.body).not.toMatch(/background|border|color|opacity/);
    }
  });

  it("the touch targets from 600 px up are at least 44 px", () => {
    const tablet = media.find((m) => m.prelude === "@media (min-width: 600px)")!;
    expect(tablet.body).toMatch(/\.mm-icon-btn\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
    expect(tablet.body).toMatch(/\.mm-seg button\s*\{[^}]*min-height:\s*44px/);
    expect(tablet.body).toMatch(/\.mm-btn\s*\{[^}]*min-height:\s*56px/);
  });
});
