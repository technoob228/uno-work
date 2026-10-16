/**
 * Pult (task board) mock data, ported 1:1 from the Pult 3.0 prototypes
 * (reports/day_2026-10-16/pult3/shared/data.js): Misha's tasks, chats, computers,
 * subscriptions, releases, decisions, wishes and alerts as of 16.10 ~00:20 UTC.
 * Passwords, numbers and some texts are made up. Demo only.
 */
/* eslint-disable */
import type { PultData } from "../pult/pult.types";

export const PULT_DEMO_DATA: PultData = (() => {
  const NOW = "2026-10-16T00:20:00Z";
  const m = (min: number) => new Date(Date.parse(NOW) - min * 60000).toISOString(); // «min минут назад»
  const fwd = (min: number) => new Date(Date.parse(NOW) + min * 60000).toISOString(); // «через min минут»

  /* ───────── Машины ───────── */
  const machines = [
    { id: "mac", name: "Mac", on: "на Mac", kind: "Ноутбук Миши", subscription: "shubaduba", online: true,
      cpu: 55, ram: 89, diskFreeGb: 7, diskTotalGb: 460, keeper: false,
      warn: "Диск почти полон: 7 ГБ свободно. Сборки лучше гонять в облаке.",
      note: "Прод, ключи, выкатки. Сторожа Пульта нет — чаты Mac не оживают сами." },
    { id: "uno-work", name: "облако uno-work", on: "на облаке uno-work", kind: "Облачный компьютер · 8 ядер · 16 ГБ", subscription: "shubaduba", online: true,
      cpu: 22, ram: 41, diskFreeGb: 31, diskTotalGb: 80, keeper: true,
      note: "Движок ВМ, Spark, лендинги." },
    { id: "uno-product", name: "облако uno-product", on: "на облаке uno-product", kind: "Облачный компьютер · 8 ядер · 16 ГБ", subscription: "torgashin", online: true,
      cpu: 38, ram: 37, diskFreeGb: 8.7, diskTotalGb: 40, keeper: true,
      warn: "Диск 8,7 ГБ свободно — go-кэш и worktree забивают его за сутки.",
      note: "Основная работа: Пульт, Work, консоль, KV, путь клиента." },
  ];

  /* ───────── Подписки и лимиты ───────── */
  const subscriptions = [
    { id: "shubaduba", vendor: "Claude", plan: "Max 20x", label: "Claude Max · shubaduba", machines: ["mac", "uno-work"],
      windows: [
        { name: "5 часов", pct: 41, resetAt: fwd(230), forecast: "При нынешнем темпе кончится ≈ в 03:10 UTC — за 1 ч 20 мин до сброса" },
        { name: "Неделя", pct: 24, resetAt: "2026-10-22T11:00:00Z", forecast: "Хватает с запасом" },
      ],
      burn: "6 чатов, ≈ 9% лимита в час", state: "warn",
      advice: "Перенеси «Лендинги, вики, SEO» на uno-product — там свободно 88%." },
    { id: "torgashin", vendor: "Claude", plan: "Max 20x", label: "Claude Max · email.torgashin", machines: ["uno-product"],
      windows: [
        { name: "5 часов", pct: 12, resetAt: fwd(170), forecast: "Хватает с запасом" },
        { name: "Неделя", pct: 7, resetAt: "2026-10-22T09:00:00Z", forecast: "Хватает с запасом" },
      ],
      burn: "5 чатов, ≈ 3% лимита в час", state: "ok", advice: "Основную работу — сюда (решение 15.10)." },
    { id: "chatgpt", vendor: "ChatGPT", plan: "Plus", label: "ChatGPT Plus · Codex", machines: ["mac", "uno-work", "uno-product"],
      windows: [{ name: "5 часов", pct: 18, resetAt: fwd(95), forecast: "Хватает" }], burn: "1 чат", state: "ok" },
    { id: "uno-ai", vendor: "Uno", plan: "Безлимит", label: "Uno AI · своя модель", machines: ["mac", "uno-work", "uno-product"],
      windows: [], burn: "Сводки Пульта и диспетчер", state: "ok", note: "Без лимита: сводки и диспетчер идут сюда." },
    { id: "openrouter", vendor: "OpenRouter", plan: "Ключ API", label: "OpenRouter · ключ", machines: ["uno-product"],
      windows: [{ name: "Месяц", pct: 25, resetAt: "2026-11-01T00:00:00Z", forecast: "$12,40 из $50" }], burn: "GLM для бенчей", state: "ok" },
  ];

  /* ───────── Чаты (агенты) ───────── */
  // state: working — идёт ход · needs_you — ждёт тебя · idle — ход закончен · quiet — молчит дольше 2 ч ·
  //        paused_limit — встал на лимите · dead — процесс упал · sleeping — спит (dormant)
  const chats = [
    { id: "ch-kv", title: "KV на хакатон", machine: "uno-product", subscription: "torgashin",
      agent: "Claude Code", model: "Opus 5.5", state: "needs_you", lastAt: m(38), context: 46, tasks: ["T07"],
      project: "fishcode", branch: "feat/kv-service",
      summary: "KV в проде за флагом. Ждёт список участников или «открыть всем по промокоду».",
      messages: [
        { who: "misha", at: m(290), text: "Хакатон в субботу. Успеваем дать участникам KV? Только честно." },
        { who: "agent", at: m(286), text: "Успеваем. Бэкенд и консоль уже в проде за флагом `KV_SERVICE=85` — видит только твой аккаунт. Осталось: включить участникам и проверить лимиты.", tools: ["Прочитал 6 файлов", "Проверил прод: флаг включён для акк. 85"] },
        { who: "agent", at: m(240), text: "Прогнал сценарий участника на стейдже: создать хранилище → записать 1 000 ключей → прочитать из бота. Всё зелёное, 182 теста ✓.", tools: ["Запустил тесты — 182 ✓", "Сценарий на стейдже — 4 шага ✓"] },
        { who: "agent", at: m(62), text: "Есть развилка, нужен ты. Список участников организаторы обещали, но его нет. Варианты:\n\n**A. Открыть KV всем по промокоду `HACK17`** (рекомендую) — участник вводит код, KV включается. Не зависим от списка.\n**B. Ждать список до 16.10 18:00 UTC** — включу по почтам. Если список не придёт, участники останутся без KV.", options: ["A: Всем по промокоду", "B: Ждём список до 18:00"] },
        { who: "agent", at: m(38), text: "Пока жду ответ, готовлю промокод (обратимо, никому не виден). Если до 16.10 12:00 UTC ответа не будет — включаю A." },
      ] },
    { id: "ch-path", title: "Весь путь как клиент", machine: "uno-product", subscription: "torgashin",
      agent: "Claude Code", model: "Opus 5.5", state: "working", lastAt: m(4), context: 71, tasks: ["T06"],
      project: "qa-runner", branch: "misha-path-1015",
      summary: "Прогоняет путь лендинг → карта → сервер. Бесплатное работает, с сервером — нет.",
      messages: [
        { who: "misha", at: m(400), text: "пройди весь путь как клиент от лендинга до сервера, на каждом шаге скрин. где врём — красным" },
        { who: "agent", at: m(330), text: "Прошёл 3 флоу по 14 шагов. Итог: **бесплатное работает, с сервером — нет.** Проект с сервером ни разу не дошёл до адреса.", tools: ["Открыл браузер: getuno.xyz", "Сделал 42 скриншота", "Записал отчёт"], attachments: [{ kind: "screen", title: "Шаг 9 · Deploy failed", tone: "red" }] },
        { who: "agent", at: m(180), text: "Отчёт со скринами: misha-path-1015.uno4.me (пароль в карточке задачи). Новый путь катить нельзя, пока не починены 4 разрыва." },
        { who: "agent", at: m(70), text: "Вопрос: шаг карты в проде проверить твоей картой (списание $0, сразу возврат) или QA-картой Stripe? QA-карта в проде не работает — только твоя.", options: ["A: Моей картой, $0", "B: Только на стейдже"] },
        { who: "agent", at: m(4), text: "Перепроверяю 4 разрыва на свежих коммитах fix/path-deploy. Итог ≈ 00:50 UTC.", tools: ["Сборка консоли 071ef50", "Прогон флоу 2 — шаг 6 из 14"] },
      ] },
    { id: "ch-onb", title: "Онбординг: 3 версии", machine: "mac", subscription: "shubaduba",
      agent: "Claude Code", model: "Opus 5.5", state: "working", lastAt: m(11), context: 58, tasks: ["T12", "T06"],
      project: "uno-console", branch: "fix/path-deploy", oldName: "Mac · uno-project · 9dc9",
      summary: "Чинит 4 разрыва пути клиента в консоли; патч кнопки «Add a card — $0 today».",
      messages: [
        { who: "agent", at: m(140), text: "Принял находки «Весь путь как клиент». Чиню по порядку: адрес сервера, «See plans» для бота, 3 экрана с деньгами, «Not logged in»." },
        { who: "agent", at: m(55), text: "2 из 4 починены в fix/path-deploy (консоль 071ef50, лендинг bdc8b9f). Отдал на перепроверку." },
        { who: "agent", at: m(11), text: "Docker в сервере падает: «failed to create NAT chain DOCKER». Это нода, не консоль — передал в «Выкатки в прод». Пока делаю «Not logged in».", tools: ["Прочитал журнал ноды через ops-exec", "Пост в Пульт → Выкатки"] },
      ] },
    { id: "ch-work", title: "Uno Work: облачные ветки", machine: "uno-product", subscription: "torgashin",
      agent: "Claude Code", model: "Opus 5.5", state: "needs_you", lastAt: m(95), context: 83, tasks: ["T15", "T16", "T17", "T18"],
      project: "uno-work-app", branch: "release/0.0.137",
      summary: "0.0.137 в проде. Ждёт ответ: какой сайдбар по умолчанию.",
      messages: [
        { who: "misha", at: m(320), text: "4 правки: вложения любые, скачать везде, New chat сверху, режимы сайдбара все" },
        { who: "agent", at: m(250), text: "Сделал все 4 в 0.0.137. Скриншоты до/после — misha-work-0137.uno4.me.", tools: ["Сборка 0.0.137", "Тесты — 1 204 ✓", "Скриншоты — 16 шт."], attachments: [{ kind: "screen", title: "Сайдбар · классика", tone: "ok" }, { kind: "screen", title: "Сайдбар · инбокс", tone: "ok" }] },
        { who: "agent", at: m(130), text: "Передал Mac на выкатку: release/0.0.137 @ 0571dba4." },
        { who: "agent", at: m(95), text: "Какой сайдбар по умолчанию у новых людей?\n\n**A. Классика** (рекомендую) — проекты слева всегда, как решили 11.10.\n**B. Инбокс** — чаты по статусам: «Нужен ты», «Работает», «Готово».", options: ["A: Классика", "B: Инбокс"] },
      ] },
    { id: "ch-rel", title: "Выкатки в прод", machine: "mac", subscription: "shubaduba",
      agent: "Claude Code", model: "Opus 5.5", state: "working", lastAt: m(7), context: 64, tasks: ["T21", "T04", "T15"],
      project: "fishcode", branch: "main",
      summary: "Катает консоль 5941f48e (связь нод, выключена). В 01:45 CEST — рестарт агента hector.",
      messages: [
        { who: "agent", at: m(140), text: "Clean exit IP включён всем платным в 22:03 UTC. Канарейка зелёная 2 ч." },
        { who: "agent", at: m(85), text: "Work 0.0.137 в проде, образ 236 (новые машины сразу). Откат — образ 234." },
        { who: "agent", at: m(30), text: "nl-2 закрыта для клиентов до фикса ключа exec в машинах из образов. Рестарт агента hector ≈ 01:45 CEST: только фикс ключа, без trim памяти." },
        { who: "agent", at: m(7), text: "Катаю консоль 5941f48e: связь нод (выключена флагом). Канарейка 10 мин.", tools: ["docker compose build console", "Канарейка: 3 из 10 мин"] },
      ] },
    { id: "ch-spark", title: "Ведущий инженер Spark", machine: "uno-work", subscription: "shubaduba",
      agent: "Claude Code", model: "Opus 5.5", state: "needs_you", lastAt: m(210), context: 77, tasks: ["T33"],
      project: "spark-engine", branch: "main",
      summary: "Общий движок JS/Python на seL4 заработал на хосте. Дальше не пройти без Intel-сервера.",
      messages: [
        { who: "agent", at: m(600), text: "seL4 для всех: общий движок JS/Python заработал на хосте. Дедуп памяти между ботами — 300 ботов в 6 ГБ." },
        { who: "agent", at: m(260), text: "Дальше стоп: нужен сервер на Intel (у Hostkey AMD, а seL4-сборка у нас под VT-x). Без него — недели обходов." },
        { who: "agent", at: m(210), text: "Нужно решение: **арендовать Intel-сервер Hostkey за $189/мес (почасово, можно удалить в любой момент)?** Утром 16.10 подключу и прогоню 300 ботов.", options: ["A: Да, арендуй", "B: Нет, ищи обход"] },
      ] },
    { id: "ch-seo", title: "Лендинги, вики, SEO", machine: "uno-work", subscription: "shubaduba",
      agent: "Claude Code", model: "Opus 5.5", state: "paused_limit", lastAt: m(160), context: 39, tasks: ["T29"],
      project: "content-site", branch: "pages-batch-2",
      summary: "16 из 98 страниц на превью. Встал на лимите shubaduba.",
      messages: [
        { who: "agent", at: m(240), text: "Dax: топ-5 рейтинга рядом с нами — готово. Страница /benchmarks на превью." },
        { who: "agent", at: m(160), text: "Пауза до 23:15 UTC (лимит). Всё закоммичено, 16 из 98 на превью. Следующая пачка — 20 страниц: делать?", options: ["A: Да, следующие 20", "B: Сначала покажи 16"] },
      ] },
    { id: "ch-dax", title: "Замер Dax в США", machine: "uno-work", subscription: "shubaduba",
      agent: "Claude Code", model: "Sonnet 5.5", state: "idle", lastAt: m(150), context: 22, tasks: ["T05"],
      project: "dax", branch: "main",
      summary: "Fast 38,9 с — 2-е место из 21. Адаптер @computesdk/uno — после контракта API.",
      messages: [
        { who: "agent", at: m(150), text: "T05 сделан: Fast 38,9 с — 2-е место из 21. Как в проде — 42,4 с (5-е). Главный резерв — порт 10G." },
      ] },
    { id: "ch-pult", title: "Пульт 3.0: версии", machine: "mac", subscription: "shubaduba",
      agent: "Claude Code", model: "Opus 5.5", state: "working", lastAt: m(1), context: 31, tasks: ["T01"],
      project: "uno-project", branch: "main",
      summary: "Собирает 3 версии нового Пульта на моках.",
      messages: [
        { who: "misha", at: m(40), text: "по поводу пульта я пока не очень рад. сделай несколько хорошо проработанных версий, полный фронтенд с моковыми данными" },
        { who: "agent", at: m(1), text: "Собираю 3 версии: «Штаб», «Внутри Uno Work», «Телефон и диспетчер».", tools: ["Разобрал историю чатов", "Записал моковые данные"] },
      ] },
    { id: "ch-engine", title: "Движок ВМ на seL4", machine: "uno-work", subscription: "shubaduba",
      agent: "Claude Code", model: "Opus 5.5", state: "quiet", lastAt: m(560), context: 88, tasks: ["T34"],
      project: "uno-vmm", branch: "virtio-net",
      summary: "Молчит 9 ч. Последнее: драйвер сети слит в main.",
      messages: [
        { who: "agent", at: m(560), text: "Слил драйвер сети в main. Дальше — блочное устройство. Контекст 88% — скоро попрошу передачу дел." },
      ] },
    { id: "ch-train", title: "Обучение модели Uno", machine: "uno-product", subscription: "torgashin",
      agent: "Claude Code", model: "Opus 5.5", state: "needs_you", lastAt: m(1500), context: 35, tasks: ["T35"],
      project: "model-lab", branch: "main",
      summary: "Обвязка готова. Ждёт «да» на большой прогон $300–600.",
      messages: [
        { who: "agent", at: m(1500), text: "Экзамен из 312 реальных просьб собран. Большой прогон с судьёй Opus — $300–600 за 6–8 ч GPU. Запускать?", options: ["A: Да, до $600", "B: Сначала малый на $50"] },
      ] },
    { id: "ch-billing", title: "Биллинг: вкладки Plans/Usage", machine: "uno-product", subscription: "torgashin",
      agent: "Claude Code", model: "Opus 5.5", state: "sleeping", lastAt: m(3700), context: 52, tasks: ["T30"],
      project: "uno-console", branch: "feat/billing-tabs",
      summary: "Оборвано лимитом 13.10. Экран Plans свёрстан, Usage — нет.",
      messages: [
        { who: "agent", at: m(3720), text: "Plans свёрстан по варианту C: карточки тарифов + чекаут. Скрин ниже.", attachments: [{ kind: "screen", title: "Billing · Plans", tone: "ok" }] },
        { who: "agent", at: m(3700), text: "Упёрлись в недельный лимит. Продолжу с Usage после сброса." },
      ] },
    { id: "ch-codex-qa", title: "QA прода (Codex)", machine: "uno-product", subscription: "chatgpt",
      agent: "Codex", model: "GPT-5.5", state: "idle", lastAt: m(300), context: 40, tasks: ["T32"],
      project: "qa-runner", branch: "main",
      summary: "37 находок, 12 закрыты. Ждёт «всё на стейдж».",
      messages: [
        { who: "agent", at: m(300), text: "Перепрогнал 37 находок: 12 закрыты, 25 открыты. Список по экранам — qa/FINDINGS.md." },
      ] },
    { id: "ch-coord", title: "Координатор", machine: "mac", subscription: "shubaduba",
      agent: "Claude Code", model: "Opus 5.5", state: "idle", lastAt: m(120), context: 67, tasks: ["T10", "T11", "T24"],
      project: "uno-project", branch: "main",
      summary: "Ведёт доску дня и вопросы, где нужен только Миша.",
      messages: [
        { who: "agent", at: m(120), text: "Обновил доску дня. Ждут только тебя: Hostkey (пополнить), 2 репо в getuno, почта hello@." },
      ] },
  ];

  /* ───────── Задачи ───────── */
  // status: doing · needs_you · blocked · review · done · todo · idea · paused
  // needs: что нужно от Миши — kind: decide (выбрать) · do (сделать руками: деньги, доступ, админка) · look (посмотреть и сказать ок)
  const tasks = [
    {
      id: "T07", title: "KV для участников хакатона", priority: "P0", rank: 1, status: "needs_you", progress: 85,
      stream: "Упаковка", why: "Хакатон в субботу 17.10 — даём участникам бесплатное хранилище для ботов.",
      deadline: "2026-10-16T18:00:00Z", eta: { left: "≈ 1 ч работы после ответа", at: fwd(15 * 60) },
      chats: ["ch-kv"], owner: "ch-kv",
      stages: [{ name: "Бэкенд", done: true }, { name: "Консоль", done: true }, { name: "Прод за флагом", done: true }, { name: "Включить участникам", done: false }, { name: "Проверка на хакатоне", done: false }],
      needs: { kind: "decide", title: "Как включить KV участникам?",
        explain: "KV — простое хранилище «ключ → значение»: бот участника хранит в нём данные без своей базы.",
        options: [
          { label: "Всем по промокоду HACK17", hint: "Не зависим от списка организаторов. Код можно отозвать.", recommended: true },
          { label: "Ждать список до 18:00 UTC", hint: "Если список не придёт — участники без KV." },
        ],
        autoAt: "2026-10-16T12:00:00Z", autoText: "Если не ответишь до 12:00 UTC — включу по промокоду", blocks: ["T08"], askedAt: m(62) },
      request: { by: "Миша", at: "2026-10-15T14:10:00Z", text: "Хакатон в субботу. Дать участникам что-то бесплатное и полезное — KV под флагом, если успеваем. Spark к субботе не успеть.",
        wishes: ["Только участникам, не всем клиентам", "Без ручной возни на хакатоне", "Лимиты, чтобы не положили прод"] },
      artifacts: [
        { kind: "site", title: "Рансбук KV и чек-лист хакатона", url: "https://misha-kv-1015.uno4.me/", password: "kite-7406-luna", note: "Что включить, как откатить" },
        { kind: "branch", title: "fishcode · feat/kv-service", url: "https://github.com/getuno/fishcode/tree/feat/kv-service", note: "58e11c25 · в проде за флагом" },
        { kind: "branch", title: "uno-console · feat/kv-console", url: "https://github.com/getuno/uno-console/tree/feat/kv-console", note: "d2a7dca" },
      ],
      docs: ["reports/day_2026-10-15/kv/RUNBOOK.md", "strategy/TRIAL_DESIGN.md"],
      actions: [
        { text: "Флаг KV_SERVICE для акк. 85", done: true, who: "agent" },
        { text: "Промокод HACK17 (скрыт)", done: true, who: "agent" },
        { text: "Решить: промокод или список", done: false, who: "misha" },
        { text: "Включить участникам", done: false, who: "agent" },
        { text: "Пост в чат хакатона с инструкцией", done: false, who: "agent" },
      ],
      env: { prod: { what: "Бэкенд 58e11c25 + консоль за флагом KV_SERVICE=85", at: m(540), rollback: "Снять флаг — 1 команда" }, stage: { what: "Сценарий участника — 4 шага ✓", at: m(240) }, branch: "feat/kv-service" },
      feed: [
        { at: m(38), kind: "status", text: "Готовлю промокод, пока жду ответ" },
        { at: m(62), kind: "question", text: "Список на KV — до 16.10 18:00 UTC? Если нет — что делаем?" },
        { at: m(240), kind: "status", text: "Сценарий участника на стейдже: 4 шага ✓" },
        { at: m(540), kind: "release", text: "В проде за флагом KV_SERVICE=85" },
      ],
    },
    {
      id: "T06", title: "Пробник с картой: путь клиента до сервера", priority: "P0", rank: 2, status: "blocked", progress: 45,
      stream: "Платформа", why: "Карта обязательна, Plus $20 через 3 дня. На это бьёт рассылка — пока путь с сервером не работает.",
      deadline: "2026-10-18T00:00:00Z", eta: { left: "≈ 6 ч работы", at: fwd(8 * 60) },
      chats: ["ch-path", "ch-onb"], owner: "ch-onb",
      stages: [{ name: "Дизайн пробника", done: true }, { name: "Бэкенд", done: true }, { name: "Путь как клиент", done: true }, { name: "Починить 4 разрыва", done: false, now: true }, { name: "Перепроверка", done: false }, { name: "В прод", done: false }],
      blocker: "Docker в сервере клиента падает («failed to create NAT chain») — чинит «Выкатки в прод» на ноде.",
      needs: { kind: "decide", title: "Шаг карты в проде: проверить твоей картой?",
        explain: "Чтобы убедиться, что оплата в проде работает, нужна настоящая карта. Списание $0 — Stripe только проверяет карту.",
        options: [
          { label: "Моей картой, списание $0", hint: "Проверим весь путь в проде за 2 минуты.", recommended: true },
          { label: "Только на стейдже", hint: "В проде шаг карты останется непроверенным." },
        ], autoAt: null, autoText: "Без ответа шаг карты в проде не проверим — путь останется красным", blocks: ["T09"], askedAt: m(70) },
      request: { by: "Миша", at: "2026-10-15T15:00:00Z", text: "Пробник с картой: два пути — Uno Work сразу в Plus (Workspace + отдельный сервер) и свой агент. Агент сам знает биллинг через API/CLI/MCP.",
        wishes: ["Карта обязательна", "$0 сегодня, Plus $20 через 3 дня", "Путь — абсурдно простой"],
        attachments: [{ kind: "screen", title: "Набросок Миши: 2 пути", tone: "ok" }] },
      artifacts: [
        { kind: "site", title: "Путь клиента: бесплатное работает, с сервером — нет", url: "https://misha-path-1015.uno4.me/", password: "mint-2291-ferry", note: "42 скриншота, разрывы красным" },
        { kind: "file", title: "Решения по пробнику (TRIAL_DESIGN)", path: "strategy/TRIAL_DESIGN.md" },
        { kind: "branch", title: "uno-console · fix/path-deploy", url: "https://github.com/getuno/uno-console/tree/fix/path-deploy", note: "071ef50" },
        { kind: "screen", title: "Шаг 9 · Deploy failed", tone: "red" },
      ],
      docs: ["strategy/TRIAL_DESIGN.md", "reports/day_2026-10-15/path/PATH_REPORT.md"],
      actions: [
        { text: "Проект с сервером не доходит до адреса", done: true, who: "agent" },
        { text: "«See plans» для бота продаёт Plus, не Small", done: true, who: "agent" },
        { text: "3 экрана врут о деньгах", done: false, who: "agent" },
        { text: "Пробник отвечает «Not logged in»", done: false, who: "agent" },
        { text: "Docker в сервере: NAT chain", done: false, who: "agent", note: "Выкатки в прод" },
        { text: "Проверить шаг карты в проде", done: false, who: "misha" },
      ],
      env: { prod: { what: "Старый путь (без карты)", at: m(4300) }, stage: { what: "fix/path-deploy: 2 из 4 починены", at: m(55) }, branch: "fix/path-deploy" },
      feed: [
        { at: m(4), kind: "status", text: "Перепроверяю 4 разрыва на свежих коммитах, итог ≈ 00:50 UTC" },
        { at: m(11), kind: "blocked", text: "Docker в сервере падает: «failed to create NAT chain DOCKER»" },
        { at: m(55), kind: "status", text: "2 из 4 починены в fix/path-deploy" },
        { at: m(180), kind: "report", text: "Путь клиента: бесплатное работает, с сервером — нет" },
      ],
    },
    {
      id: "T16", title: "Сайдбар по умолчанию у новых людей", priority: "P1", rank: 3, status: "needs_you", progress: 95,
      stream: "Uno Work", why: "Самая частая жалоба — чаты не сворачиваются. Оба режима готовы в 0.0.137.",
      deadline: null, eta: { left: "≈ 20 мин после ответа", at: null },
      chats: ["ch-work"], owner: "ch-work",
      stages: [{ name: "Два режима", done: true }, { name: "В проде 0.0.137", done: true }, { name: "Выбрать по умолчанию", done: false }],
      needs: { kind: "decide", title: "Какой сайдбар по умолчанию?",
        explain: "Оба режима есть в настройках. Вопрос только в том, что человек видит при первом входе.",
        options: [
          { label: "Классика — проекты слева", hint: "Как решили 11.10. Привычно, проекты всегда на виду.", recommended: true },
          { label: "Инбокс — по статусам", hint: "«Нужен ты / Работает / Готово». Удобно, когда чатов много." },
        ], autoAt: "2026-10-16T15:00:00Z", autoText: "Если не ответишь до 15:00 UTC — оставлю классику", askedAt: m(95) },
      request: { by: "Миша", at: "2026-10-11T21:55:00Z", text: "У сайдбара два режима — классика и инбокс. Переключение галочкой в настройках, не меню в сайдбаре.", wishes: ["Классика — у всех по умолчанию", "Snoozed в статусах"] },
      artifacts: [
        { kind: "site", title: "Work 0.0.137: скриншоты до/после", url: "https://misha-work-0137.uno4.me/", password: "otter-5518-bloom" },
        { kind: "screen", title: "Сайдбар · классика", tone: "ok" },
        { kind: "screen", title: "Сайдбар · инбокс", tone: "ok" },
      ],
      docs: ["agent-memory/misha_sidebar_feedback_2026_10_08.md"],
      actions: [{ text: "Режим «классика»", done: true, who: "agent" }, { text: "Режим «инбокс» со Snoozed", done: true, who: "agent" }, { text: "Выбрать по умолчанию", done: false, who: "misha" }],
      env: { prod: { what: "Work 0.0.137 — оба режима, по умолчанию классика", at: m(85), rollback: "Образ 234" }, stage: null, branch: "release/0.0.137" },
      feed: [{ at: m(95), kind: "question", text: "Какой сайдбар по умолчанию?" }, { at: m(85), kind: "release", text: "0.0.137 в проде" }],
    },
    {
      id: "T33", title: "Spark к продукту", priority: "P1", rank: 4, status: "needs_you", progress: 30,
      stream: "Spark", why: "300 ботов на одном сервере — основа дешёвого тарифа.",
      deadline: null, eta: { left: "≈ 3 дня после сервера", at: null },
      chats: ["ch-spark"], owner: "ch-spark",
      stages: [{ name: "Движок на хосте", done: true }, { name: "Дедуп памяти", done: true }, { name: "Intel-сервер", done: false, now: true }, { name: "300 ботов", done: false }, { name: "Входная дверь", done: false }],
      needs: { kind: "decide", money: "$189/мес", title: "Арендовать Intel-сервер за $189/мес?",
        explain: "Наш движок изоляции (seL4) собран под процессоры Intel. У Hostkey сейчас только AMD — без Intel дальше недели обходов.",
        options: [
          { label: "Да, арендуй почасово", hint: "Можно удалить в любой момент. Утром подключу.", recommended: true },
          { label: "Нет, ищи обход на AMD", hint: "≈ 2 недели работы, без гарантии." },
        ], autoAt: null, autoText: "Деньги — без тебя не решаю", askedAt: m(210) },
      request: { by: "Миша", at: "2026-10-09T10:00:00Z", text: "Spark: 300 ботов на одной машине, каждый изолирован. Это наш дешёвый тариф для курсов.", wishes: ["Изоляция как у ВМ", "Старт бота < 100 мс"] },
      artifacts: [{ kind: "file", title: "Замер: 300 ботов в 6 ГБ", path: "spark-engine/bench/RESULTS.md" }, { kind: "branch", title: "spark-engine · main", url: "https://github.com/getuno/spark-engine", note: "репо ещё не в getuno — см. T11" }],
      docs: ["agent-memory/spark_s1_design_2026_10_06.md"],
      actions: [{ text: "Общий движок JS/Python", done: true, who: "agent" }, { text: "Дедуп памяти между ботами", done: true, who: "agent" }, { text: "Решить: Intel-сервер", done: false, who: "misha" }, { text: "Прогон 300 ботов", done: false, who: "agent" }],
      env: { prod: null, stage: null, branch: "main" },
      feed: [{ at: m(210), kind: "question", text: "Арендовать Intel-сервер за $189/мес?" }, { at: m(600), kind: "status", text: "Общий движок JS/Python заработал на хосте" }],
    },
    {
      id: "T10", title: "Пополнить Hostkey", priority: "P0", rank: 5, status: "needs_you", progress: 0,
      stream: "Ноды", why: "hector ≈ $348 к 05.11. При нуле почасовые серверы удаляются вместе с данными.",
      deadline: "2026-10-20T00:00:00Z", eta: { left: "2 минуты твоих", at: null }, chats: ["ch-coord"], owner: "ch-coord",
      stages: [],
      needs: { kind: "do", money: "$350", title: "Пополнить баланс Hostkey на $350",
        explain: "Оплата картой в кабинете Hostkey — это можешь только ты.",
        steps: ["Кабинет Hostkey → Billing", "Пополнить $350 картой", "Нажать «Готово» здесь"], autoText: "Напомню 18.10, если не будет «готово»", askedAt: m(1300) },
      request: { by: "Координатор", at: "2026-10-15T14:00:00Z", text: "Баланс Hostkey кончится к 05.11, почасовые удаляются при нуле." },
      artifacts: [{ kind: "link", title: "Кабинет Hostkey · Billing", url: "https://invapi.hostkey.com/billing" }],
      docs: [], actions: [{ text: "Пополнить $350", done: false, who: "misha" }], env: null,
      feed: [{ at: m(1300), kind: "blocked", text: "Hostkey: баланс к 05.11 кончится" }],
    },
    {
      id: "T11", title: "Создать 2 репо в getuno: spark-engine и uno-vmm", priority: "P0", rank: 6, status: "needs_you", progress: 0,
      stream: "Код", why: "Единственная копия кода движков — на облаке uno-work. Сломается диск — потеряем недели работы.",
      deadline: "2026-10-16T18:00:00Z", eta: { left: "1 минута твоя", at: null }, chats: ["ch-coord"], owner: "ch-coord",
      needs: { kind: "do", title: "Создать 2 закрытых репо в GitHub getuno",
        explain: "Права админа организации getuno есть только у тебя.",
        steps: ["github.com/organizations/getuno → New repository", "spark-engine (Private)", "uno-vmm (Private)", "Нажать «Готово» — агенты сами запушат"], autoText: "Риск растёт каждый день", askedAt: m(1300) },
      request: { by: "Координатор", at: "2026-10-15T14:00:00Z", text: "Код движков лежит в одной копии на облаке uno-work." },
      artifacts: [{ kind: "link", title: "GitHub · New repository в getuno", url: "https://github.com/organizations/getuno/repositories/new" }],
      docs: [], actions: [{ text: "Создать spark-engine", done: false, who: "misha" }, { text: "Создать uno-vmm", done: false, who: "misha" }, { text: "Запушить код", done: false, who: "agent" }], env: null,
      feed: [{ at: m(1300), kind: "blocked", text: "Репо spark-engine и uno-vmm в getuno" }],
    },
    {
      id: "T09", title: "Напоминание рассылки offer-d1", priority: "P0", rank: 7, status: "needs_you", progress: 40,
      stream: "Продажи", why: "1 254 доставлено, 7 открытий, 0 оплат. Напоминание запланировано на 16.10 11:00 МСК.",
      deadline: "2026-10-16T08:00:00Z", eta: { left: "готово к отправке", at: null }, chats: ["ch-coord"], owner: "ch-coord",
      needs: { kind: "decide", title: "Слать напоминание 16.10 в 11:00 МСК?",
        explain: "Путь с сервером пока сломан (T06). Если напомним сейчас — часть людей упрётся в ошибку.",
        options: [
          { label: "Перенести, пока не починим T06", hint: "Напомним, когда путь клиента станет зелёным.", recommended: true },
          { label: "Слать как запланировано", hint: "Бесплатная часть работает — но платить некуда." },
        ], autoAt: "2026-10-16T07:00:00Z", autoText: "Без ответа до 07:00 UTC — перенесу", blocks: [], askedAt: m(300) },
      request: { by: "Миша", at: "2026-10-12T10:00:00Z", text: "Оффер на год всем до 19.10, рассылка в бота." },
      artifacts: [{ kind: "site", title: "Живой дашборд рассылки", url: "https://misha-offer-live.uno4.me/", password: "pearl-8830-dune" }],
      docs: ["reports/day_2026-10-12/offer-final/COMMS_WEEK_PLAN.md"],
      actions: [{ text: "Тексты напоминания", done: true, who: "agent" }, { text: "Решить: слать или перенести", done: false, who: "misha" }], env: null,
      feed: [{ at: m(300), kind: "question", text: "Что с напоминанием 16.10?" }],
    },
    {
      id: "T21", title: "Вторая нода nl-2", priority: "P1", rank: 8, status: "doing", progress: 70,
      stream: "Ноды", why: "hector почти полна. nl-2 подключена, но закрыта для клиентов до фикса ключа exec.",
      deadline: "2026-10-16T12:00:00Z", eta: { left: "≈ 2 ч", at: fwd(150) },
      chats: ["ch-rel"], owner: "ch-rel",
      stages: [{ name: "Сервер", done: true }, { name: "Образ", done: true }, { name: "Мониторинг", done: true }, { name: "Фикс ключа exec", done: false, now: true }, { name: "Открыть клиентам", done: false }],
      artifacts: [{ kind: "file", title: "Рансбук nl-2", path: "reports/day_2026-10-13/node2/RUNBOOK.md" }, { kind: "link", title: "Grafana · uno-nodes", url: "https://grafana.getuno.xyz/d/uno-nodes" }],
      docs: ["reports/day_2026-10-13/node2/RUNBOOK.md"],
      actions: [{ text: "Мониторинг обеих нод", done: true, who: "agent" }, { text: "Фикс ключа exec в машинах из образов", done: false, who: "agent" }, { text: "Рестарт агента hector ≈ 01:45 CEST", done: false, who: "agent" }, { text: "Открыть nl-2 клиентам", done: false, who: "agent" }],
      env: { prod: { what: "nl-2 internal (только наши)", at: m(30) }, stage: null, branch: "fix/image-exec-key-per-node" },
      request: { by: "Миша", at: "2026-10-13T09:00:00Z", text: "Вторая нода в NL, чтобы не упираться в hector." },
      feed: [{ at: m(30), kind: "status", text: "nl-2 закрыта для клиентов до фикса ключа exec" }, { at: m(7), kind: "status", text: "Катаю консоль 5941f48e: связь нод (выключена)" }],
    },
    {
      id: "T29", title: "Лендинги, вики, SEO: 98 страниц", priority: "P2", rank: 9, status: "paused", progress: 16,
      stream: "Маркетинг", why: "Страницы под поиск: VPS, прокси, агенты в облаке. 16 на превью.",
      deadline: null, eta: { left: "≈ 2 дня", at: null },
      chats: ["ch-seo"], owner: "ch-seo",
      pause: "Встал на лимите Claude · shubaduba. Можно перенести на uno-product — там 88% свободно.",
      stages: [{ name: "План", done: true }, { name: "Пачка 1 · 16 стр.", done: true }, { name: "Пачка 2 · 20 стр.", done: false, now: true }, { name: "Остальные 62", done: false }],
      needs: { kind: "look", title: "Посмотреть 16 страниц и дать «да» на следующие 20",
        explain: "Страницы на превью, ещё не в поиске.",
        options: [{ label: "Да, следующие 20", recommended: true, hint: "Тем же стилем." }, { label: "Сначала поправлю эти", hint: "Оставь фидбек на странице." }], askedAt: m(160) },
      request: { by: "Миша", at: "2026-10-13T12:00:00Z", text: "SEO-машина: 98 страниц, Dax-блок на всех страницах, разработчикам цифры, остальным «топ по скорости»." },
      artifacts: [{ kind: "site", title: "Превью страниц (16)", url: "https://misha-pages-1015.uno4.me/", password: "cedar-4417-wave" }, { kind: "site", title: "Dax: топ-5 рядом с нами", url: "https://misha-pages-1015.uno4.me/benchmarks/", password: "cedar-4417-wave" }],
      docs: ["strategy/CONTENT_SITE_PLAN.md"],
      actions: [{ text: "Пачка 1", done: true, who: "agent" }, { text: "Посмотреть 16 страниц", done: false, who: "misha" }, { text: "Пачка 2", done: false, who: "agent" }],
      env: { prod: null, stage: { what: "Превью 16 страниц", at: m(240) }, branch: "pages-batch-2" },
      feed: [{ at: m(160), kind: "paused", text: "Пауза до 23:15 UTC (лимит)" }, { at: m(240), kind: "report", text: "Dax: топ-5 рейтинга рядом с нами" }],
    },
    {
      id: "T15", title: "Uno Work 0.0.137 в проде", priority: "P1", rank: 10, status: "done", progress: 100,
      stream: "Uno Work", why: "Вложения любые, скачать везде, New chat сверху, все режимы сайдбара.",
      deadline: null, eta: null, chats: ["ch-work", "ch-rel"], owner: "ch-work",
      stages: [{ name: "Сборка", done: true }, { name: "Тесты", done: true }, { name: "Канарейка", done: true }, { name: "Образ 236", done: true }],
      artifacts: [{ kind: "site", title: "Скриншоты 0.0.137", url: "https://misha-work-0137.uno4.me/", password: "otter-5518-bloom" }, { kind: "branch", title: "release/0.0.137", url: "https://github.com/getuno/uno-work-app/tree/release/0.0.137", note: "0571dba4" }],
      docs: [], actions: [{ text: "Выкатить", done: true, who: "agent" }, { text: "Образ 236", done: true, who: "agent" }],
      env: { prod: { what: "Work 0.0.137 · образ 236", at: m(85), rollback: "Образ 234" }, stage: null, branch: "release/0.0.137" },
      request: { by: "Миша", at: "2026-10-15T18:00:00Z", text: "4 правки: вложения любые, скачать везде, New chat сверху, режимы сайдбара все." },
      feed: [{ at: m(85), kind: "release", text: "Work 0.0.137 в проде, образ 236" }],
    },
    {
      id: "T04", title: "Clean exit IP всем платным", priority: "P0", rank: 11, status: "done", progress: 100,
      stream: "Сеть", why: "Свой чистый IP-адрес для агентов клиентов.",
      deadline: null, eta: null, chats: ["ch-rel"], owner: "ch-rel",
      artifacts: [{ kind: "file", title: "SHIP: Clean exit IP", path: "reports/day_2026-10-13/exit-ip/SHIP.md" }],
      docs: ["reports/day_2026-10-13/exit-ip/SHIP.md"], actions: [],
      env: { prod: { what: "Включено всем платным", at: m(137), rollback: "EXIT_IP_AUTO=off" }, stage: null, branch: "main" },
      request: { by: "Миша", at: "2026-10-15T20:00:00Z", text: "Да, Clean exit IP всем." },
      feed: [{ at: m(137), kind: "release", text: "Clean exit IP включён всем платным (22:03 UTC)" }],
    },
    {
      id: "T05", title: "Замер Dax на сервере США", priority: "P2", rank: 12, status: "review", progress: 90,
      stream: "Ноды", why: "Цифры скорости для лендингов и сабмит в рейтинг.",
      deadline: null, eta: { left: "ждём контракт API от computesdk", at: null }, chats: ["ch-dax"], owner: "ch-dax",
      blocker: "Ждём контракт API от computesdk — не от тебя.",
      artifacts: [{ kind: "site", title: "Dax: топ-5 рядом с нами", url: "https://misha-pages-1015.uno4.me/benchmarks/", password: "cedar-4417-wave" }, { kind: "file", title: "Результаты замера", path: "reports/day_2026-10-15/dax/RESULTS.md" }],
      docs: [], actions: [{ text: "Fast 38,9 с — 2-е из 21", done: true, who: "agent" }, { text: "Адаптер @computesdk/uno", done: false, who: "agent", note: "после контракта" }],
      env: null, request: { by: "Миша", at: "2026-10-13T11:00:00Z", text: "Замерь Dax на сервере в США, Fast по умолчанию." },
      feed: [{ at: m(150), kind: "report", text: "Fast 38,9 с — 2-е место из 21" }],
    },
    {
      id: "T14", title: "Вкладка Network в консоли + exit IP в шапке", priority: "P1", rank: 13, status: "review", progress: 90,
      stream: "Консоль", why: "Человек видит свой IP и страну выхода, меняет в 2 клика.",
      deadline: null, eta: { left: "в поезде на 16.10", at: null }, chats: ["ch-rel"], owner: "ch-rel",
      artifacts: [{ kind: "link", title: "Стейдж: Network", url: "https://stage.uno4.dev/network" }, { kind: "screen", title: "Network · Exit IP", tone: "ok" }],
      docs: [], actions: [{ text: "Экраны", done: true, who: "agent" }, { text: "Посмотреть на стейдже", done: false, who: "misha" }],
      env: { prod: null, stage: { what: "feat/exit-ip-network-view", at: m(400) }, branch: "feat/exit-ip-network-view" },
      request: { by: "Миша", at: "2026-10-13T15:00:00Z", text: "Продвинутая вкладка Network и exit IP в шапке." },
      feed: [{ at: m(400), kind: "status", text: "На стейдже" }],
    },
    {
      id: "T30", title: "Биллинг: вкладки Plans и Usage", priority: "P2", rank: 14, status: "paused", progress: 35,
      stream: "Консоль", why: "Человек видит тариф, что потратил и что дальше. Оборвано лимитом 13.10.",
      deadline: null, eta: { left: "≈ 4 ч", at: null }, chats: ["ch-billing"], owner: "ch-billing",
      pause: "Чат спит с 13.10 (лимит). Разбудить — одна кнопка.",
      stages: [{ name: "Plans", done: true }, { name: "Usage", done: false }, { name: "Стейдж", done: false }],
      artifacts: [{ kind: "screen", title: "Billing · Plans", tone: "ok" }, { kind: "branch", title: "uno-console · feat/billing-tabs", url: "https://github.com/getuno/uno-console/tree/feat/billing-tabs" }],
      docs: ["reports/day_2026-10-11/checkout-variants/DECISION.md"],
      actions: [{ text: "Plans по варианту C", done: true, who: "agent" }, { text: "Usage", done: false, who: "agent" }],
      env: { prod: null, stage: null, branch: "feat/billing-tabs" },
      request: { by: "Миша", at: "2026-10-11T19:00:00Z", text: "Вариант C: карточки тарифов + чекаут. Usage — сколько потратил и на что." },
      feed: [{ at: m(3700), kind: "paused", text: "Упёрлись в недельный лимит" }],
    },
    {
      id: "T35", title: "Обучение своей модели: большой прогон", priority: "P3", rank: 15, status: "needs_you", progress: 25,
      stream: "Модель", why: "Своя модель Uno дешевле и быстрее на наших задачах.",
      deadline: null, eta: { left: "6–8 ч GPU после «да»", at: null }, chats: ["ch-train"], owner: "ch-train",
      needs: { kind: "decide", money: "$300–600", title: "Запустить большой прогон за $300–600?",
        explain: "Экзамен — 312 реальных просьб клиентов. Судья — Opus: сравнивает ответы нашей модели и эталона.",
        options: [{ label: "Сначала малый на $50", hint: "Проверим, что обвязка не врёт.", recommended: true }, { label: "Да, большой до $600", hint: "Сразу ответ, стоит ли учить дальше." }],
        autoText: "Деньги — без тебя не запускаю", askedAt: m(1500) },
      artifacts: [{ kind: "file", title: "План: экзамен и прогон", path: "model-lab/README.md" }],
      docs: ["model-lab/README.md"], actions: [{ text: "Обвязка", done: true, who: "agent" }, { text: "Экзамен 312 просьб", done: true, who: "agent" }, { text: "«Да» на прогон", done: false, who: "misha" }],
      env: null, request: { by: "Миша", at: "2026-10-11T12:00:00Z", text: "План: обвязка → экзамен из ~300 реальных просьб → большой прогон с Opus-судьёй." },
      feed: [{ at: m(1500), kind: "question", text: "Запустить большой прогон?" }],
    },
    {
      id: "T34", title: "Движок ВМ на seL4", priority: "P3", rank: 16, status: "doing", progress: 45,
      stream: "Движок", why: "Своя ВМ вместо Firecracker: быстрее старт, меньше памяти.",
      deadline: null, eta: { left: "недели", at: null }, chats: ["ch-engine"], owner: "ch-engine",
      artifacts: [{ kind: "branch", title: "uno-vmm · virtio-net", url: "https://github.com/getuno/uno-vmm/tree/virtio-net", note: "репо ещё не в getuno" }],
      docs: [], actions: [{ text: "Драйвер сети", done: true, who: "agent" }, { text: "Блочное устройство", done: false, who: "agent" }],
      env: null, request: { by: "Миша", at: "2026-10-07T10:00:00Z", text: "Свой VMM на seL4 вместо FC." },
      feed: [{ at: m(560), kind: "status", text: "Слил драйвер сети в main" }],
    },
    {
      id: "T24", title: "Почта hello@ и support@ getuno.xyz", priority: "P1", rank: 17, status: "needs_you", progress: 10,
      stream: "Компания", why: "Адресов нет — письма клиентов отскакивают.",
      deadline: null, eta: { left: "5 минут твоих", at: null }, chats: ["ch-coord"], owner: "ch-coord",
      needs: { kind: "do", title: "Создать 3 ящика в Zoho", explain: "Админка Zoho — только у тебя.",
        steps: ["Zoho Mail Admin → Users", "hello@, support@, noreply@", "Нажать «Готово»"], askedAt: m(5900) },
      artifacts: [{ kind: "link", title: "Zoho Mail Admin", url: "https://mailadmin.zoho.eu/" }],
      docs: [], actions: [{ text: "Создать ящики", done: false, who: "misha" }, { text: "Переадресация в Telegram поддержки", done: false, who: "agent" }],
      env: null, request: { by: "Координатор", at: "2026-10-11T10:00:00Z", text: "hello@/support@/noreply@ не существуют в Zoho." },
      feed: [{ at: m(5900), kind: "blocked", text: "Почта hello@/support@ не существует" }],
    },
    {
      id: "T01", title: "Пульт 3.0: версии на моках", priority: "P0", rank: 18, status: "doing", progress: 60,
      stream: "Платформа", why: "Пульт 2.0 неудобен. Нужен один экран: что ждёт меня, кто где работает, артефакты, чат.",
      deadline: "2026-10-16T12:00:00Z", eta: { left: "≈ 1 ч", at: fwd(60) }, chats: ["ch-pult"], owner: "ch-pult",
      stages: [{ name: "Разбор истории", done: true }, { name: "Моки", done: true }, { name: "3 версии", done: false, now: true }, { name: "Выбор Миши", done: false }],
      artifacts: [],
      docs: ["tracker/briefs/PULT_V2.md"], actions: [{ text: "3 версии", done: false, who: "agent" }, { text: "Выбрать версию", done: false, who: "misha" }],
      env: null, request: { by: "Миша", at: m(40), text: "список задач, статус, прогресс, нужна ли моя помощь, кто делает и где, артефакты с паролями, доки, чат, быстрый диспетчер",
        wishes: ["Открывается в Uno Work", "Новый чат с любым ИИ на любой машине", "Менять порядок руками", "Быстрый чат-диспетчер"] },
      feed: [{ at: m(1), kind: "status", text: "Собираю 3 версии" }],
    },
    {
      id: "T40", title: "Нода сама будит холодным стартом после смены ядра", priority: "P1", rank: 19, status: "todo", progress: 0,
      stream: "Ноды", why: "После ребута hector 39 спящих машин просыпались мёртвыми — вылечены вручную.",
      deadline: null, eta: null, chats: [], owner: null,
      artifacts: [{ kind: "file", title: "Разбор: мёртвое пробуждение", path: "reports/day_2026-10-15/hector-reboot/DEAD_WAKE.md" }],
      docs: [], actions: [], env: null,
      request: { by: "Координатор", at: "2026-10-15T21:30:00Z", text: "Снимок памяти старого ядра → при пробуждении машина мёртвая. Нода должна сама делать cold boot." },
      feed: [],
    },
    {
      id: "T32", title: "QA прода: 25 открытых находок", priority: "P2", rank: 20, status: "review", progress: 50,
      stream: "Платформа", why: "37 находок, 12 закрыты.",
      deadline: null, eta: null, chats: ["ch-codex-qa"], owner: "ch-codex-qa",
      artifacts: [{ kind: "file", title: "Находки по экранам", path: "qa/FINDINGS.md" }],
      docs: [], actions: [{ text: "«Всё на стейдж» — да?", done: false, who: "misha" }], env: null,
      request: { by: "Миша", at: "2026-10-09T10:00:00Z", text: "QA прода как клиент." }, feed: [{ at: m(300), kind: "status", text: "12 закрыты, 25 открыты" }],
    },
    {
      id: "T03", title: "Бот «стоп» не записывал отписку", priority: "P0", rank: 21, status: "done", progress: 100,
      stream: "Продажи", why: "До напоминания 16.10.", deadline: null, eta: null, chats: ["ch-coord"], owner: "ch-coord",
      artifacts: [], docs: [], actions: [], env: { prod: { what: "Фикс отписки", at: m(450) } },
      request: { by: "Миша", at: "2026-10-15T14:00:00Z", text: "Люди пишут «стоп», а бот продолжает слать." }, feed: [{ at: m(450), kind: "release", text: "Выкачено" }],
    },
    {
      id: "T36", title: "Видео-туториал?", priority: "P3", rank: 22, status: "idea", progress: 0,
      stream: "Маркетинг", why: "Идея Миши.", deadline: null, eta: null, chats: [], owner: null,
      artifacts: [], docs: [], actions: [], env: null, request: { by: "Миша", at: "2026-10-14T10:00:00Z", text: "Может, видео-туториал на 2 минуты?" }, feed: [],
    },
  ];

  /* ───────── Выкатки: что где сейчас ───────── */
  const releases = [
    { at: m(7), env: "prod", what: "Консоль 5941f48e: связь нод (выключена флагом)", state: "rolling", by: "ch-rel", task: "T21", progress: 30 },
    { at: m(85), env: "prod", what: "Uno Work 0.0.137 · образ 236", state: "ok", by: "ch-rel", task: "T15", rollback: "Образ 234" },
    { at: m(137), env: "prod", what: "Clean exit IP всем платным", state: "ok", by: "ch-rel", task: "T04", rollback: "EXIT_IP_AUTO=off" },
    { at: m(450), env: "prod", what: "Фикс отписки в боте", state: "ok", by: "ch-coord", task: "T03" },
    { at: m(540), env: "prod", what: "KV за флагом KV_SERVICE=85", state: "ok", by: "ch-kv", task: "T07" },
    { at: m(55), env: "stage", what: "fix/path-deploy: 2 из 4 разрывов", state: "ok", by: "ch-onb", task: "T06" },
    { at: m(400), env: "stage", what: "Network + exit IP в шапке", state: "ok", by: "ch-rel", task: "T14" },
    { at: fwd(85), env: "plan", what: "Рестарт агента hector — фикс ключа exec", state: "planned", by: "ch-rel", task: "T21" },
  ];

  /* ───────── Решения Миши (чтобы агенты не переспрашивали) ───────── */
  const decisions = [
    { at: "2026-10-15T22:00:00Z", text: "Clean exit IP — всем платным", task: "T04" },
    { at: "2026-10-15T20:10:00Z", text: "Хакатон — суббота 17.10; последние выкатки в пятницу", task: "T07" },
    { at: "2026-10-15T19:40:00Z", text: "GitHub-вход: всем после ревью", task: "T12" },
    { at: "2026-10-15T18:20:00Z", text: "США = Fast по умолчанию; регион по близости: Америки → US, остальное → NL", task: "T05" },
    { at: "2026-10-15T17:00:00Z", text: "Никакого «Sign in with Claude» и моков claude.ai на наших страницах", task: null },
    { at: "2026-10-15T15:00:00Z", text: "Пробник: два пути, карта обязательна, Plus $20 через 3 дня", task: "T06" },
    { at: "2026-10-15T12:00:00Z", text: "Основная работа — на облаке uno-product (подписка email.torgashin)", task: null },
    { at: "2026-10-11T21:55:00Z", text: "Сайдбар: два режима, классика по умолчанию, переключение в настройках", task: "T16" },
    { at: "2026-10-05T12:00:00Z", text: "Любой путь клиента — абсурдно простой, уровень OpenClaw", task: null },
  ];

  /* ───────── Доки (для просмотра и правки) ───────── */
  const docs = {
    "reports/day_2026-10-15/kv/RUNBOOK.md": { title: "KV: рансбук к хакатону", updatedAt: m(240), by: "KV на хакатон",
      md: "# KV к хакатону 17.10\n\n**Итог:** KV в проде за флагом `KV_SERVICE=85`. Участникам включаем промокодом или по списку.\n\n## Как включить\n1. Промокод `HACK17` → флаг KV для аккаунта, который ввёл код.\n2. Лимиты: 1 хранилище, 100 тыс. ключей, 50 запросов/с.\n3. Проверка: сценарий участника на стейдже (4 шага).\n\n## Откат\n- Снять флаг: `kv disable --promo HACK17` — участники теряют доступ, данные остаются 7 дней.\n\n## Что проверить руками\n- [ ] Ввести промокод с тестового аккаунта\n- [ ] Записать и прочитать ключ из бота\n" },
    "strategy/TRIAL_DESIGN.md": { title: "Пробник с картой: два пути", updatedAt: m(100), by: "Координатор",
      md: "# Пробник с картой\n\n**Решение Миши 15.10:** два пути.\n\n## Путь 1 — Uno Work\nUno Work → сразу Plus (Workspace + отдельный сервер). Карта обязательна: $0 сегодня, $20 через 3 дня.\n\n## Путь 2 — свой агент\nСвой агент (Claude Code, Codex) получает сервер как инструмент. Агент сам знает биллинг через API/CLI/MCP.\n\n## Открытые вопросы\n- Старые пробники без карты — оставить до конца срока.\n- Цена «объёмного» сервера: $5?\n" },
    "reports/day_2026-10-15/path/PATH_REPORT.md": { title: "Путь клиента 15.10", updatedAt: m(180), by: "Весь путь как клиент",
      md: "# Путь клиента: лендинг → карта → сервер\n\n**Итог:** бесплатное работает, с сервером — нет. Новый путь катить нельзя.\n\n| Флоу | Шагов | Итог |\n|---|---|---|\n| 1. Бесплатный Work | 9 | ✅ |\n| 2. Свой агент + сервер | 14 | 🔴 шаг 9 |\n| 3. Claude Code на сервере | 12 | 🔴 шаг 4 |\n\n## Разрывы\n1. Проект с сервером ни разу не дошёл до адреса.\n2. «See plans» для бота продаёт Plus, а не Small.\n3. Три экрана показывают разные суммы.\n4. Пробник отвечает «Not logged in».\n" },
    "tracker/briefs/PULT_V2.md": { title: "Бриф: Пульт 2.0", updatedAt: m(620), by: "Координатор",
      md: "# Пульт 2.0 — умный трекер задач\n\nСначала инструмент, потом порядок через него.\n\n## Что хочет Миша\nТрекать статусы, приоритеты, кто и где занимается, прогресс по стадиям, дедлайны; стопнуть, поменять приоритет, дать коммент, провалиться в чат.\n" },
    "strategy/CONTENT_SITE_PLAN.md": { title: "План: 98 страниц", updatedAt: m(2000), by: "Лендинги, вики, SEO",
      md: "# Контент-сайт: 98 страниц\n\n- 30 лендингов под запросы (VPS, прокси, агент в облаке)\n- 40 статей вики\n- 28 сравнений с конкурентами\n\nDax-блок — на всех страницах: разработчикам цифры, остальным «топ по скорости».\n" },
    "reports/day_2026-10-13/node2/RUNBOOK.md": { title: "Рансбук nl-2", updatedAt: m(30), by: "Выкатки в прод",
      md: "# Вторая нода nl-2\n\n## Статус\nПодключена, закрыта для клиентов (internal) до фикса ключа exec в машинах из образов.\n\n## Дальше\n1. Рестарт агента hector ≈ 01:45 CEST — только фикс ключа.\n2. Проверить exec на 3 машинах из образа 236.\n3. Открыть nl-2 клиентам.\n" },
    "model-lab/README.md": { title: "Своя модель: план", updatedAt: m(1500), by: "Обучение модели Uno",
      md: "# Своя модель Uno\n\nОбвязка → экзамен из 312 реальных просьб → большой прогон с судьёй Opus ($300–600, отдельное «да»).\n" },
    "agent-memory/misha_sidebar_feedback_2026_10_08.md": { title: "Сайдбар: решения Миши", updatedAt: m(5000), by: "Память",
      md: "# Сайдбар\n\nДва режима — **классика** (по умолчанию, проекты всегда слева) и **инбокс** (по статусам, со Snoozed). Переключение — галочкой в настройках.\n" },
    "reports/day_2026-10-12/offer-final/COMMS_WEEK_PLAN.md": { title: "План рассылок на неделю", updatedAt: m(3000), by: "Координатор",
      md: "# Рассылки недели\n\n- 12.10 offer-d1 — 1 254 доставлено\n- 16.10 11:00 МСК — напоминание\n- 19.10 23:59 UTC — конец оффера\n" },
    "reports/day_2026-10-13/exit-ip/SHIP.md": { title: "SHIP: Clean exit IP", updatedAt: m(137), by: "Выкатки в прод",
      md: "# Clean exit IP\n\nВключено всем платным 15.10 22:03 UTC. Откат: `EXIT_IP_AUTO=off`.\n" },
    "agent-memory/spark_s1_design_2026_10_06.md": { title: "Spark: дизайн S1", updatedAt: m(8000), by: "Память", md: "# Spark S1\n\nS1-A…S1-E готовы: Spark сквозь seL4.\n" },
    "reports/day_2026-10-11/checkout-variants/DECISION.md": { title: "Чекаут: вариант C", updatedAt: m(6000), by: "Координатор", md: "# Вариант C\n\nКарточки тарифов + чекаут, оплата сохранённой картой.\n" },
  };

  /* ───────── Что изменилось, пока тебя не было ───────── */
  const lastSeen = m(220);
  const sinceLastSeen = [
    { at: m(137), kind: "release", text: "Clean exit IP включён всем платным", task: "T04" },
    { at: m(85), kind: "release", text: "Uno Work 0.0.137 в проде", task: "T15" },
    { at: m(180), kind: "report", text: "Путь клиента: с сервером не работает — новый путь катить нельзя", task: "T06", bad: true },
    { at: m(62), kind: "question", text: "Новый вопрос: как включить KV участникам", task: "T07" },
    { at: m(160), kind: "paused", text: "SEO встал на лимите shubaduba", task: "T29", bad: true },
    { at: m(30), kind: "status", text: "nl-2 закрыта для клиентов до фикса ключа", task: "T21" },
  ];

  /* ───────── Повторы: одно и то же спрашивают разные чаты ───────── */
  const duplicates = [
    { text: "«Чем проверить карту в проде» — спросили 2 чата", tasks: ["T06"], chats: ["ch-path", "ch-onb"] },
  ];

  /* ───────── Входящие фидбеки Миши, уже разнесённые по чатам ───────── */
  const feedbackLog = [
    { at: m(1400), text: "Кнопка «Add a card» слишком мелкая на телефоне", to: "ch-onb", task: "T06", delivered: true, file: "reports/day_2026-10-15/feedback/add-card-mobile.png" },
    { at: m(2900), text: "На Home нельзя вернуться, если ушёл", to: "ch-work", task: "T15", delivered: true },
  ];

  /* ───────── Агенты, которых можно запустить ───────── */
  const agentKinds = [
    { id: "claude", name: "Claude Code", models: ["Opus 5.5", "Sonnet 5.5", "Fable 5.1"], subs: ["shubaduba", "torgashin"] },
    { id: "codex", name: "Codex", models: ["GPT-5.5", "GPT-5.5 mini"], subs: ["chatgpt"] },
    { id: "uno", name: "Uno AI", models: ["Smart", "Fast"], subs: ["uno-ai"] },
    { id: "opencode", name: "OpenCode", models: ["GLM-4.7", "Qwen3 Coder"], subs: ["openrouter"] },
  ];

  /* ───────── Мои просьбы: всё, что Миша просил, и где оно сейчас («я же просил») ───────── */
  // where: prod · stage · doing · lost (никто не взял / оборвано) · declined
  const wishes = [
    { at: "2026-10-15T23:41:00Z", text: "Пульт: несколько версий, полный фронтенд на моках", where: "doing", task: "T01" },
    { at: "2026-10-15T18:00:00Z", text: "Вложения любых файлов, Download везде, New chat сверху", where: "prod", task: "T15" },
    { at: "2026-10-15T15:00:00Z", text: "Пробник с картой — два пути", where: "doing", task: "T06" },
    { at: "2026-10-15T14:10:00Z", text: "KV участникам хакатона", where: "stage", task: "T07" },
    { at: "2026-10-14T10:00:00Z", text: "Видео-туториал на 2 минуты", where: "lost", task: "T36", note: "Никто не взял" },
    { at: "2026-10-13T15:00:00Z", text: "Вкладка Network + exit IP в шапке", where: "stage", task: "T14" },
    { at: "2026-10-13T12:00:00Z", text: "Dax-блок на всех лендингах", where: "doing", task: "T29" },
    { at: "2026-10-11T21:55:00Z", text: "Snoozed в статусах сайдбара", where: "prod", task: "T16" },
    { at: "2026-10-11T19:00:00Z", text: "Биллинг: вкладки Plans и Usage", where: "lost", task: "T30", note: "Оборвано лимитом 13.10, 3 дня никто не трогал" },
    { at: "2026-10-08T12:00:00Z", text: "Home должен быть достижим всегда", where: "prod", task: "T15" },
    { at: "2026-10-05T10:00:00Z", text: "Вкладка бонусов в консоли", where: "prod", task: null, note: "Выкачено 06.10 — консоль → Bonuses" },
  ];

  /* ───────── Алерты: что это и нужен ли ты (вместо пересылки в чат) ───────── */
  const alerts = [
    { at: m(25), source: "Сторож Contabo", raw: "🕸 10.30.0.1 веер SYN 1200/s", plain: "Ложная тревога: это сама нода опрашивает машины после рестарта.", needYou: false, handledBy: "ch-rel", muted: false },
    { at: m(140), source: "Security", raw: "Uno used its key without a record · box-2298", plain: "Наш агент зашёл в машину клиента без записи в журнал. Задним числом пояснение уже записано, клиенту видно «плановое обслуживание».", needYou: false, handledBy: "ch-rel" },
    { at: m(310), source: "Hostkey", raw: "Invoice #88213: $347.90 due 05.11", plain: "Счёт за hector на $348 до 05.11. Нужно пополнить баланс — это задача T10.", needYou: true, task: "T10" },
    { at: m(700), source: "Канарейка сайтов", raw: "uno4.me: 2/50 sites 5xx", plain: "Два сайта клиентов отвечали ошибкой 3 минуты, потом сами поднялись. Ничего делать не надо.", needYou: false, muted: true },
  ];

  /* ───────── Когда смотреть: что будет готово и когда ───────── */
  const upcoming = [
    { at: fwd(30), text: "Перепроверка 4 разрывов пути клиента", task: "T06", chat: "ch-path" },
    { at: fwd(85), text: "Рестарт агента hector (фикс ключа exec)", task: "T21", chat: "ch-rel" },
    { at: fwd(150), text: "nl-2 открыта клиентам", task: "T21", chat: "ch-rel" },
    { at: fwd(60), text: "Пульт 3.0: 3 версии на выбор", task: "T01", chat: "ch-pult" },
  ];

  /* ───────── Живые цифры (виджеты) ───────── */
  const pulse = [
    { label: "Платят", value: "41", delta: "+2 за сутки" },
    { label: "Активны сегодня", value: "318", delta: "+12%" },
    { label: "hector занята", value: "84%", delta: "130 ГиБ свободно", warn: true },
    { label: "Рассылка offer-d1", value: "7 / 1 254", delta: "открыли · 0 оплат", warn: true },
  ];

  return { NOW, lastSeen, machines, subscriptions, chats, tasks, releases, decisions, docs, sinceLastSeen, agentKinds, wishes, alerts, upcoming } as unknown as PultData;
})();
