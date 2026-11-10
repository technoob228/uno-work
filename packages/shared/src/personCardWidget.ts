/**
 * A person card (`personCard.ts`) as a Telegram widget (Bot API 10.4,
 * `sendWidget`): a small HTML + JS app drawn inside the chat bubble. The
 * first choice in a private chat with the bot; where Telegram (or Uno's
 * relay) refuses it, the server sends the Rich Message as before
 * (`apps/server/src/manager/telegramRichCard.ts`).
 *
 * The widget runs in Telegram's sandbox (QuickJS, not a WebView): no
 * network, no inputs, no scrolling, 600 px tall at most, and the whole
 * message must be ≤ 4096 bytes zlib-compressed. So:
 *
 * - **Markup is drawn here**, every text the agent wrote escaped; the script
 *   holds no text of the agent at all (nothing to break out of), it only
 *   toggles classes and reads the labels back from the DOM.
 * - **Colours are Telegram's theme** (`--tg-theme-*`), so a light and a dark
 *   chat both look native; a system font, the person's font size.
 * - **The protocol** (`TelegramWidget.request`, ≤ 64 bytes): the card sends
 *   `<prefix><hexmask>` (bit i = option / action i) for a choice or a report,
 *   `<prefix><question>.<hexmask>` per answered quiz question. The bot answers
 *   every request with the card's state as JSON and mirrors it into
 *   `chat_data`, so a card opened again shows how it ended:
 *   `{"p":[i…],"d":1}` (picked, done), `{"a":[[i…]…],"d":1}` (quiz answers,
 *   done when finished), `{"e":"expired"}` (the card is gone).
 *
 * Pure: no Node imports. The compressed size is the server's check, passed
 * in as `fits`, so a card too big for it can drop its descriptions first.
 */
import {
  type PersonCard,
  type PersonCardAction,
  type PersonCardChoice,
  type PersonCardQuiz,
  type PersonCardReport,
  type PersonCardSection,
} from "./personCard.ts";
import { cardMarkdownToHtml, escapeCardText } from "./personCardHtml.ts";

export type PersonCardWidgetLanguage = "ru" | "en";

export interface PersonCardWidgetOptions {
  /** "💬 <chat>" over the card for a work chat speaking; null: the assistant itself. */
  readonly header: string | null;
  readonly language: PersonCardWidgetLanguage;
  /** What every request starts with, e.g. `w1:<groupId>:` (the server routes by it). */
  readonly requestPrefix: string;
  /**
   * Whether the html fits Telegram's limit (the server: zlib ≤ 4096 bytes).
   * Absent: only the raw size is checked.
   */
  readonly fits?: (html: string) => boolean;
}

export interface PersonCardWidget {
  readonly html: string;
  /**
   * The card's words (who speaks, title, question or summary): the message's
   * text above the widget, the notification, and all an old Telegram app shows.
   */
  readonly caption: string;
  /** The caption's main line, to send as bold (`caption_entities`, UTF-16 units). */
  readonly captionBold?: { readonly offset: number; readonly length: number };
  /** The card's first `chat_data`; absent: nothing picked yet. */
  readonly chatData?: string;
}

/** `sendWidget`: html 1–32768 bytes; caption 0–1024 characters; requests 1–64 bytes. */
export const PERSON_CARD_WIDGET_LIMITS = {
  htmlBytes: 32_768,
  zlibBytes: 4096,
  captionChars: 1024,
  requestBytes: 64,
  chatDataBytes: 1024,
  /** Telegram clips a widget at 600 px; nothing scrolls inside it. */
  maxHeightPx: 600,
} as const;

/** The state a card whose group is gone answers with (`{"e":"expired"}`). */
export const PERSON_CARD_WIDGET_EXPIRED = '{"e":"expired"}';

// ── Text ──────────────────────────────────────────────────────────────────

const esc = escapeCardText;
const say = (language: PersonCardWidgetLanguage, ru: string, en: string) =>
  language === "ru" ? ru : en;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/**
 * The agent's Markdown in the widget's tag set: the Work-chat renderer's
 * output, without what the sandbox drops (`tabindex`, `role`) and with links
 * only to https (they open through `TelegramWidget.openLink`).
 */
export function widgetMarkdownToHtml(markdown: string): string {
  return cardMarkdownToHtml(markdown)
    .replace(/ tabindex="0" role="region" aria-label="Table"/g, "")
    .replace(/<a href="(?!https:\/\/)[^"]*">([\s\S]*?)<\/a>/g, "$1");
}

