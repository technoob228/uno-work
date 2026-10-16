/**
 * Pult logic without React: time words, task groups, "where am I needed", and the
 * dispatcher — one quick question across every chat ("does Spark need help?",
 * a screenshot "redo this button" → the right chat). Ported from the Pult 3.0 kit.
 */
import type {
  PultAlert,
  PultArtifact,
  PultChat,
  PultChatState,
  PultData,
  PultRelease,
  PultTask,
  PultTaskStatus,
  PultWish,
} from "./pult.types";

/* ───────── Time ───────── */

export function plural(n: number, one: string, few: string, many: string): string {
  const k = Math.abs(n) % 100;
  const k1 = k % 10;
  if (k > 10 && k < 20) return many;
  if (k1 > 1 && k1 < 5) return few;
  if (k1 === 1) return one;
  return many;
}

/** "5 мин назад", "через 2 ч", "3 дня назад". */
export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const d = Math.round((Date.parse(iso) - now) / 60000);
  const a = Math.abs(d);
  if (a < 1) return "сейчас";
  let s: string;
  if (a < 60) s = `${a} мин`;
  else if (a < 60 * 24) s = `${Math.round(a / 60)} ч`;
  else {
    const dd = Math.round(a / 1440);
    s = `${dd} ${plural(dd, "день", "дня", "дней")}`;
  }
  return d < 0 ? `${s} назад` : `через ${s}`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** "сегодня 18:00", "завтра 12:00", "18 окт. 00:00" — in the owner's own time zone. */
export function dayTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const dayOf = (t: number) => {
    const d = new Date(t);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  };
  const diff = dayOf(Date.parse(iso)) - dayOf(now);
  if (diff === 0) return `сегодня ${clock(iso)}`;
  if (diff === 1) return `завтра ${clock(iso)}`;
  if (diff === -1) return `вчера ${clock(iso)}`;
  return `${new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${clock(iso)}`;
}

/* ───────── Words ───────── */

export type PultTone = "amber" | "red" | "blue" | "violet" | "grey" | "green";

export const TASK_STATUS: Record<PultTaskStatus, { readonly label: string; readonly tone: PultTone }> = {
  needs_you: { label: "Нужен ты", tone: "amber" },
  blocked: { label: "Стоит", tone: "red" },
  doing: { label: "В работе", tone: "blue" },
  review: { label: "На проверке", tone: "violet" },
  paused: { label: "На паузе", tone: "grey" },
  todo: { label: "В очереди", tone: "grey" },
  idea: { label: "Идея", tone: "grey" },
  done: { label: "Готово", tone: "green" },
  stopped: { label: "Остановлено", tone: "grey" },
};

export const CHAT_STATE: Record<PultChatState, { readonly label: string; readonly tone: PultTone }> = {
  working: { label: "работает", tone: "green" },
  needs_you: { label: "ждёт тебя", tone: "amber" },
  idle: { label: "закончил ход", tone: "grey" },
  quiet: { label: "молчит", tone: "grey" },
  paused_limit: { label: "встал на лимите", tone: "red" },
  dead: { label: "упал", tone: "red" },
  sleeping: { label: "спит", tone: "grey" },
};

/** Minutes of the owner each kind of request takes (decide is a tap, do is a trip to an admin page). */
export const NEED_MINUTES = { decide: 1, do: 3, look: 4 } as const;

/** Short machine word for a row: "Mac", "uno-work", "uno-product". */
export function machineWord(name: string | undefined): string {
  if (!name) return "";
  return name.replace(/^облако\s+/, "");
}

/* ───────── Board ───────── */

export interface PultIndex {
  readonly data: PultData;
  readonly now: number;
  readonly task: (id: string | null | undefined) => PultTask | undefined;
  readonly chat: (id: string | null | undefined) => PultChat | undefined;
  readonly machineName: (id: string | undefined) => string;
  readonly subLabel: (id: string | undefined) => string;
}

