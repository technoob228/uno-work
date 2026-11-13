/**
 * Enough of a POSIX shell (and of zsh, the Mac's login shell) to judge a
 * command line before it runs: words with quotes removed, `~` and `$HOME`
 * expanded the way the shell would, the simple commands between `;` `&&`
 * `||` `|` `&` and newlines, their redirections, and the text of every
 * `$(…)` / backtick substitution (judged on its own, `tiers.ts`).
 *
 * It never guesses in the agent's favour: what it can't follow is marked —
 * a word with another variable or a substitution in it is `dynamic`, braces
 * that expand are `brace`, `(`…`)` (subshells, zsh glob qualifiers, case
 * patterns, arithmetic) set `parens`, an unquoted heredoc with `$(` or a
 * backtick sets `hiddenCode`, an unbalanced quote sets `broken`. The judge
 * turns each of those into "asks".
 *
 * @module myComputer/trust/shellParse
 */

export interface Word {
  /** The value the command will see, as far as it is known. */
  readonly text: string;
  /** Holds a variable other than HOME, a substitution, `$'…'` or `~user`. */
  readonly dynamic: boolean;
  /** An unquoted `*`, `?` or `[`. */
  readonly glob: boolean;
  /** An unquoted `{a,b}` or `{1..3}`. */
  readonly brace: boolean;
  /** Some part of it was quoted. */
  readonly quoted: boolean;
}

export interface Redirect {
  readonly op: string;
  readonly target: Word;
}

export interface Segment {
  readonly words: ReadonlyArray<Word>;
  readonly redirects: ReadonlyArray<Redirect>;
  /** Its input comes from the previous command through a pipe. */
  readonly piped: boolean;
}

export interface ParsedShell {
  readonly segments: ReadonlyArray<Segment>;
  /** Every `$(…)` and backtick body, in order: each is a command line too. */
  readonly substitutions: ReadonlyArray<string>;
  /** `(`, `)`, `<(…)`, `>(…)`, `$((…))` appeared unquoted. */
  readonly parens: boolean;
  /** An unquoted heredoc body holds `$(` or a backtick: code runs from data. */
  readonly hiddenCode: boolean;
  /** An unterminated quote or substitution: the shell would see something else. */
  readonly broken: boolean;
}

const CONTROL_OPS = new Set([";", "&&", "||", "|", "|&", "&", "\n", ";;", ";&", ";;&"]);
const OPERATORS = [
  ";;&",
  "&>>",
  "<<<",
  "<<-",
  ";;",
  ";&",
  "&&",
  "||",
  "|&",
  "&>",
  ">>",
  ">|",
  ">&",
  "<&",
  "<>",
  "<<",
  ">",
  "<",
  "|",
  "&",
  ";",
  "(",
  ")",
];
const REDIRECT_OPS = new Set([
  "&>>",
  "&>",
  ">>",
  ">|",
  ">&",
  "<&",
  "<>",
  ">",
  "<",
  "<<",
  "<<-",
  "<<<",
]);
const BREAK = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Token =
  | { readonly kind: "word"; readonly word: Word }
  | { readonly kind: "op"; readonly op: string };

interface Pending {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly quoted: boolean;
}

/**
 * The body of a `$(`…`)` starting at `start` (just past the `(`): its end
 * index (at the closing `)`), or -1 when it never closes.
 */