// ── Height (a rough estimate at a 320-px bubble) ─────────────────────────
// Telegram clips a widget at 600 px and nothing scrolls, so a card that
// would be taller is not drawn as one. The numbers follow the CSS below:
// 15 px text, 8 px between blocks, 44-px rows.

/** Characters per line at ~296 px of text, 15 px system font. */
const CHARS_PER_LINE = 38;
const lines = (text: string | undefined, perLine = CHARS_PER_LINE): number =>
  text === undefined || text === ""
    ? 0
    : text
        .split("\n")
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);

const GAP = 8;
/** Padding: 12 on top, 24 at the bottom — the status line, beside the message time. */
const FRAME_PX = 12 + 24;

/** Blocks stacked in the card: their heights plus the gaps between them. */
// The header ("💬 chat"), the title and the question are in the caption, above the widget.
const stack = (_header: string | null, blocks: ReadonlyArray<number>): number => {
  const all = blocks;
  return FRAME_PX + all.reduce((sum, height) => sum + height, 0) + (all.length - 1) * GAP;
};

const rows = (heights: ReadonlyArray<number>, gap = 6): number =>
  heights.reduce((sum, height) => sum + height, 0) + Math.max(0, heights.length - 1) * gap;

/** What a Markdown line shows: link targets, marks and fences don't take room. */
const shownText = (line: string) =>
  line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>]+/g, "")
    .trim();

function sectionHeightPx(section: PersonCardSection): number {
  let height = 0;
  if (section.markdown) {
    for (const raw of section.markdown.split("\n")) {
      const line = shownText(raw);
      height += line.trim() === "" ? 6 : Math.max(1, Math.ceil(line.length / 40)) * 19;
    }
  }
  if (section.table) {
    const columns = section.table.columns.length;
    const perCell = Math.max(6, Math.floor(44 / columns));
    const rowLines = (row: ReadonlyArray<string>) =>
      Math.max(1, ...row.map((cell) => Math.ceil(cell.length / perCell)));
    height +=
      (section.markdown ? 8 : 0) +
      rowLines(section.table.columns) * 18 +
      section.table.rows.reduce((sum, row) => sum + 10 + rowLines(row) * 17, 0);
  }
  return height;
}

// ── Style ─────────────────────────────────────────────────────────────────
// Telegram's theme variables only (fallbacks for a preview); no vh, no
// sticky, no :has, no color-mix — the sandbox drops them. A tint is a
// pseudo-element at low opacity. Split by kind: a card carries only its own.

const CSS_BASE = `
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
i,em{font-style:normal}
.c{--tx:var(--tg-theme-text-color,#000);--hn:var(--tg-theme-hint-color,#8d949e);--ac:var(--tg-theme-button-color,#3390ec);--at:var(--tg-theme-button-text-color,#fff);--s2:var(--tg-theme-secondary-bg-color,#f1f2f5);--ak:var(--tg-theme-accent-text-color,#3390ec);--dn:var(--tg-theme-destructive-text-color,#e53935);--ln:var(--tg-theme-section-separator-color,#e2e4e8);--ok:#2ea55d;position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 12px calc(24px + var(--tg-content-safe-area-inset-bottom,0px));color:var(--tx);font-family:-apple-system,system-ui,Roboto,sans-serif;font-size:var(--tg-text-font-size,15px);line-height:1.35;-webkit-user-select:none;user-select:none}
.dk{--ok:#4cc47c}
.hd,.hn,.st{font-size:.82em;color:var(--hn)}
.hd{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h{font-size:1.1em;font-weight:700}
.q{font-weight:600}
.st{position:absolute;left:12px;right:64px;bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.er{color:var(--dn)}
.bt{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;padding:8px 14px;border:0;border-radius:12px;background:var(--s2);color:var(--ak);font:inherit;font-weight:600;transition:opacity .15s,transform .12s}
.bt:active,.o:active{transform:scale(.98)}
.pr{background:var(--ac);color:var(--at)}
.su{background:var(--ok);color:#fff}
.da{color:var(--dn)}
.x{opacity:.4}
`;