export function indexPult(data: PultData): PultIndex {
  const tasks = new Map(data.tasks.map((t) => [t.id, t]));
  const chats = new Map(data.chats.map((c) => [c.id, c]));
  const machines = new Map(data.machines.map((m) => [m.id, m]));
  const subs = new Map(data.subscriptions.map((s) => [s.id, s]));
  return {
    data,
    now: Date.parse(data.NOW),
    task: (id) => (id ? tasks.get(id) : undefined),
    chat: (id) => (id ? chats.get(id) : undefined),
    machineName: (id) => (id ? (machines.get(id)?.name ?? id) : ""),
    subLabel: (id) => (id ? (subs.get(id)?.label ?? id) : ""),
  };
}

export const ownerChatId = (t: PultTask): string | null => t.owner ?? t.chats[0] ?? null;

export const hasOpenNeed = (t: PultTask): boolean =>
  !!t.needs && (t.status === "needs_you" || t.status === "paused" || t.status === "blocked");

/** Everything that waits for the owner, the most urgent first (manual order = rank). */
export function openNeeds(tasks: ReadonlyArray<PultTask>): PultTask[] {
  return tasks.filter(hasOpenNeed).toSorted((a, b) => a.rank - b.rank);
}

export function ownerMinutes(tasks: ReadonlyArray<PultTask>): number {
  return openNeeds(tasks).reduce((sum, t) => sum + (t.needs ? NEED_MINUTES[t.needs.kind] : 2), 0);
}

export type PultGroupId = "blocked" | "doing" | "review" | "later" | "done";

export interface PultGroup {
  readonly id: PultGroupId;
  readonly label: string;
  readonly tasks: PultTask[];
  /** Folded by default: the glance shows only what moves. */
  readonly folded: boolean;
}

const GROUP_OF: Record<PultTaskStatus, PultGroupId> = {
  needs_you: "doing",
  blocked: "blocked",
  doing: "doing",
  review: "review",
  paused: "later",
  todo: "later",
  idea: "later",
  done: "done",
  stopped: "later",
};

/**
 * Board groups under "Нужен ты": Стоит → В работе → На проверке, then folded
 * "Позже" and "Готово". A task that waits for the owner lives only in "Нужен ты".
 */
export function groupTasks(tasks: ReadonlyArray<PultTask>): PultGroup[] {
  const by: Record<PultGroupId, PultTask[]> = { blocked: [], doing: [], review: [], later: [], done: [] };
  for (const t of tasks.toSorted((a, b) => a.rank - b.rank)) {
    // A stuck task stays visible as stuck even when it also asks the owner something.
    if (hasOpenNeed(t) && t.status !== "blocked") continue;
    by[GROUP_OF[t.status]].push(t);
  }
  const groups: PultGroup[] = [
    { id: "blocked", label: "Стоит", tasks: by.blocked, folded: false },
    { id: "doing", label: "В работе", tasks: by.doing, folded: false },
    { id: "review", label: "На проверке", tasks: by.review, folded: false },
    { id: "later", label: "Позже", tasks: by.later, folded: true },
    { id: "done", label: "Готово", tasks: by.done, folded: true },
  ];
  return groups.filter((g) => g.tasks.length > 0);
}

/**
 * The right side of a task row: how much is left (short), and where it runs —
 * or, when the chat is not fine, that instead ("молчит 9 ч", "на лимите").
 */
export function rowSide(t: PultTask, ix: PultIndex): { readonly left: string; readonly where: string; readonly alarm: boolean } {
  const c = ix.chat(ownerChatId(t));
  const etaLeft = t.eta?.left?.replace(/ работы$/, "") ?? "";
  const left = etaLeft && etaLeft.length <= 9 ? etaLeft : `${t.progress}%`;
  if (!c) return { left, where: "никто не делает", alarm: true };
  if (c.state === "quiet") return { left, where: `молчит ${relTime(c.lastAt, ix.now).replace(" назад", "")}`, alarm: true };
  if (c.state === "paused_limit") return { left, where: "на лимите", alarm: true };
  if (c.state === "dead") return { left, where: "упал", alarm: true };
  if (c.state === "sleeping") return { left, where: "спит", alarm: false };
  return { left, where: machineWord(ix.machineName(c.machine)), alarm: false };
}

