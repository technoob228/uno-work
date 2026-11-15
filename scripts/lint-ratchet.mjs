#!/usr/bin/env node
// Линтер с храповиком: ошибки oxlint роняют проверку как раньше, а
// предупреждения сверяются с scripts/lint-baseline.json. Новое предупреждение
// (больше, чем записано для пары «правило + файл») роняет проверку; старые
// можно чинить постепенно, и запись сама уменьшается при локальном запуске.
//
//   node scripts/lint-ratchet.mjs            проверить
//   node scripts/lint-ratchet.mjs --update   переписать запись (после переноса
//                                            файлов; общий счёт расти не может)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASELINE_PATH = fileURLToPath(new URL("./lint-baseline.json", import.meta.url));
const update = process.argv.includes("--update");

const lint = spawnSync("oxlint", ["--report-unused-disable-directives", "--format=unix"], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
if (lint.error) {
  console.error(`!! не удалось запустить oxlint: ${lint.error.message}`);
  process.exit(2);
}

const DIAGNOSTIC = /^(.+?):(\d+):(\d+): (.*) \[(Warning|Error)(?:\/(.+))?\]$/;
const errors = [];
const current = {};
const locations = {};
for (const line of lint.stdout.split("\n")) {
  const match = DIAGNOSTIC.exec(line);
  if (!match) continue;
  const [, file, row, , message, level, rule = "unused-disable-directive"] = match;
  if (level === "Error") {
    errors.push(line);
    continue;
  }
  current[rule] ??= {};
  current[rule][file] = (current[rule][file] ?? 0) + 1;
  (locations[`${rule}\n${file}`] ??= []).push(`${file}:${row}: ${message}`);
}

if (errors.length > 0 || (lint.status !== 0 && lint.status !== null)) {
  for (const line of errors) console.error(line);
  console.error(`!! oxlint: ошибок ${errors.length}. Их нужно починить.`);
  process.exit(1);
}

const total = (counts) =>
  Object.values(counts).reduce(
    (sum, files) => sum + Object.values(files).reduce((a, b) => a + b, 0),
    0,
  );
const sorted = (counts) =>
  Object.fromEntries(
    Object.keys(counts)
      .toSorted()
      .map((rule) => [
        rule,
        Object.fromEntries(Object.entries(counts[rule]).toSorted(([a], [b]) => a.localeCompare(b))),
      ]),
  );
const save = (counts) =>
  writeFileSync(BASELINE_PATH, JSON.stringify(sorted(counts), null, 2) + "\n");

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
const before = baseline ? total(baseline) : null;
const now = total(current);

if (update) {
  if (before !== null && now > before) {
    console.error(
      `!! предупреждений стало ${now}, было ${before}: запись растить нельзя. Почини новые (node scripts/lint-ratchet.mjs покажет какие).`,
    );
    process.exit(1);
  }
  save(current);
  console.log(
    `lint: запись обновлена, предупреждений ${now}${before === null ? "" : ` (было ${before})`}`,
  );
  process.exit(0);
}

if (baseline === null) {
  console.error(
    "!! нет scripts/lint-baseline.json: создай её командой node scripts/lint-ratchet.mjs --update",
  );
  process.exit(1);
}

const added = [];
for (const [rule, files] of Object.entries(current)) {
  for (const [file, count] of Object.entries(files)) {
    const allowed = baseline[rule]?.[file] ?? 0;
    if (count > allowed) added.push({ rule, file, count, allowed });
  }
}

if (added.length > 0) {
  console.error(
    "!! Новые предупреждения линтера. Старые чинить не обязательно, новые добавлять нельзя:",
  );
  for (const { rule, file, count, allowed } of added) {
    console.error(`\n   ${rule} в ${file}: стало ${count}, было ${allowed}`);
    for (const where of locations[`${rule}\n${file}`]) console.error(`     ${where}`);
  }
  console.error(
    "\n   Почини код в этих местах. Если файл только переехал или переименован: node scripts/lint-ratchet.mjs --update (общий счёт вырасти не даст).",
  );
  process.exit(1);
}

if (now < before && !process.env.CI) {
  save(current);
  console.log(
    `lint: предупреждений стало меньше (${before} → ${now}), scripts/lint-baseline.json обновлена: закоммить её`,
  );
} else {
  console.log(`lint: ошибок нет, новых предупреждений нет (старых ${now})`);
}