const CSS_OPTIONS = `
.os{display:flex;flex-direction:column;gap:6px}
.o{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:9px 12px;border:1.5px solid transparent;border-radius:12px;background:var(--s2);color:var(--tx);font:inherit;text-align:left;transition:opacity .15s,transform .12s}
.o>*{position:relative}
.o::before{content:"";position:absolute;top:0;left:0;right:0;bottom:0;border-radius:10px;background:var(--ac);opacity:0;transition:opacity .15s}
.o.p{border-color:var(--ac)}
.o.p::before{opacity:.14}
.k{flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border:1.5px solid var(--hn);border-radius:50%;color:var(--hn);font-size:.78em;font-weight:700}
.m .k{border-radius:7px}
.p .k{background:var(--ac);border-color:var(--ac);color:var(--at)}
.p i,.ok i,.no i{display:none}
.p .k::after,.ok .k::after{content:"✓"}
.t{flex:1;min-width:0;overflow-wrap:anywhere}
.l{font-weight:500}
.dn .o:not(.p){opacity:.4}
`;

const CSS_CHOICE = `
.r{border-color:var(--ac)}
.b{margin-left:6px;padding:1px 7px;border-radius:9px;background:var(--ac);color:var(--at);font-size:.72em;font-weight:700;white-space:nowrap;vertical-align:1px}
.d{display:block;margin-top:1px;font-size:.85em;color:var(--hn)}
.d1 .d{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dn .go{display:none}
`;

const CSS_REPORT = `
.sm{color:var(--hn)}
.mx{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.m3{grid-template-columns:1fr 1fr 1fr}
.mt{min-width:0;padding:7px 10px;border-radius:12px;background:var(--s2)}
.mx:not(.m3) .mt:last-child:nth-child(odd){grid-column:1/-1}
.ml,.mn{font-size:.74em;color:var(--hn);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mv{font-size:1.25em;font-weight:700;overflow-wrap:anywhere}
.m3 .mv{font-size:1.05em}
.g .mv,.g .mn{color:var(--ok)}
.bd .mv,.bd .mn{color:var(--dn)}
.sc{border-top:1px solid var(--ln);padding-top:6px}
details{border-top:1px solid var(--ln)}
details>.md{padding-bottom:6px}
summary{display:flex;align-items:center;justify-content:space-between;min-height:33px;font-weight:600;list-style:none}
summary::after{content:"›";color:var(--hn);font-size:1.3em;transform:rotate(90deg);transition:transform .15s}
[open] summary::after{transform:rotate(-90deg)}
.sh{font-weight:600}
.md{font-size:.93em;overflow-wrap:anywhere}
.md>*+*{margin-top:6px}
.md ul,.md ol{padding-left:18px}
.md h3{font-size:1em}
.md a{color:var(--tg-theme-link-color,var(--ak))}
.md code{padding:1px 4px;border-radius:5px;background:var(--s2);font-family:ui-monospace,Menlo,monospace;font-size:.88em}
.md pre{padding:8px 10px;border-radius:9px;background:var(--s2);white-space:pre-wrap}
.md pre code{padding:0}
.md blockquote{padding-left:9px;border-left:3px solid var(--ln);color:var(--hn)}
table{width:100%;border-collapse:collapse;font-size:.86em}
th{color:var(--hn);font-weight:600;text-align:left}
th,td{padding:5px 6px;vertical-align:top;overflow-wrap:anywhere}
tbody tr:nth-child(odd) td{background:var(--s2)}
.num{text-align:right}
.ac{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ac .pr,.one .bt{grid-column:1/-1}
.dn .a:not(.p){opacity:.4}
`;

