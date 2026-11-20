// T51 mockup: two pictures for the review that aren't Work screens — the
// Telegram copy of a colleague's request, and the ladder of levels for
// other people's agents with what guards each step. Plain HTML → JPEG.
// Usage: node demo-e2e/team-collab-cards.mjs <out-dir>
import { join } from "node:path";

import { launch } from "./harness.mjs";

const out = process.argv[2] ?? "demo-e2e/shots/team-collab";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 820 } });
const FONT = `font-family: -apple-system, "Segoe UI", Inter, Roboto, sans-serif;`;

async function render(name, html, height) {
  await page.setViewportSize({ width: 1440, height });
  await page.setContent(`<html><body style="margin:0;${FONT}">${html}</body></html>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 88 });
  console.log(join(out, `${name}.jpg`));
}

const bubble = (inner) =>
  `<div style="background:#fff;border-radius:14px 14px 14px 4px;padding:12px 14px;max-width:520px;box-shadow:0 1px 1px rgba(0,0,0,.12);font-size:15px;line-height:1.45;color:#000">${inner}</div>`;
const tgButtons = (labels) =>
  `<div style="display:flex;gap:4px;margin-top:4px;max-width:548px">${labels
    .map(
      (label) =>
        `<div style="flex:1;text-align:center;background:rgba(0,0,0,.18);color:#fff;border-radius:8px;padding:9px 0;font-size:14px;font-weight:500">${label}</div>`,
    )
    .join("")}</div>`;
const code = (text) =>
  `<code style="font-family:Menlo,monospace;font-size:13.5px;background:#f2f2f2;padding:1px 4px;border-radius:4px">${text}</code>`;

await render(
  "behavior-telegram",
  `<div style="display:flex;gap:48px;padding:40px 56px;background:#f4f4f5;height:100%;box-sizing:border-box">
    <div style="width:600px">
      <div style="font-size:13px;color:#71717a;margin-bottom:10px">Telegram · Uno (@get_uno_bot)</div>
      <div style="background:#9bbf8a url() ;border-radius:16px;padding:22px;background:linear-gradient(160deg,#a8c49a,#7fa77a)">
        ${bubble(`👥 <b>Андрей и его агент</b> предлагают запустить сессию на твоём uno-work, проект landing:<br>${code("Check the Stripe webhook before release: run the checkout test and one test payment")}<br><span style="color:#707579;font-size:13px">Это текст агента Андрея, не Uno. Ждёт 2 ч · подробности в Uno Work</span>`)}
        ${tgButtons(["▶ Start", "✖ Decline"])}
        <div style="height:16px"></div>
        ${bubble(`👥 <b>Андрей</b> (landing):<br>${code("Mobile pricing cards are in the branch mobile-pricing. Have a look when you can, no rush.")}<br><span style="color:#707579;font-size:13px">Ответить — в Uno Work</span>`)}
        <div style="height:16px"></div>
        ${bubble(`🤖 Агент Андрея спросил твоего агента, какие тарифы на странице — <b>ответил сам</b> (уровень «Отвечать на вопросы»).<br><span style="color:#707579;font-size:13px">Раз в день, сводкой · выключить: Настройки проекта → Команда</span>`)}
      </div>
    </div>
    <div style="flex:1;padding-top:28px;font-size:16px;line-height:1.55;color:#18181b">
      <div style="font-size:22px;font-weight:600;margin-bottom:14px">Что дублируется в Telegram</div>
      <div style="margin-bottom:12px"><b>Сразу, с кнопками</b> — то, что ждёт твоего решения: сессия на твоём компьютере, просьба писать в твой чат. Решает компьютер, где запустится сессия; кто нажал первым — тот и решил (как в T50).</div>
      <div style="margin-bottom:12px"><b>Сразу, без кнопок</b> — сообщение от коллеги лично (не от его агента).</div>
      <div style="margin-bottom:12px"><b>Сводкой раз в день</b> — что агенты коллег сделали сами (ответили на вопрос, сессия по уровню «Выполнять задачи»).</div>
      <div style="margin-bottom:12px"><b>Никогда</b> — сами тексты переписки агентов целиком, файлы, ключи.</div>
      <div style="color:#52525b">Текст агента — одной строкой, обрезан, как код: без ссылок и разметки, подписан «текст агента Андрея».</div>
    </div>
  </div>`,
  540,
);

const levels = [
  [
    "Выключено",
    "Агенты коллег не могут достучаться ни до тебя, ни до твоих агентов. Делиться чатами люди могут.",
    "—",
    "#e4e4e7",
  ],
  [
    "Через меня",
    "Сообщения и просьбы агентов коллег приходят во Входящие. Ничего не запускается без кнопки Start.",
    "по умолчанию",
    "#c7d2fe",
  ],
  [
    "Отвечать на вопросы",
    "Твой агент сам отвечает на вопросы агентов коллег по этому проекту. Только читает: без правок, без ключей, без отправки файлов.",
    "включает каждый для себя",
    "#a5b4fc",
  ],
  [
    "Выполнять задачи",
    "Агент коллеги сам запускает сессию на твоём компьютере в этом проекте. Без деплоя, git push и ключей; ты видишь и можешь остановить.",
    "не в MVP (решение)",
    "#818cf8",
  ],
];
await render(
  "behavior-levels",
  `<div style="padding:40px 56px;background:#fafafa;height:100%;box-sizing:border-box;color:#18181b">
    <div style="font-size:24px;font-weight:600;margin-bottom:6px">Агенты коллег и твои: четыре уровня</div>
    <div style="font-size:15px;color:#52525b;margin-bottom:22px">Ставит каждый для своих компьютеров, в каждом проекте; можно отдельно для человека. Что бы ни стояло, всегда действует защита справа.</div>
    <div style="display:flex;gap:28px">
      <div style="flex:1.35;display:flex;flex-direction:column;gap:10px">
        ${levels
          .map(
            (
              [name, line, tag, color],
              index,
            ) => `<div style="display:flex;gap:14px;align-items:stretch">
              <div style="width:${40 + index * 18}px;background:${color};border-radius:8px"></div>
              <div style="flex:1;background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:12px 14px">
                <div style="display:flex;justify-content:space-between;font-weight:600;font-size:16px">${name}<span style="font-weight:400;font-size:12px;color:#6366f1;border:1px solid #c7d2fe;border-radius:99px;padding:1px 8px">${tag}</span></div>
                <div style="font-size:14px;color:#3f3f46;margin-top:4px;line-height:1.45">${line}</div>
              </div></div>`,
          )
          .join("")}
      </div>
      <div style="flex:1;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:18px 20px;font-size:14.5px;line-height:1.5">
        <div style="font-weight:600;font-size:16px;margin-bottom:8px">Защита на любом уровне</div>
        <div>• Текст от коллеги или его агента — <b>чужой текст</b> (T49): чат помечается, инструменты Uno Work спрашивают тебя.</div>
        <div>• Сессия от коллеги — <b>ограждение T50</b>: нельзя ssh, деплой, git push, sudo, установки, ключи и .env.</div>
        <div>• Только папка этого проекта; другие проекты агент коллеги не видит.</div>
        <div>• Ключи и .env не уходят никогда — ни в общий чат, ни в ответ агенту.</div>
        <div>• Не больше 2 сессий от коллег сразу, 20 запросов в час; ответ на ответ — не больше 6 кругов, потом зовёт людей.</div>
        <div>• Убрал человека из проекта — его доступ к чатам и запросы гаснут сразу.</div>
        <div>• Всё пишется в журнал «Что делали их агенты».</div>
      </div>
    </div>
  </div>`,
  500,
);

await browser.close();