/** What is on fire outside the tasks: a subscription running out, an alert that needs the owner. */
export function hotItems(data: PultData): ReadonlyArray<{ readonly text: string; readonly view: PultView }> {
  const out: Array<{ text: string; view: PultView }> = [];
  for (const s of data.subscriptions) {
    if (s.state !== "ok") out.push({ text: `лимит ${s.label.split(" · ").at(-1)}`, view: "limits" });
  }
  const alerts = data.alerts.filter((a) => a.needYou).length;
  if (alerts) out.push({ text: `${alerts} ${plural(alerts, "алерт", "алерта", "алертов")}`, view: "alerts" });
  const lost = data.wishes.filter((w) => w.where === "lost").length;
  if (lost) out.push({ text: `${lost} ${plural(lost, "просьба потерялась", "просьбы потерялись", "просьб потерялось")}`, view: "wishes" });
  return out;
}

/** One word "who/where" for a row: the machine of the chat doing it, or "никто". */
export function whereWord(t: PultTask, ix: PultIndex): string {
  const c = ix.chat(ownerChatId(t));
  if (!c) return "никто";
  return machineWord(ix.machineName(c.machine));
}

/** The glance line: "Ты нужен в 6 местах · ≈ 14 мин" or "Ты никому не нужен — всё идёт". */
export function glanceLine(tasks: ReadonlyArray<PultTask>): { readonly count: number; readonly minutes: number; readonly text: string } {
  const n = openNeeds(tasks).length;
  const minutes = ownerMinutes(tasks);
  if (n === 0) return { count: 0, minutes: 0, text: "Ты сейчас не нужен — всё идёт" };
  return { count: n, minutes, text: `Ты нужен в ${n} ${plural(n, "месте", "местах", "местах")} · ≈ ${minutes} мин` };
}

/** What the task still has to do, not done yet (agent's and owner's). */
export function leftActions(t: PultTask): ReadonlyArray<{ readonly text: string; readonly who: "agent" | "misha" }> {
  return (t.actions ?? []).filter((a) => !a.done);
}

/** Artifacts the owner opens (a link or a file), password ones first. */
export function openableArtifacts(t: PultTask): PultArtifact[] {
  return (t.artifacts ?? [])
    .filter((a) => a.url || a.path)
    .toSorted((a, b) => (b.password ? 1 : 0) - (a.password ? 1 : 0));
}

/* ───────── Dispatcher ───────── */

export type PultCard =
  | { readonly type: "task"; readonly task: string }
  | { readonly type: "need"; readonly task: string }
  | {
      readonly type: "route";
      readonly task: string;
      readonly chat: string | null;
      readonly asleep: boolean;
      readonly files: ReadonlyArray<string>;
    }
  | { readonly type: "chat"; readonly chat: string }
  | { readonly type: "release"; readonly release: PultRelease }
  | { readonly type: "artifact"; readonly task: string; readonly artifact: PultArtifact }
  | { readonly type: "wish"; readonly wish: PultWish }
  | { readonly type: "alert"; readonly alert: PultAlert }
  | { readonly type: "sub"; readonly sub: string }
  | { readonly type: "broadcast"; readonly text: string; readonly chats: ReadonlyArray<string> };