const CSS_QUIZ = `
.qh{display:flex;justify-content:space-between;gap:8px}
.pg{display:flex;gap:4px}
.pg i{flex:1;height:4px;border-radius:2px;background:var(--ln)}
.pg .cu{background:var(--ac)}
.y{color:var(--ok)}
.n{color:var(--dn)}
.pg .y{background:var(--ok)}
.pg .n{background:var(--dn)}
.qq{display:flex;flex-direction:column;gap:8px}
.o.ok{border-color:var(--ok)}
.o.ok::before{background:var(--ok);opacity:.14}
.o.no{border-color:var(--dn)}
.o.no::before{background:var(--dn);opacity:.12}
.ok .k,.no .k{border:0;color:#fff;background:var(--ok)}
.no .k{background:var(--dn)}
.no .k::after{content:"✕"}
.dm{opacity:.45}
.ex{padding:10px 12px;border-radius:12px;background:var(--s2);font-size:.9em}
.ex b{display:block}
.big{font-size:2.6em;font-weight:800;text-align:center}
.big small{font-size:.45em;color:var(--hn)}
ol{display:flex;flex-direction:column;gap:4px;list-style:none;font-size:.88em}
li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

const css = (...parts: string[]) => parts.join("").replace(/\n+/g, "").trim();

// ── Behaviour ─────────────────────────────────────────────────────────────
// Written readable, joined into one line (every statement ends in `;` or
// `}`). No text of the agent in it — labels are read back from the DOM —
// only our own words, in the card's language.

const jsText = (strings: Record<string, string>): string =>
  Object.entries(strings)
    .map(([name, text]) => `${name}=${JSON.stringify(text)}`)
    .join(",");

const jsBase = (language: PersonCardWidgetLanguage) => `
var W=window.TelegramWidget||{},c=document.getElementById("c"),st=document.getElementById("st"),P=c.getAttribute("data-p"),S=null,busy=0,pend=null,
${jsText({
  NOT_SENT: say(language, "Не отправилось, нажмите ещё раз", "Not sent, tap again"),
  EXPIRED: say(language, "Карточка устарела", "This card has expired"),
})};
function all(s,r){return Array.prototype.slice.call((r||c).querySelectorAll(s))}
function cls(e,k,on){if(on)e.classList.add(k);else e.classList.remove(k)}
function show(e,on){if(on)e.removeAttribute("hidden");else e.setAttribute("hidden","")}
function say(t,k){st.textContent=t;st.className=k?"st "+k:"st"}
function buzz(k){var h=W.HapticFeedback;try{if(k)h.notificationOccurred(k);else h.impactOccurred("light")}catch(e){}}
function mask(a){var m=0;a.forEach(function(i){m|=1<<i});return m.toString(16)}
function off(){return busy||S&&(S.d||S.e)}
function gone(){if(S&&S.e){cls(c,"dn",1);say(EXPIRED);return 1}}
function fail(){busy=0;pend=null;draw();buzz("error");say(NOT_SENT,"er")}
function req(d,ok){busy=1;try{W.request(P+d).then(function(r){var s=JSON.parse(r.result);if(!s||s.e&&s.e!="expired")throw 0;busy=0;S=s;pend=null;if(ok)ok();draw()}).catch(fail)}catch(e){fail()}}
function load(){try{var s=JSON.parse(W.chatData);return s&&typeof s=="object"?s:null}catch(e){return null}}
function sync(){S=load();draw()}
function theme(){cls(c,"dk",W.colorScheme=="dark")}
theme();if(W.onEvent){W.onEvent("chatDataChanged",sync);W.onEvent("themeChanged",theme)}
`;

/** A choice and a report: options (or actions) with `data-i`; one tap, or toggles + Done. */
const JS_PICK = `
var O=all("[data-i]"),M=c.hasAttribute("data-m"),go=all(".go")[0],sel=[];
function lbl(i){var o=O[i];return (all(".l",o)[0]||o).textContent}
function draw(){var d=S&&S.d,p=d?S.p||[]:pend||sel;
O.forEach(function(o,i){cls(o,"p",p.indexOf(i)>-1)});cls(c,"dn",d);if(go)cls(go,"x",!sel.length||pend);
if(!gone())say(d?"✔ "+p.map(lbl).join(", "):pend?"…":"")}
function send(a){pend=a;draw();req(mask(a),function(){buzz("success")})}
O.forEach(function(o,i){o.addEventListener("click",function(){if(off())return;buzz();
if(!M)return send([i]);var j=sel.indexOf(i);if(j<0)sel.push(i);else sel.splice(j,1);draw()})});
if(go)go.addEventListener("click",function(){if(!off()&&sel.length)send(sel.slice())});
all("summary").forEach(function(s){s.addEventListener("click",function(){all("details").forEach(function(d){if(d!=s.parentNode)d.removeAttribute("open")})})});
sync();
`;

/** A quiz: one question at a time, colours at once, Next, the score at the end. */
const jsQuiz = (language: PersonCardWidgetLanguage) => `
var Q=all(".qq"),G=all(".pg i"),nx=document.getElementById("nx"),sc=document.getElementById("sc"),n=Q.length,v=0,tmp=[],
${jsText({
  RIGHT: say(language, "Верно!", "Right!"),
  WRONG: say(language, "Неверно. Ответ: ", "Wrong. The answer: "),
  NEXT: say(language, "Дальше", "Next"),
  SCORE: say(language, "Итог", "See the score"),
  CHECK: say(language, "Проверить", "Check"),
  SENT: say(language, "Результат ушёл в чат", "The score went to the chat"),
})};
function cor(q){return Q[q].getAttribute("data-c").split(",").map(Number)}
function same(a,b){return a.length==b.length&&a.every(function(x){return b.indexOf(x)>-1})}
function got(){return S&&S.a||[]}
function ans(q){return got()[q]||pend&&pend.q==q&&pend.p}
function lab(q,i){return all(".l",Q[q])[i].textContent}
function draw(){var a=got(),k=0;
if(S&&S.d){if(!ans(v))v=n}else if(v>a.length&&!pend)v=a.length;
Q.forEach(function(q,i){show(q,i==v)});show(sc,v>=n);
G.forEach(function(g,i){var p=ans(i);g.className=p?same(p,cor(i))?"y":"n":i==v?"cu":""});
if(v<n){var q=Q[v],p=ans(v),r=cor(v),ex=all(".ex",q)[0],b=all("b",ex)[0];
all(".o",q).forEach(function(o,i){o.className="o"+(p?r.indexOf(i)>-1?" ok":p.indexOf(i)>-1?" no":" dm":tmp.indexOf(i)>-1?" p":"")});
show(ex,p);if(p){var ok=same(p,r);b.className=ok?"y":"n";b.textContent=ok?RIGHT:WRONG+r.map(function(i){return lab(v,i)}).join(", ")}
show(nx,p||r.length>1);nx.textContent=p?v<n-1?NEXT:SCORE:CHECK;cls(nx,"x",!p&&!tmp.length)}
else{show(nx,0);var l=all("ol",sc)[0];l.textContent="";
Q.forEach(function(q,i){var p=a[i],ok=p&&same(p,cor(i)),li=document.createElement("li");if(ok)k++;
li.className=p?ok?"y":"n":"";li.textContent=(p?ok?"✓ ":"✕ ":"– ")+(i+1)+". "+all(".q",q)[0].textContent;l.appendChild(li)});
all("b",sc)[0].textContent=k}
cls(c,"dn",0);if(!gone())say(pend?"…":v>=n?SENT:"")}
function submit(q,p){pend={q:q,p:p};tmp=[];buzz(same(p,cor(q))?"success":"error");draw();req(q+"."+mask(p))}
Q.forEach(function(q,qi){all(".o",q).forEach(function(o,i){o.addEventListener("click",function(){
if(off()||qi!=v||ans(qi))return;if(cor(qi).length<2)return submit(qi,[i]);
var j=tmp.indexOf(i);if(j<0)tmp.push(i);else tmp.splice(j,1);buzz();draw()})})});
nx.addEventListener("click",function(){if(busy||S&&S.e)return;if(ans(v)){v++;tmp=[];draw()}else if(tmp.length&&!(S&&S.d))submit(v,tmp.slice())});
S=load();v=S&&S.d?n:got().length;draw();
`;

const js = (...parts: string[]) => parts.join("").replace(/\n/g, "").trim();

// ── Markup ────────────────────────────────────────────────────────────────

const KEYS = "ABCDEFGH";

interface Draw {
  readonly options: PersonCardWidgetOptions;
  /**
   * How much to leave out to fit: 0 everything; 1 option descriptions cut
   * to one line, no quiz explanations; 2 no descriptions either.
   */
  readonly lean: 0 | 1 | 2;
}

function frame(draw: Draw, body: string, style: string, script: string, extra = ""): string {
  const { requestPrefix } = draw.options;
  return (
    `<style>${style}</style>` +
    `<div class="c" id="c" data-p="${esc(requestPrefix)}"${extra}>` +
    body +
    '<p class="st" id="st"></p></div>' +
    `<script>${script}</script>`
  );
}

function choiceMarkup(card: PersonCardChoice, draw: Draw): string {
  const { language } = draw.options;
  const multiple = card.multiple === true;
  const options = card.options
    .map((option, index) => {
      const badge = option.recommended
        ? `<em class="b">⭐ ${say(language, "советую", "recommended")}</em>`
        : "";
      const description =
        option.description && draw.lean < 2
          ? `<span class="d">${esc(option.description)}</span>`
          : "";
      return (
        `<button class="o${option.recommended ? " r" : ""}" data-i="${index}"><b class="k"><i>${index + 1}</i></b>` +
        `<span class="t"><span class="l">${esc(option.label)}</span>${badge}${description}</span></button>`
      );
    })
    .join("");
  const hints = [
    multiple ? say(language, "Можно выбрать несколько", "Pick one or more") : null,
    card.allowOther
      ? say(language, "Или напишите свой ответ в чат", "Or type your own answer in the chat")
      : null,
  ].filter((hint): hint is string => hint !== null);
  const body =
    `<div class="os${multiple ? " m" : ""}${draw.lean === 1 ? " d1" : ""}">${options}</div>` +
    (hints.length > 0 ? `<p class="hn">${esc(hints.join(" · "))}</p>` : "") +
    (multiple ? `<button class="bt pr go x">${say(language, "Готово", "Done")}</button>` : "");
  return frame(
    draw,
    body,
    css(CSS_BASE, CSS_OPTIONS, CSS_CHOICE),
    js(jsBase(language), JS_PICK),
    multiple ? " data-m" : "",
  );
}

/** Actions pair up two in a row (the primary one alone) unless a label is long. */
const actionsStacked = (actions: ReadonlyArray<PersonCardAction>) =>
  actions.length === 1 || actions.some((action) => action.label.length > 18);

function actionClass(action: PersonCardAction, primary: boolean): string {
  const style = action.style ?? (primary ? "primary" : undefined);
  return style === "primary"
    ? " pr"
    : style === "success"
      ? " su"
      : style === "danger"
        ? " da"
        : "";
}

/** A cell typed into a table as Markdown: our pipes and line ends are not the agent's. */
const tableCell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ") || " ";

function sectionContent(section: PersonCardSection): string {
  return (
    (section.markdown ? `<div class="md">${widgetMarkdownToHtml(section.markdown)}</div>` : "") +
    (section.table
      ? `<div class="md">${widgetMarkdownToHtml(
          [
            `| ${section.table.columns.map(tableCell).join(" | ")} |`,
            `| ${section.table.columns.map(() => "---").join(" | ")} |`,
            ...section.table.rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`),
          ].join("\n"),
        )}</div>`
      : "")
  );
}

