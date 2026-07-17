// Generate GitBook- and Mintlify-ready docs from one markdown source of truth
// (docs/src/*.md + manifest.json), so the two never drift.
//
//   node docs/build.mjs
//
// Outputs:
//   docs/gitbook/   → connect as a GitBook "sync from Git" space
//   docs/mintlify/  → connect as a Mintlify project
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(ROOT, "src");
const man = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8"));
const pages = man.groups.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.group })));
const body = (p) => readFileSync(resolve(SRC, p.src), "utf8").trimEnd();

const fresh = (d) => { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); };

// ── GitBook ─────────────────────────────────────────────────────────────────
// GitBook renders plain .md and builds its sidebar from SUMMARY.md. The first
// entry maps to README.md (the space landing page).
function buildGitbook() {
  const out = resolve(ROOT, "gitbook");
  fresh(out);
  const [first, ...rest] = pages;

  // README.md = the overview/landing page.
  writeFileSync(resolve(out, "README.md"), body(first) + "\n");
  for (const p of rest) writeFileSync(resolve(out, `${p.slug}.md`), body(p) + "\n");

  // SUMMARY.md — the sidebar. Grouped headings become section titles.
  let s = "# Table of contents\n\n";
  s += `* [${first.title}](README.md)\n`;
  let curGroup = first.group;
  for (const p of rest) {
    if (p.group !== curGroup) { s += `\n## ${p.group}\n\n`; curGroup = p.group; }
    // the very first group's remaining pages sit under the intro; later groups get headings
    s += `* [${p.title}](${p.slug}.md)\n`;
  }
  writeFileSync(resolve(out, "SUMMARY.md"), s);

  // .gitbook.yaml — tells GitBook where the root + summary live.
  writeFileSync(resolve(out, ".gitbook.yaml"),
    "root: ./\nstructure:\n  readme: README.md\n  summary: SUMMARY.md\n");

  console.log(`gitbook/  → ${pages.length} pages + SUMMARY.md`);
}

// ── Mintlify ────────────────────────────────────────────────────────────────
// Mintlify renders .mdx with YAML frontmatter and reads navigation from mint.json.
function buildMintlify() {
  const out = resolve(ROOT, "mintlify");
  fresh(out);

  for (const p of pages) {
    const front = `---\ntitle: "${p.title}"\ndescription: "${p.description}"\n---\n\n`;
    writeFileSync(resolve(out, `${p.slug}.mdx`), front + body(p) + "\n");
  }

  const mint = {
    "$schema": "https://mintlify.com/schema.json",
    name: man.name,
    colors: { primary: "#7fae00", light: "#c3f53c", dark: "#0a0e05" },
    favicon: "/favicon.png",
    navigation: man.groups.map((g) => ({ group: g.group, pages: g.pages.map((p) => p.slug) })),
    topbarCtaButton: { name: "Launch a coin", url: man.site },
    footerSocials: { x: "https://x.com/robinlabshb", website: man.site },
  };
  writeFileSync(resolve(out, "mint.json"), JSON.stringify(mint, null, 2) + "\n");

  console.log(`mintlify/ → ${pages.length} .mdx pages + mint.json`);
}

buildGitbook();
buildMintlify();
console.log("done.");