export type PultAct =
  | { readonly type: "broadcast"; readonly text: string; readonly chats: ReadonlyArray<string> }
  | { readonly type: "send"; readonly chat: string; readonly task: string; readonly text: string; readonly files: ReadonlyArray<string> }
  | { readonly type: "files-only"; readonly task: string; readonly files: ReadonlyArray<string> }
  | { readonly type: "route-pick"; readonly text: string }
  | { readonly type: "open-chat"; readonly chat: string }
  | { readonly type: "open-task"; readonly task: string }
  | { readonly type: "move"; readonly chat: string; readonly to: string }
  | { readonly type: "new-task"; readonly title: string }
  | { readonly type: "ask"; readonly text: string }
  | { readonly type: "view"; readonly view: PultView };

export interface PultAnswer {
  readonly intent: string;
  /** Short answer, `**bold**` allowed. */
  readonly text: string;
  readonly cards: ReadonlyArray<PultCard>;
  readonly actions: ReadonlyArray<{ readonly label: string; readonly primary?: boolean; readonly act: PultAct }>;
}

export type PultView = "board" | "releases" | "wishes" | "limits" | "alerts" | "decisions";

const ENTITIES: ReadonlyArray<{ readonly re: RegExp; readonly task: string; readonly name: string }> = [
  { re: /спарк|spark/i, task: "T33", name: "Spark" },
  { re: /\bkv\b|\bкв\b|хакатон/i, task: "T07", name: "KV" },
  { re: /биллинг|billing|plans|usage|тариф/i, task: "T30", name: "Биллинг" },
  { re: /пут[ьиея]|пробник|карт[аеуы]/i, task: "T06", name: "путь клиента" },
  { re: /nl-?2|нод[аеуы]?\b|hector|хектор/i, task: "T21", name: "nl-2" },
  { re: /seo|сео|лендинг|страниц|вики/i, task: "T29", name: "SEO" },
  { re: /сайдбар|sidebar/i, task: "T16", name: "сайдбар" },
  { re: /uno work|ворк|0\.0\.13/i, task: "T15", name: "Uno Work" },
  { re: /модел|обучен/i, task: "T35", name: "модель" },
  { re: /движ|vmm|sel4/i, task: "T34", name: "движок ВМ" },
  { re: /dax|дакс|замер|сша/i, task: "T05", name: "Dax" },
  { re: /hostkey|хосткей|баланс|пополн/i, task: "T10", name: "Hostkey" },
  { re: /репо|github|гитхаб/i, task: "T11", name: "репо" },
  { re: /почт|zoho|hello@/i, task: "T24", name: "почта" },
  { re: /network|exit ?ip|сеть/i, task: "T14", name: "Network" },
  { re: /рассылк|offer|напоминан/i, task: "T09", name: "рассылка" },
  { re: /пульт/i, task: "T01", name: "Пульт" },
  { re: /онбординг/i, task: "T06", name: "онбординг" },
];

const ASLEEP: ReadonlyArray<PultChatState> = ["sleeping", "paused_limit", "quiet", "dead"];

/** Frequent questions of the owner, as chips under the dispatcher field. */
export const DISPATCH_SUGGEST: ReadonlyArray<string> = [
  "Я где-то нужен?",
  "Нужна ли помощь Спаркам?",
  "Что в проде?",
  "Пароль от пути клиента",
  "Что я просил и не доехало?",
  "Пинг всем: статус одной строкой",
];