function reportMarkup(card: PersonCardReport, draw: Draw, layout: ReportLayout): string {
  const { language } = draw.options;
  const parts: string[] = [];
  if (card.metrics) {
    const tiles = card.metrics
      .map(
        (metric) =>
          `<div class="mt${metric.tone === "good" ? " g" : metric.tone === "bad" ? " bd" : ""}">` +
          `<p class="ml">${esc(metric.label)}</p><p class="mv">${esc(metric.value)}</p>` +
          (metric.note ? `<p class="mn">${esc(metric.note)}</p>` : "") +
          "</div>",
      )
      .join("");
    parts.push(`<div class="mx${card.metrics.length >= 5 ? " m3" : ""}">${tiles}</div>`);
  }
  const sections = card.sections ?? [];
  if (layout === "flat") {
    for (const section of sections) {
      parts.push(
        `<div class="sc">${section.heading ? `<p class="sh">${esc(section.heading)}</p>` : ""}${sectionContent(section)}</div>`,
      );
    }
  } else if (sections.length > 0) {
    // Exclusive accordions in one block: opening one closes the others.
    const folds = sections.map((section, index) => {
      const heading = section.heading ?? say(language, "Подробнее", "Details");
      return `<details${index === 0 && layout === "open" ? " open" : ""}><summary>${esc(heading)}</summary>${sectionContent(section)}</details>`;
    });
    parts.push(`<div>${folds.join("")}</div>`);
  }
  if (card.actions) {
    // A styled primary goes first; else the first unstyled one is primary and first.
    const primaryIndex = card.actions.some((action) => action.style === "primary")
      ? -1
      : card.actions.findIndex((action) => action.style === undefined);
    const first = (index: number) =>
      card.actions![index]!.style === "primary" || index === primaryIndex ? 1 : 0;
    const ordered = card.actions
      .map((action, index) => ({ action, index }))
      .toSorted((left, right) => first(right.index) - first(left.index));
    parts.push(
      `<div class="ac${actionsStacked(card.actions) ? " one" : ""}">${ordered
        .map(
          ({ action, index }) =>
            `<button class="bt a${actionClass(action, index === primaryIndex)}" data-i="${index}">${esc(action.label)}</button>`,
        )
        .join("")}</div>`,
    );
  }
  return frame(draw, parts.join(""), css(CSS_BASE, CSS_REPORT), js(jsBase(language), JS_PICK));
}