function matchParen(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      if (i >= source.length) return -1;
      i += 1;
      continue;
    }
    if (c === "`") {
      const end = source.indexOf("`", i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

export function parseShell(source: string, home: string): ParsedShell {
  const tokens: Array<Token> = [];
  const substitutions: Array<string> = [];
  const pending: Array<Pending> = [];
  let parens = false;
  let hiddenCode = false;
  let broken = false;
  let i = 0;
  /** The next word is a heredoc's delimiter. */
  let delimiterNext: { stripTabs: boolean } | null = null;

  const readHeredocs = () => {
    while (pending.length > 0) {
      const doc = pending.shift()!;
      const body: Array<string> = [];
      let closed = false;
      while (i < source.length) {
        const end = source.indexOf("\n", i);
        const line = source.slice(i, end < 0 ? source.length : end);
        i = end < 0 ? source.length : end + 1;
        const compared = doc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (compared === doc.delimiter) {
          closed = true;
          break;
        }
        body.push(line);
      }
      if (!closed) broken = true;
      const text = body.join("\n");
      if (!doc.quoted && (text.includes("$(") || text.includes("`"))) hiddenCode = true;
    }
  };

  const readWord = (): Word => {
    let text = "";
    let dynamic = false;
    let glob = false;
    let brace = false;
    let quoted = false;
    let braceDepth = 0;
    const atStart = () => text.length === 0 && !quoted;

    /** `$…` at `i` (on the `$`). Returns the text to add. */
    const dollar = (): string => {
      const next = source[i + 1];
      if (next === "(") {
        if (source[i + 2] === "(") {
          parens = true;
          const end = matchParen(source, i + 2);
          if (end < 0 || source[end + 1] !== ")") {
            broken = true;
            i = source.length;
            return "";
          }
          substitutions.push(source.slice(i + 3, end));
          i = end + 2;
          dynamic = true;
          return "";
        }
        const end = matchParen(source, i + 2);
        if (end < 0) {
          broken = true;
          i = source.length;
          return "";
        }
        substitutions.push(source.slice(i + 2, end));
        i = end + 1;
        dynamic = true;
        return "";
      }
      if (next === "{") {
        const end = source.indexOf("}", i + 2);
        if (end < 0) {
          broken = true;
          i = source.length;
          return "";
        }
        const inner = source.slice(i + 2, end);
        i = end + 1;
        if (inner === "HOME") return home;
        dynamic = true;
        if (inner.includes("$(") || inner.includes("`")) {
          substitutions.push(inner);
        }
        return "";
      }
      if (next !== undefined && /[A-Za-z_]/.test(next)) {
        let j = i + 1;
        while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
        const name = source.slice(i + 1, j);
        i = j;
        if (name === "HOME") return home;
        dynamic = true;
        return "";
      }
      if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
        i += 2;
        dynamic = true;
        return "";
      }
      i += 1;
      return "$";
    };

    while (i < source.length) {
      const c = source[i]!;
      if (BREAK.has(c)) break;
      if (c === "\\") {
        if (source[i + 1] === "\n") {
          i += 2;
          continue;
        }
        if (i + 1 < source.length) {
          text += source[i + 1];
          quoted = true;
        }
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = source.indexOf("'", i + 1);
        if (end < 0) {
          broken = true;
          text += source.slice(i + 1);
          i = source.length;
          break;
        }
        text += source.slice(i + 1, end);
        quoted = true;
        i = end + 1;
        continue;
      }
      if (c === "$" && source[i + 1] === "'") {
        // ANSI-C quoting: escapes we don't decode.
        let j = i + 2;
        while (j < source.length && source[j] !== "'") j += source[j] === "\\" ? 2 : 1;
        if (j >= source.length) broken = true;
        text += source.slice(i + 2, j);
        dynamic = true;
        quoted = true;
        i = j + 1;
        continue;
      }
      if (c === '"' || (c === "$" && source[i + 1] === '"')) {
        i += c === "$" ? 2 : 1;
        quoted = true;
        let closed = false;
        while (i < source.length) {
          const d = source[i]!;
          if (d === '"') {
            closed = true;
            i += 1;
            break;
          }
          if (d === "\\" && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1]!)) {
            if (source[i + 1] !== "\n") text += source[i + 1];
            i += 2;
            continue;
          }
          if (d === "$") {
            text += dollar();
            continue;
          }
          if (d === "`") {
            const end = source.indexOf("`", i + 1);
            if (end < 0) {
              broken = true;
              i = source.length;
              break;
            }
            substitutions.push(source.slice(i + 1, end));
            dynamic = true;
            i = end + 1;
            continue;
          }
          text += d;
          i += 1;
        }
        if (!closed) broken = true;
        continue;
      }
      if (c === "$") {
        text += dollar();
        continue;
      }
      if (c === "`") {
        const end = source.indexOf("`", i + 1);
        if (end < 0) {
          broken = true;
          i = source.length;
          break;
        }
        substitutions.push(source.slice(i + 1, end));
        dynamic = true;
        i = end + 1;
        continue;
      }
      if (c === "~" && atStart()) {
        const next = source[i + 1];
        if (next === undefined || next === "/" || BREAK.has(next)) {
          text += home;
          i += 1;
          continue;
        }
        // ~user, ~+, ~-: someone else's home or a directory stack.
        dynamic = true;
        text += c;
        i += 1;
        continue;
      }
      if (c === "*" || c === "?" || c === "[") glob = true;
      if (c === "{") braceDepth += 1;
      if (c === "}" && braceDepth > 0) braceDepth -= 1;
      if (braceDepth > 0 && (c === "," || (c === "." && source[i + 1] === "."))) brace = true;
      text += c;
      i += 1;
    }
    return { text, dynamic, glob, brace, quoted };
  };

  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === "\\" && source[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "\n") {
      tokens.push({ kind: "op", op: "\n" });
      i += 1;
      readHeredocs();
      continue;
    }
    // A file descriptor before a redirection: `2>`, `1>>`, `0<`.
    const fd = /^\d+(?=[<>])/.exec(source.slice(i, i + 12));
    if (fd) i += fd[0].length;
    if ((c === "<" || c === ">") && source[i + 1] === "(") {
      // Process substitution: a command whose output is a path.
      parens = true;
      const end = matchParen(source, i + 2);
      if (end < 0) {
        broken = true;
        break;
      }
      substitutions.push(source.slice(i + 2, end));
      tokens.push({
        kind: "word",
        word: { text: "/dev/fd/63", dynamic: true, glob: false, brace: false, quoted: false },
      });
      i = end + 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op !== undefined) {
      tokens.push({ kind: "op", op });
      i += op.length;
      if (op === "(" || op === ")") parens = true;
      if (op === "<<" || op === "<<-") delimiterNext = { stripTabs: op === "<<-" };
      continue;
    }
    const word = readWord();
    if (delimiterNext !== null) {
      pending.push({
        delimiter: word.text,
        stripTabs: delimiterNext.stripTabs,
        quoted: word.quoted,
      });
      delimiterNext = null;
    }
    tokens.push({ kind: "word", word });
  }
  if (pending.length > 0) {
    // A heredoc that never got its newline: nothing follows it.
    broken = true;
  }

  const segments: Array<Segment> = [];
  let words: Array<Word> = [];
  let redirects: Array<Redirect> = [];
  let piped = false;
  let nextPiped = false;
  const flush = () => {
    if (words.length > 0 || redirects.length > 0) {
      segments.push({ words, redirects, piped });
    }
    words = [];
    redirects = [];
    piped = nextPiped;
    nextPiped = false;
  };
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t]!;
    if (token.kind === "word") {
      words.push(token.word);
      continue;
    }
    if (CONTROL_OPS.has(token.op)) {
      nextPiped = token.op === "|" || token.op === "|&";
      flush();
      continue;
    }
    if (token.op === "(" || token.op === ")") {
      flush();
      continue;
    }
    if (REDIRECT_OPS.has(token.op)) {
      const target = tokens[t + 1];
      if (target?.kind === "word") {
        redirects.push({ op: token.op, target: target.word });
        t += 1;
      } else {
        broken = true;
      }
    }
  }
  flush();
  return { segments, substitutions, parens, hiddenCode, broken };
}

/** `NAME=value` as the first words of a command. */
export function assignmentName(word: Word): string | null {
  const eq = word.text.indexOf("=");
  if (eq <= 0) return null;
  const name = word.text.slice(0, eq);
  return NAME.test(name) ? name : null;
}
