/**
 * A page to LOOK at `show_card` cards as Telegram widgets (Bot API 10.4)
 * before a release: sample cards, each in a 320-px and a 400-px bubble, in a
 * light and a dark Telegram theme. Every widget runs in its own
 * `<iframe srcdoc>` with a small `window.TelegramWidget` shim (themeParams,
 * chatData, onEvent, request answered after 300 ms like our bot would,
 * HapticFeedback no-op), clipped at 600 px like Telegram does.
 *
 *   bun apps/server/scripts/preview-card-widgets.ts /tmp/uno-card-widgets/preview.html
 *
 * Not Telegram: its sandbox (QuickJS, a tag/CSS subset) may still differ.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { validatePersonCard, type PersonCard } from "@t3tools/shared/personCard";
import { renderPersonCardWidget } from "@t3tools/shared/personCardWidget";

const card = (input: unknown): PersonCard => {
  const checked = validatePersonCard(input);
  if (!checked.ok) throw new Error(checked.error);
  return checked.card;
};

interface Sample {
  readonly name: string;
  readonly card: PersonCard;
  readonly language: "ru" | "en";
  readonly header: string | null;
  /** The widget's chat_data when it opens (a card answered before, an expired one). */
  readonly chatData?: string;
  /** The shim's request fails (to see the "not sent" line). */
  readonly failing?: boolean;
}

const SAMPLES: ReadonlyArray<Sample> = [
  {
    name: "Choice, one answer",
    language: "en",
    header: "💬 Fix the site",
    card: card({
      kind: "choice",
      question: "Deploy the new version now?",
      options: [{ label: "Deploy", recommended: true }, "Wait until tonight", "Cancel"],
    }),
  },
  {
    name: "Choice, several, recommended + descriptions (RU)",
    language: "ru",
    header: null,
    card: card({
      kind: "choice",
      title: "Тариф для магазина",
      question: "Какие возможности включить перед распродажей?",
      multiple: true,
      allowOther: true,
      options: [
        {
          label: "Резервные копии",
          description: "Каждую ночь, хранятся 14 дней",
          recommended: true,
        },
        { label: "Второй регион", description: "Сайт откроется быстрее в США" },
        { label: "Чистый IP", description: "Свой адрес для писем и платежей" },
        { label: "Больше памяти", description: "8 ГБ вместо 4" },
      ],
    }),
  },
  {
    name: "Report: metrics, sections, a table, actions",
    language: "en",
    header: "💬 Site audit",
    card: card({
      kind: "report",
      title: "Site checked: 3 problems",
      summary: "Two are quick to fix; the third needs a bigger plan.",
      metrics: [
        { label: "Speed", value: "92/100", tone: "good" },
        { label: "Errors", value: "3", tone: "bad", note: "+2 this week" },
        { label: "Pages", value: "41" },
        { label: "Visitors", value: "1 240", note: "7 days" },
      ],
      sections: [
        {
          heading: "Problems",
          markdown:
            "- **No favicon** on any page\n- Slow hero image (`hero.png`, 1.8 MB)\n- Broken link to [the docs](https://example.com/docs)",
        },
        {
          heading: "Slowest pages",
          table: {
            columns: ["Page", "Load", "Size"],
            rows: [
              ["/", "1.2 s", "800 KB"],
              ["/pricing", "0.9 s", "420 KB"],
              ["/blog", "2.4 s", "1.6 MB"],
            ],
          },
        },
        {
          heading: "What I'd do",
          markdown: "1. Compress the image\n2. Add the favicon\n3. Move to Plus",
        },
      ],
      actions: [
        { label: "Fix both", style: "success" },
        { label: "Show the image" },
        { label: "Leave it", style: "danger" },
      ],
    }),
  },
  {
    name: "Quiz (one multi-answer question)",
    language: "en",
    header: null,
    card: card({
      kind: "quiz",
      title: "Capitals",
      questions: [
        {
          question: "Capital of France?",
          options: ["Lyon", "Paris", "Marseille"],
          correct: [1],
          explanation: "Paris has been the capital since 508.",
        },
        {
          question: "Which of these are rivers?",
          options: ["Seine", "Rome", "Rhine", "Alps"],
          correct: [0, 2],
          explanation: "The Seine and the Rhine.",
        },
        { question: "Capital of Italy?", options: ["Rome", "Milan"], correct: [0] },
      ],
    }),
  },
  {
    name: "Choice answered before (chat_data)",
    language: "en",
    header: null,
    chatData: '{"p":[1],"d":1}',
    card: card({ kind: "choice", question: "Which plan?", options: ["Small", "Plus", "Pro"] }),
  },
  {
    name: "Expired card",
    language: "en",
    header: null,
    chatData: '{"e":"expired"}',
    card: card({ kind: "choice", question: "Which plan?", options: ["Small", "Plus"] }),
  },
  {
    name: "Request fails (tap to see)",
    language: "en",
    header: null,
    failing: true,
    card: card({
      kind: "choice",
      question: "Try a tap: the bot doesn't answer",
      options: ["One", "Two"],
    }),
  },
];