function quizMarkup(card: PersonCardQuiz, draw: Draw): string {
  const { language } = draw.options;
  const total = card.questions.length;
  const questions = card.questions
    .map((question, index) => {
      const options = question.options
        .map(
          (option, optionIndex) =>
            `<button class="o"><b class="k"><i>${KEYS[optionIndex] ?? optionIndex + 1}</i></b><span class="t l">${esc(option)}</span></button>`,
        )
        .join("");
      const explanation = question.explanation && draw.lean === 0 ? esc(question.explanation) : "";
      const multi = question.correct.length > 1;
      return (
        `<section class="qq" data-c="${question.correct.join(",")}"${index === 0 ? "" : " hidden"}>` +
        `<p class="q">${esc(question.question)}</p>` +
        (multi
          ? `<p class="hn">${say(language, "Выберите все верные", "Pick all that are right")}</p>`
          : "") +
        `<div class="os${multi ? " m" : ""}">${options}</div>` +
        `<p class="ex" hidden><b></b>${explanation}</p></section>`
      );
    })
    .join("");
  const body =
    (total > 1 ? `<div class="pg">${"<i></i>".repeat(total)}</div>` : "") +
    questions +
    `<section id="sc" hidden><p class="big"><b>0</b><small>/${total}</small></p><ol></ol></section>` +
    '<button class="bt pr" id="nx" hidden></button>';
  return frame(
    draw,
    body,
    css(CSS_BASE, CSS_OPTIONS, CSS_QUIZ),
    js(jsBase(language), jsQuiz(language)),
  );
}

