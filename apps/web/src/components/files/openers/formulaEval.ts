/**
 * A small formula evaluator so edited spreadsheets show numbers, not `=B2*C2`.
 *
 * Covers what budgets and lists use: + - * / ^, parentheses, same-sheet cell
 * references and ranges, SUM / AVERAGE / MIN / MAX / COUNT / ROUND / ABS.
 * Anything else (other sheets, text functions, lookups) returns null and the
 * grid shows the formula; Excel/LibreOffice recalculate on open anyway.
 */
import * as XLSX from "xlsx";

type Value = number | number[];

class Unsupported extends Error {}

const FUNCTIONS: Record<string, (args: Value[]) => number> = {
  SUM: (args) => flat(args).reduce((sum, value) => sum + value, 0),
  AVERAGE: (args) => {
    const values = flat(args);
    if (values.length === 0) throw new Unsupported("empty average");
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  },
  MIN: (args) => (flat(args).length ? Math.min(...flat(args)) : 0),
  MAX: (args) => (flat(args).length ? Math.max(...flat(args)) : 0),
  COUNT: (args) => flat(args).length,
  ABS: (args) => Math.abs(scalar(args[0])),
  ROUND: (args) => {
    const digits = args[1] === undefined ? 0 : scalar(args[1]);
    const factor = 10 ** digits;
    return Math.round(scalar(args[0]) * factor) / factor;
  },
};

function flat(args: Value[]): number[] {
  return args.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function scalar(value: Value | undefined): number {
  if (value === undefined || Array.isArray(value)) throw new Unsupported("range as a number");
  return value;
}

const TOKEN =
  /\s*(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\d+(?:\.\d+)?(?:E[+-]?\d+)?|[A-Z]+(?=\()|[-+*/^(),])/iy;

function tokenize(formula: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let index = 0;
  while (index < formula.length) {
    if (formula.slice(index).trim() === "") break;
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(formula);
    if (!match) throw new Unsupported(`token at ${index}`);
    tokens.push(match[1]!.toUpperCase());
    index = TOKEN.lastIndex;
  }
  return tokens;
}

export function evaluateFormula(sheet: XLSX.WorkSheet, formula: string): number | null {
  return evaluateWith(sheet, formula, new Set());
}

function evaluateWith(
  sheet: XLSX.WorkSheet,
  formula: string,
  visiting: Set<string>,
): number | null {
  try {
    const tokens = tokenize(formula);
    let position = 0;
    const peek = () => tokens[position];
    const take = () => tokens[position++];

    const cellValue = (address: string): number => {
      const key = address.replaceAll("$", "");
      const cell = sheet[key] as XLSX.CellObject | undefined;
      if (!cell) return 0;
      if (cell.f && (cell.v === undefined || cell.v === "")) {
        if (visiting.has(key)) throw new Unsupported("cycle");
        visiting.add(key);
        const nested = evaluateWith(sheet, cell.f, visiting);
        visiting.delete(key);
        if (nested === null) throw new Unsupported("nested");
        return nested;
      }
      if (typeof cell.v === "number") return cell.v;
      if (typeof cell.v === "boolean") return cell.v ? 1 : 0;
      if (cell.v === undefined || cell.v === "") return 0;
      throw new Unsupported("text in arithmetic");
    };

    const rangeValues = (reference: string): number[] => {
      const range = XLSX.utils.decode_range(reference.replaceAll("$", ""));
      const values: number[] = [];
      for (let r = range.s.r; r <= range.e.r; r += 1) {
        for (let c = range.s.c; c <= range.e.c; c += 1) {
          const address = XLSX.utils.encode_cell({ r, c });
          const cell = sheet[address] as XLSX.CellObject | undefined;
          // Ranges skip blanks and text, like Excel's SUM.
          if (!cell) continue;
          if (cell.f || typeof cell.v === "number") values.push(cellValue(address));
        }
      }
      return values;
    };

    const primary = (): Value => {
      const token = take();
      if (token === undefined) throw new Unsupported("end");
      if (token === "(") {
        const value = expression();
        if (take() !== ")") throw new Unsupported("paren");
        return value;
      }
      if (token === "-") return -scalar(power());
      if (token === "+") return scalar(power());
      if (/^\d/.test(token)) return Number(token);
      if (peek() === "(" && /^[A-Z]+$/.test(token)) {
        const fn = FUNCTIONS[token];
        if (!fn) throw new Unsupported(token);
        take();
        const args: Value[] = [];
        if (peek() !== ")") {
          args.push(expression());
          while (peek() === ",") {
            take();
            args.push(expression());
          }
        }
        if (take() !== ")") throw new Unsupported("args");
        return fn(args);
      }
      if (token.includes(":")) return rangeValues(token);
      return cellValue(token);
    };

    const power = (): Value => {
      let left = primary();
      while (peek() === "^") {
        take();
        left = scalar(left) ** scalar(primary());
      }
      return left;
    };

    const term = (): Value => {
      let left = power();
      while (peek() === "*" || peek() === "/") {
        const op = take();
        const right = scalar(power());
        if (op === "/" && right === 0) throw new Unsupported("div0");
        left = op === "*" ? scalar(left) * right : scalar(left) / right;
      }
      return left;
    };

    function expression(): Value {
      let left = term();
      while (peek() === "+" || peek() === "-") {
        const op = take();
        const right = scalar(term());
        left = op === "+" ? scalar(left) + right : scalar(left) - right;
      }
      return left;
    }

    const result = scalar(expression());
    if (position !== tokens.length || !Number.isFinite(result)) return null;
    return Math.round(result * 1e10) / 1e10;
  } catch {
    return null;
  }
}
