#!/usr/bin/env node
// Запрет «цветной полосы сбоку» у карточек, плашек, тостов и строк.
//
// Решение Миши 10.11.2026: толстая цветная полоса у левого (или правого) края
// скруглённой карточки — самый явный признак «навайбкоженного» интерфейса.
// В продуктах Uno её нет нигде. Выделяем фоном, весом текста, иконкой или
// обычной рамкой по всему периметру — но не полосой сбоку.
//
// Ловит в .css/.scss/.svelte/.html/.tsx/.jsx/.ts:
//   border-left / border-right / border-inline-start|end толщиной от 1.5px,
//   box-shadow: inset Npx 0 0 (N >= 2) — та же полоса тенью,
//   Tailwind: border-l-2/4/8/[..], border-s-*, border-r-*, border-e-*, shadow-[inset_..].
// Не ловит (это не полоса): галочки (блок с transform: rotate),
// линии-связки и засечки графиков — их помечают комментарием в том же
// CSS-блоке: /* side-stripe-ok: причина */ (или в той же строке разметки).
//
//   node scripts/check-no-side-stripe.mjs [папка ...]   (по умолчанию — .)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".svelte-kit",
  ".turbo",
  "vendor",
  "coverage",
  ".plans",
  "mockups",
  "release",
  "out",
  "public",
]);
const EXT = /\.(css|scss|svelte|html|tsx|jsx|ts|vue)$/;
const SKIP_FILE = /\.min\.|\.d\.ts$|check-no-side-stripe|noSideStripe/;

const W = String.raw`(?:[2-9]|1\.[5-9]\d*|[1-9]\d)(?:\.\d+)?(?:px|rem|em)?`;
const CSS_RULES = [
  new RegExp(
    String.raw`border-(?:left|right|inline-start|inline-end)(?:-width)?\s*:\s*${W}\b`,
    "i",
  ),
  new RegExp(
    String.raw`border-(?:left|right|inline-start|inline-end)\s*:\s*(?:solid|dashed|dotted|double)\s+${W}\b`,
    "i",
  ),
  /box-shadow\s*:[^;]*\binset\s+-?(?:[2-9]|\d{2})(?:\.\d+)?px\s+0(?:px)?\s+0/i,
];
const TW_RULES = [
  /(?:^|[\s"'`])(?:[a-z-]+:)*border-(?:l|r|s|e)-(?:[2-9]|\[)/,
  /(?:^|[\s"'`])(?:[a-z-]+:)*shadow-\[inset_/,
];
const OK = /side-stripe-ok/;

function blockAround(text, idx) {
  const open = text.lastIndexOf("{", idx);
  const close = text.indexOf("}", idx);
  return text.slice(open === -1 ? 0 : open, close === -1 ? text.length : close);
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name) && !SKIP_FILE.test(name)) out.push(p);
  }
  return out;
}

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["."];
const bad = [];
for (const root of roots) {
  for (const file of walk(root, [])) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    let offset = 0;
    lines.forEach((line, i) => {
      const at = offset;
      offset += line.length + 1;
      if (OK.test(line)) return;
      const css = CSS_RULES.some((r) => r.test(line));
      const tw = /\.(svelte|html|tsx|jsx|ts|vue)$/.test(file) && TW_RULES.some((r) => r.test(line));
      if (!css && !tw) return;
      if (css) {
        const block = blockAround(text, at + line.search(/border|box-shadow/i));
        if (OK.test(block) || /transform\s*:\s*rotate/i.test(block)) return;
      }
      bad.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
}

if (bad.length) {
  console.error(
    "!! Цветная полоса сбоку запрещена (решение Миши 10.11): выделяйте фоном, весом, иконкой или рамкой целиком.",
  );
  console.error(
    "   Если это не полоса, а связка/засечка графика/цитата — пометьте /* side-stripe-ok: причина */.",
  );
  for (const b of bad) console.error("   " + b);
  process.exit(1);
}