// ── Caption ──────────────────────────────────────────────────────────────

/**
 * The words of the card, as the message's own text ABOVE the widget
 * (`show_caption_above_media`): who speaks, the title, the question or the
 * summary. The widget does not repeat them (Misha, 10.11: the caption under
 * the card said everything twice). It is also the notification's text and
 * all an old Telegram app shows. `bold`: the range of its main line (UTF-16).
 */
function caption(
  card: PersonCard,
  options: PersonCardWidgetOptions,
): { readonly text: string; readonly bold: { readonly offset: number; readonly length: number } } {
  const { header, language } = options;
  const before = header === null ? "" : `${header}\n`;
  let main: string;
  let rest: string | undefined;
  switch (card.kind) {
    case "choice":
      main = card.title ?? card.question;
      rest = card.title ? card.question : undefined;
      break;
    case "report":
      main = card.title;
      rest = card.summary;
      break;
    case "quiz": {
      const count = card.questions.length;
      const what =
        count === 1
          ? say(language, "1 вопрос", "1 question")
          : say(language, `${count} вопросов`, `${count} questions`);
      main = `🧩 ${card.title ?? say(language, "Квиз", "Quiz")} · ${what}`;
      break;
    }
  }
  const text = clip(
    `${before}${main}${rest ? `\n${rest}` : ""}`,
    PERSON_CARD_WIDGET_LIMITS.captionChars,
  );
  const length = Math.max(0, Math.min(main.length, text.length - before.length));
  return { text, bold: { offset: before.length, length } };
}

// ── Fitting ───────────────────────────────────────────────────────────────

const ROOM = PERSON_CARD_WIDGET_LIMITS.maxHeightPx;

function choiceHeight(card: PersonCardChoice, header: string | null, lean: Draw["lean"]): number {
  const options = card.options.map((option) => {
    const label = lines(`${option.label}${option.recommended ? " ⭐ recommended" : ""}`, 30);
    const description =
      option.description === undefined || lean === 2
        ? 0
        : (lean === 1 ? 1 : lines(option.description, 33)) * 17;
    return Math.max(44, 21 + label * 20 + description);
  });
  return stack(header, [
    rows(options),
    ...(card.multiple || card.allowOther ? [16] : []),
    ...(card.multiple ? [44] : []),
  ]);
}

function quizFits(card: PersonCardQuiz, header: string | null, lean: Draw["lean"]): boolean {
  return card.questions.every((question) => {
    const options = question.options.map((option) => Math.max(44, 21 + lines(option, 30) * 20));
    const explanation =
      20 + (question.explanation && lean === 0 ? lines(question.explanation, 34) * 17 : 0);
    const height = stack(header, [
      ...(card.questions.length > 1 ? [4] : []),
      lines(question.question, 36) * 20,
      ...(question.correct.length > 1 ? [16] : []),
      rows(options),
      explanation,
      44,
    ]);
    return height <= ROOM;
  });
}

type ReportLayout = "flat" | "open" | "folded";