const THEMES = {
  light: {
    bg_color: "#ffffff",
    text_color: "#000000",
    hint_color: "#8e8e93",
    link_color: "#2481cc",
    button_color: "#3390ec",
    button_text_color: "#ffffff",
    secondary_bg_color: "#f1f1f4",
    accent_text_color: "#2481cc",
    subtitle_text_color: "#8e8e93",
    destructive_text_color: "#e53935",
    section_bg_color: "#ffffff",
    section_header_text_color: "#6d6d72",
    section_separator_color: "#e3e3e8",
    header_bg_color: "#ffffff",
    bottom_bar_bg_color: "#ffffff",
  },
  dark: {
    bg_color: "#212d3b",
    text_color: "#ffffff",
    hint_color: "#7d8b99",
    link_color: "#62bcf9",
    button_color: "#5288c1",
    button_text_color: "#ffffff",
    secondary_bg_color: "#151e27",
    accent_text_color: "#6ab3f3",
    subtitle_text_color: "#7d8b99",
    destructive_text_color: "#ec3942",
    section_bg_color: "#17212b",
    section_header_text_color: "#6ab3f3",
    section_separator_color: "#111921",
    header_bg_color: "#17212b",
    bottom_bar_bg_color: "#17212b",
  },
} as const;

type ThemeName = keyof typeof THEMES;

/**
 * `window.TelegramWidget` as our bot would answer: a choice / report spends
 * on the first tap, a quiz records each answer and is done after the last.
 */
const shim = (input: {
  readonly theme: ThemeName;
  readonly chatData: string | null;
  readonly failing: boolean;
  readonly questions: number;
}) => `<script>(function(){
var handlers={},answers=[],n=${input.questions};
function fire(t){(handlers[t]||[]).forEach(function(h){h()})}
function height(){parent.postMessage({widgetHeight:document.documentElement.scrollHeight,id:frameElement&&frameElement.id},"*")}
var W={themeParams:${JSON.stringify(THEMES[input.theme])},colorScheme:${JSON.stringify(input.theme)},chatData:${JSON.stringify(input.chatData)},publicData:null,
contentSafeAreaInset:{top:0,right:0,left:0,bottom:0,cornerRight:44,cornerLeft:0},
HapticFeedback:{impactOccurred:function(){},notificationOccurred:function(){},selectionChanged:function(){}},
onEvent:function(t,h){(handlers[t]=handlers[t]||[]).push(h)},
openLink:function(u){window.open(u,"_blank")},setResizeAnchor:function(){},
request:function(data){return new Promise(function(ok,no){setTimeout(function(){
${input.failing ? 'var e=new Error("no answer");e.name="WidgetRequestError";e.code="TIMEOUT";no(e);return;' : ""}
var body=data.replace(/^w1:[^:]+:/,""),m=/^(?:(\\d+)\\.)?([0-9a-f]+)$/.exec(body),picks=[],mask=parseInt(m[2],16),i,state;
for(i=0;i<12;i++)if(mask>>i&1)picks.push(i);
if(m[1]!==undefined){answers[Number(m[1])]=picks;state=answers.length>=n?{a:answers,d:1}:{a:answers}}else state={p:picks,d:1};
state=JSON.stringify(state);ok({result:state});setTimeout(function(){W.chatData=state;fire("chatDataChanged")},50);
},300)})}};
window.TelegramWidget=W;
var root=document.documentElement;Object.keys(W.themeParams).forEach(function(k){root.style.setProperty("--tg-theme-"+k.replace(/_/g,"-"),W.themeParams[k])});
root.style.setProperty("--tg-color-scheme",W.colorScheme);root.style.setProperty("--tg-text-font-size","15px");
document.addEventListener("DOMContentLoaded",function(){document.body.style.margin="0";document.body.style.background="var(--tg-theme-bg-color)";height();new ResizeObserver(height).observe(document.body)});
document.addEventListener("click",height,true);
})();</script>`;

const escapeAttribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

let frameId = 0;
const bubble = (sample: Sample, theme: ThemeName, width: number) => {
  const widget = renderPersonCardWidget(sample.card, {
    header: sample.header,
    language: sample.language,
    requestPrefix: "w1:PreviewCard1:",
    fits: (html) => deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length <= 4000,
  });
  if (widget === null) {
    return `<div class="bubble ${theme}" style="width:${width}px"><p class="none">Not a widget: the Rich Message goes instead.</p></div>`;
  }
  const questions = sample.card.kind === "quiz" ? sample.card.questions.length : 0;
  const doc =
    '<!doctype html><meta charset="utf-8">' +
    shim({
      theme,
      chatData: sample.chatData ?? null,
      failing: sample.failing === true,
      questions,
    }) +
    widget.html;
  frameId += 1;
  const id = `w${frameId}`;
  return (
    `<div class="bubble ${theme}" style="width:${width}px">` +
    `<iframe id="${id}" srcdoc="${escapeAttribute(doc)}" style="height:120px"></iframe>` +
    `<span class="time">12:34</span></div>`
  );
};

const sizeLine = (sample: Sample) => {
  const widget = renderPersonCardWidget(sample.card, {
    header: sample.header,
    language: sample.language,
    requestPrefix: "w1:PreviewCard1:",
  });
  if (widget === null) return "not a widget";
  const bytes = Buffer.byteLength(widget.html, "utf8");
  const zlib = deflateSync(Buffer.from(widget.html, "utf8"), { level: 9 }).length;
  return `${bytes} bytes · ${zlib} zlib bytes of 4096`;
};

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Uno cards as Telegram widgets</title>
<style>
body{margin:0;padding:24px;font:14px/1.4 -apple-system,system-ui,sans-serif;background:#e9ebee;color:#222}
h1{font-size:20px;margin:0 0 4px}
.lead{margin:0 0 24px;color:#555;max-width:900px}
section{margin:0 0 36px}
h2{font-size:15px;margin:0 0 2px}
.size{margin:0 0 10px;color:#777;font-size:12px}
.row{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.chat{padding:16px;border-radius:14px}
.chat.light{background:#c8d9b9}
.chat.dark{background:#0e1621}
.label{font-size:11px;color:#666;margin:0 0 6px}
.chat.dark .label{color:#8899aa}
.bubble{position:relative;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.18)}
.bubble.light{background:#fff}
.bubble.dark{background:#212d3b}
.bubble iframe{display:block;width:100%;border:0;max-height:600px}
.time{position:absolute;right:8px;bottom:4px;font-size:11px;color:#8e8e93;pointer-events:none}
.dark .time{color:#7d8b99}
.none{padding:16px;margin:0;color:#888}
</style></head><body>
<h1>show_card → Telegram widget (Bot API 10.4)</h1>
<p class="lead">Each card in a 320-px and a 400-px bubble, light and dark. Taps work: the shim answers like our bot after 300 ms and updates chat_data. Heights over 600 px are clipped, as in Telegram. This is a browser, not Telegram's QuickJS sandbox: fonts and some CSS may differ there.</p>
${SAMPLES.map(
  (
    sample,
  ) => `<section><h2>${sample.name}</h2><p class="size">${sizeLine(sample)}</p><div class="row">
${(["light", "dark"] as const)
  .map(
    (theme) =>
      `<div class="chat ${theme}"><p class="label">${theme}</p><div class="row">${bubble(sample, theme, 320)}${bubble(sample, theme, 400)}</div></div>`,
  )
  .join("")}
</div></section>`,
).join("\n")}
<script>
window.addEventListener("message",function(e){var d=e.data;if(!d||!d.id||typeof d.widgetHeight!=="number")return;var f=document.getElementById(d.id);if(f)f.style.height=Math.min(600,Math.max(50,d.widgetHeight))+"px"});
</script>
</body></html>`;

const output = process.argv[2] ?? "/tmp/uno-card-widgets/preview.html";
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, page);
console.log(`wrote ${output}`);