export function dispatch(input: string, attachments: number, ix: PultIndex): PultAnswer {
  const q = input.trim();
  const ql = q.toLowerCase();
  const seen = new Set<string>();
  const ents = ENTITIES.filter((e) => e.re.test(q) && !seen.has(e.task) && !!seen.add(e.task));
  const t0 = ents[0] ? ix.task(ents[0].task) : undefined;
  const { data } = ix;

  // 1. One text to every live chat ("газ всем", "пинг всем").
  if (/(пинг|газ|напиши|скажи|передай)\s+всем|всем чатам|^всем[:,]/i.test(ql)) {
    const text =
      q.replace(/^(пинг|газ|напиши|скажи|передай)\s+всем[:,]?\s*/i, "").replace(/^всем( чатам)?[:,]?\s*/i, "") ||
      "Как дела? Одной строкой: что сделано, что дальше, нужен ли я.";
    const targets = data.chats.filter((c) => ["working", "idle", "needs_you", "quiet"].includes(c.state)).map((c) => c.id);
    return {
      intent: "broadcast",
      text: `Отправлю в **${targets.length} ${plural(targets.length, "живой чат", "живых чата", "живых чатов")}**. Спящие и вставшие на лимите не трогаю.`,
      cards: [{ type: "broadcast", text, chats: targets }],
      actions: [{ label: `Отправить в ${targets.length}`, primary: true, act: { type: "broadcast", text, chats: targets } }],
    };
  }

  // 2. Feedback (a screenshot, "redo this button") → the chat that owns it.
  if (attachments > 0 || /(переделать|переделай|поправ|кнопк|экран|не нравит|убери|уродс|криво|сломал)/i.test(ql)) {
    const t =
      t0 ??
      data.tasks.find((x) => x.title.toLowerCase().split(/\s+/).some((w) => w.length > 4 && ql.includes(w.slice(0, 5))));
    if (!t) {
      return {
        intent: "feedback-unknown",
        text: "Не понял, к какой задаче это. Выбери чат — передам туда.",
        cards: [],
        actions: [
          { label: "Выбрать чат", primary: true, act: { type: "route-pick", text: q } },
          { label: "Новая задача", act: { type: "new-task", title: q } },
        ],
      };
    }
    const chatId = ownerChatId(t);
    const c = ix.chat(chatId);
    const asleep = !!c && ASLEEP.includes(c.state);
    const files = Array.from({ length: attachments }, (_, i) => `feedback/${t.id.toLowerCase()}-${String(i + 1).padStart(2, "0")}.png`);
    return {
      intent: "feedback",
      text: `Это про **${t.title}**. ${c ? `Передам в чат «${c.title}»${asleep ? " — он спит, разбужу" : ""}.` : "Исполнителя нет — заведу задачу."}${attachments ? " Скрин положу в файлы задачи." : ""}`,
      cards: [{ type: "route", task: t.id, chat: chatId, asleep, files }],
      actions: chatId
        ? [
            { label: asleep ? "Разбудить и отправить" : "Отправить", primary: true, act: { type: "send", chat: chatId, task: t.id, text: q, files } },
            { label: "Другой чат", act: { type: "route-pick", text: q } },
          ]
        : [{ label: "Новая задача", primary: true, act: { type: "new-task", title: q } }],
    };
  }

  // 3. "What is this alert?"
  if (/(что это|кто это|что значит|алерт|тревог)/i.test(ql) && ents.length === 0) {
    const need = data.alerts.filter((a) => a.needYou).length;
    return {
      intent: "alerts",
      text: `За сутки ${data.alerts.length} ${plural(data.alerts.length, "алерт", "алерта", "алертов")}. Тебе нужен **${need}** — счёт Hostkey. Остальное ложное или уже разобрано.`,
      cards: data.alerts.slice(0, 3).map((alert) => ({ type: "alert", alert })),
      actions: [{ label: "Все алерты", act: { type: "view", view: "alerts" } }],
    };
  }

  // 4. "Am I needed?" — for one thing or everywhere.
  if (/(нужн|помощ|помоч|я где|от меня|ждут меня|жд[её]т меня|блок|стоит|застрял)/i.test(ql)) {
    if (t0 && ents[0]) {
      const name = ents[0].name;
      const chatId = ownerChatId(t0);
      if (hasOpenNeed(t0) && t0.needs) {
        return {
          intent: "need-one",
          text: `**Да.** ${name} ждёт тебя: «${t0.needs.title.replace(/\?$/, "")}».`,
          cards: [{ type: "need", task: t0.id }],
          actions: chatId ? [{ label: "Открыть чат", act: { type: "open-chat", chat: chatId } }] : [],
        };
      }
      if (t0.status === "blocked") {
        return {
          intent: "blocked",
          text: `Стоит, но не из-за тебя: ${t0.blocker ?? "ждёт другой чат"}.`,
          cards: [{ type: "task", task: t0.id }],
          actions: chatId ? [{ label: "Открыть чат", act: { type: "open-chat", chat: chatId } }] : [],
        };
      }
      return {
        intent: "fine",
        text: `**Нет**, ${name} справляется сам: ${TASK_STATUS[t0.status].label.toLowerCase()}, ${t0.progress}%${t0.eta?.left ? `, осталось ${t0.eta.left}` : ""}.`,
        cards: [{ type: "task", task: t0.id }],
        actions: [],
      };
    }
    const needs = openNeeds(data.tasks);
    return {
      intent: "needs",
      text: `Да, **${needs.length} ${plural(needs.length, "место", "места", "мест")}** — твоих ≈ ${ownerMinutes(data.tasks)} мин. Они вверху Пульта.`,
      cards: needs.slice(0, 3).map((t) => ({ type: "need", task: t.id })),
      actions: [],
    };
  }

  // 5. Prod / stage.
  if (/(прод|выкат|выкач|стейдж|stage|релиз)/i.test(ql)) {
    const rel = t0 ? data.releases.filter((r) => r.task === t0.id) : data.releases;
    const prod = rel.filter((r) => r.env === "prod" && r.state === "ok").length;
    const rolling = data.releases.find((r) => r.state === "rolling");
    const text = t0
      ? t0.env?.prod
        ? `**${t0.title}** в проде: ${t0.env.prod.what}.`
        : t0.env?.stage
          ? `**${t0.title}** пока на стейдже: ${t0.env.stage.what}.`
          : `**${t0.title}** ещё не выкачено.`
      : `За сутки в проде ${prod}.${rolling ? ` Сейчас катится: ${rolling.what}.` : ""}`;
    return {
      intent: "releases",
      text,
      cards: rel.slice(0, 3).map((release) => ({ type: "release", release })),
      actions: [{ label: "Все выкатки", act: { type: "view", view: "releases" } }],
    };
  }

  // 6. Passwords and links.
  if (/(парол|ссылк|где смотреть|где посмотреть|куда смотреть|покажи)/i.test(ql)) {
    const ts = t0 ? [t0] : data.tasks;
    const arts = ts.flatMap((t) => openableArtifacts(t).map((artifact) => ({ type: "artifact" as const, task: t.id, artifact })));
    return {
      intent: "artifacts",
      text: t0 ? `По **${t0.title}** — ${arts.length} ${plural(arts.length, "ссылка", "ссылки", "ссылок")}. Пароль копируется по клику.` : "Свежие страницы с паролями:",
      cards: arts.slice(0, 3),
      actions: [],
    };
  }

  // 7. Subscription limits.
  if (/(лимит|подписк|токен|расход)/i.test(ql)) {
    const warn = data.subscriptions.find((s) => s.state !== "ok");
    return {
      intent: "limits",
      text: warn ? `Горит одна: **${warn.label}** — ${warn.windows[0]?.forecast ?? ""}. ${warn.advice ?? ""}` : "Все подписки в норме.",
      cards: [],
      actions: [{ label: "Лимиты", act: { type: "view", view: "limits" } }],
    };
  }

  // 8. "What did I ask for and it never arrived?"
  if (/(просил|хотелк|не довел|не доехал|не дошл|потерял|забыл)/i.test(ql)) {
    const lost = data.wishes.filter((w) => w.where === "lost");
    const prod = data.wishes.filter((w) => w.where === "prod").length;
    return {
      intent: "wishes",
      text: `Из ${data.wishes.length} просьб за неделю в проде ${prod}. **Потерялись ${lost.length}**: ${lost.map((w) => w.text).join("; ")}.`,
      cards: lost.map((wish) => ({ type: "wish", wish })),
      actions: [{ label: "Все просьбы", act: { type: "view", view: "wishes" } }],
    };
  }

  // 9. ETA.
  if (/(когда|eta|сколько осталось|успеем|успеваем|скоро)/i.test(ql) && t0) {
    return {
      intent: "eta",
      text: `**${t0.title}**: ${t0.eta?.left ? `осталось ${t0.eta.left}` : "срок не оценён"}${t0.deadline ? `. Дедлайн ${dayTime(t0.deadline, ix.now)}` : ""}.`,
      cards: [{ type: "task", task: t0.id }],
      actions: [],
    };
  }

  // 10. Who does it and where.
  if (/(кто|где работ|на какой|какой агент|какая машин)/i.test(ql) && t0) {
    const c = ix.chat(ownerChatId(t0));
    return {
      intent: "who",
      text: c
        ? `**${t0.title}** делает «${c.title}» — ${c.agent} · ${c.model} на ${ix.machineName(c.machine)} (${ix.subLabel(c.subscription)}).`
        : `У **${t0.title}** нет исполнителя.`,
      cards: c ? [{ type: "chat", chat: c.id }] : [],
      actions: [],
    };
  }

  // 11. Status of one thing.
  if (t0) {
    const c = ix.chat(ownerChatId(t0));
    return {
      intent: "status",
      text: `**${t0.title}** — ${TASK_STATUS[t0.status].label.toLowerCase()}, ${t0.progress}%.${c?.summary ? ` ${c.summary}` : ""}`,
      cards: [{ type: hasOpenNeed(t0) ? "need" : "task", task: t0.id }],
      actions: c ? [{ label: "Открыть чат", act: { type: "open-chat", chat: c.id } }] : [],
    };
  }

  // 12. "So?" — the short summary.
  if (!q || /^(ну\s*)?(что|че|чё|как дела|статус|ну)\??$|что нового|что изменил|как там/i.test(ql)) {
    const working = data.chats.filter((c) => c.state === "working").length;
    const n = openNeeds(data.tasks).length;
    return {
      intent: "summary",
      text: `Работают **${working}** ${plural(working, "чат", "чата", "чатов")}. Ждут тебя **${n}** (≈ ${ownerMinutes(data.tasks)} мин). Стоит 1 — путь клиента, из-за ноды.`,
      cards: [],
      actions: [{ label: "Что от меня?", primary: true, act: { type: "ask", text: "что от меня нужно?" } }],
    };
  }

  // 13. Search, or a new task.
  const words = ql.split(/\s+/).filter((w) => w.length > 3);
  const hits = data.tasks.filter((t) => words.some((w) => `${t.title} ${t.why ?? ""}`.toLowerCase().includes(w.slice(0, 5)))).slice(0, 3);
  if (hits.length) {
    return {
      intent: "search",
      text: "Нашёл похожее:",
      cards: hits.map((t) => ({ type: "task", task: t.id })),
      actions: [{ label: "Новая задача", act: { type: "new-task", title: q } }],
    };
  }
  return {
    intent: "unknown",
    text: "Не нашёл такого. Завести задачу?",
    cards: [],
    actions: [{ label: "Завести задачу", primary: true, act: { type: "new-task", title: q } }],
  };
}

/** Mock agent reply to the owner's message (demo only keeps chats alive). */
export function agentReply(chat: PultChat | undefined, task: PultTask | undefined, text: string): string {
  if (/^\(пульт\)|^[ab]:|выбрал/i.test(text)) return "Принял. Делаю, статус отпишу в Пульт.";
  if (/статус|как дела|что сделано/i.test(text)) return `${chat?.summary ?? "Работаю."}${task?.eta?.left ? ` Осталось ${task.eta.left}.` : ""}`;
  if (/скрин|кнопк|экран|переделай|поправ/i.test(text)) return "Вижу скрин. Поправлю в этом ходе и пришлю до/после.";
  return "Принял, учту в этом ходе.";
}