function actionsHeight(actions: ReadonlyArray<PersonCardAction>): number {
  if (actionsStacked(actions)) {
    return rows(actions.map((action) => (action.label.length > 30 ? 64 : 44)));
  }
  const primary = actions.some((action) => action.style === "primary" || action.style === undefined)
    ? 1
    : 0;
  return rows(
    Array.from({ length: primary + Math.ceil((actions.length - primary) / 2) }, () => 44),
  );
}

/**
 * The report's layout at 600 px: `flat` (one section, shown), `open` (the
 * first section unfolded), `folded`; null when it can't fit. Sections are
 * exclusive accordions: each, opened alone, must fit, or it would clip.
 * Pictures never fit a 4-KB widget; a table over 5 columns doesn't fit 320 px.
 */
function reportLayout(card: PersonCardReport, header: string | null): ReportLayout | null {
  if ((card.images?.length ?? 0) > 0) return null;
  const sections = card.sections ?? [];
  if (sections.some((section) => (section.table?.columns.length ?? 0) > 5)) return null;
  const metrics = card.metrics ?? [];
  const metricRow = metrics.some((metric) => metric.note !== undefined) ? 60 : 46;
  const metricRows =
    metrics.length >= 5 ? Math.ceil(metrics.length / 3) : Math.ceil(metrics.length / 2);
  // Only a title and a summary: nothing for a widget to draw.
  if (metrics.length === 0 && sections.length === 0 && (card.actions?.length ?? 0) === 0)
    return null;
  const blocks = [
    ...(metrics.length > 0 ? [rows(Array.from({ length: metricRows }, () => metricRow))] : []),
    ...(card.actions ? [actionsHeight(card.actions)] : []),
  ];
  if (sections.length === 0) return stack(header, blocks) <= ROOM ? "flat" : null;
  if (sections.length === 1) {
    const section = sections[0]!;
    return stack(header, [...blocks, (section.heading ? 27 : 7) + sectionHeightPx(section)]) <= ROOM
      ? "flat"
      : null;
  }
  // One block of folded rows (34 px each); one of them open adds its content.
  const withOpen = (index: number | null) =>
    stack(header, [
      ...blocks,
      sections.length * 34 + (index === null ? 0 : 6 + sectionHeightPx(sections[index]!)),
    ]);
  if (sections.some((_, index) => withOpen(index) > ROOM)) return null;
  return withOpen(0) <= ROOM ? "open" : "folded";
}

const fitsBudget = (html: string, options: PersonCardWidgetOptions): boolean =>
  utf8Bytes(html) <= PERSON_CARD_WIDGET_LIMITS.htmlBytes && (options.fits?.(html) ?? true);

/**
 * The card as a Telegram widget, or null when it can't be one (pictures, too
 * tall for 600 px, too big compressed even without descriptions): the caller
 * sends the Rich Message instead.
 */
export function renderPersonCardWidget(
  card: PersonCard,
  options: PersonCardWidgetOptions,
): PersonCardWidget | null {
  const levels: ReadonlyArray<Draw["lean"]> = card.kind === "choice" ? [0, 1, 2] : [0, 1];
  for (const lean of levels) {
    const draw: Draw = { options, lean };
    let html: string | null = null;
    switch (card.kind) {
      case "choice":
        if (choiceHeight(card, options.header, lean) <= ROOM) html = choiceMarkup(card, draw);
        break;
      case "quiz":
        if (quizFits(card, options.header, lean)) html = quizMarkup(card, draw);
        break;
      case "report": {
        if (lean > 0) return null;
        const layout = reportLayout(card, options.header);
        if (layout === null) return null;
        html = reportMarkup(card, draw, layout);
        break;
      }
    }
    if (html !== null && fitsBudget(html, options)) {
      const words = caption(card, options);
      return { html, caption: words.text, captionBold: words.bold };
    }
  }
  return null;
}

// ── State (the server's answers; also what the preview's shim answers) ──

/** A choice / report: what was picked, and whether the card is spent. */
export const widgetPickState = (picked: ReadonlyArray<number>, done: boolean): string =>
  JSON.stringify(done ? { p: picked, d: 1 } : { p: picked });

/** A quiz: the picks per answered question, and whether it is over. */
export const widgetQuizState = (
  answers: ReadonlyArray<ReadonlyArray<number>>,
  done: boolean,
): string => JSON.stringify(done ? { a: answers, d: 1 } : { a: answers });
