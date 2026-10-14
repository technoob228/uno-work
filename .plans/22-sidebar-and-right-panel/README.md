# 22 — Сайдбар (Classic / Inbox) и правая панель (лаунчер, браузер, комментарии)

Статус: **прототипы и исследование, кода приложения ещё нет.** 14.10.2026.

Канвас с кликабельными прототипами (приватный, у владельца аккаунта):
https://claude.ai/artifact/YVpLsjLoMuNukmWQm1Bw4y

Исходники всех артбордов — в `prototypes/` (формат `.dc.html`; `canvas.json` — раскладка).
`prototypes/v1-separate-screens/` — первая итерация правой панели отдельными экранами; заменена `App.dc.html` + `Now.dc.html`.

## Что просил Миша

1. Сайдбар как в свежем t3 code: проще. Два режима — Inbox и Classic. Секции пользователю не показывать.
2. «Если делаем как Codex desktop / t3 — не ошибёмся».
3. Решения:
   - Classic по умолчанию, Inbox включается в настройках.
   - Где жить Assistant и машинам — предложить варианты.
4. Правая панель:
   - Одна кнопка вместо иконок браузера и файлов.
   - Она открывает панель с крупными вариантами: Files, Terminal, Browser, а также Apps и Sites.
5. Браузер — выбор, откуда открывать:
   - «Локально» — как в десктопе, прямо во вкладке панели.
   - Облачный компьютер агента — агент работает, ты смотришь для прозрачности, подсказываешь, делаешь Take control, если он тупит.
   - «Подключить агента к текущему браузеру» через Chrome-расширение с инструкцией установки. Само расширение довести до юзабельного.
   - Выбор — маленький селектор/дропдаун с вариантом по умолчанию, а не экран на всю панель.
6. Режим комментирования, как у Codex. Браузер чаще всего нужен для отладки дизайна.

## Исследование (что есть сейчас)

### upstream t3code (pingdotgg/t3code @ 348f217, 14.10.2026)

**Сайдбар — два компонента, выбор одним флагом.**
- Флаг `legacySidebarEnabled` (default false): `packages/contracts/src/settings.ts:464`.
- Переключатель в настройках: `SettingsPanels.tsx:2163`. Выбор компонента: `AppSidebarLayout.tsx:232,347`.
- Default «inbox» (`Sidebar.tsx`, ~5.6k строк): плоский список тредов по всем проектам. Проект выбирается фильтром.
- Секции: pinned / active / working / snoozed / settled (`Sidebar.logic.ts:134`). Drag&drop между ними.
- Секции требуют сервер:
  - команды и события pin / settle / snooze / visit;
  - поля `pinnedAt` / `settledAt` / `snoozedUntil` / `lastVisitedAt`;
  - миграции, scheduler, авто-settle.
- `LegacySidebar.tsx` (~3.9k) — дерево проект → треды, наш нынешний сайдбар его потомок.

**Правая панель — одна кнопка «Toggle right panel»** (`chat/PanelLayoutControls.tsx:115`).
- Пустая панель показывает лаунчер `RightPanelEmptyState` (`RightPanelTabs.tsx:327-500`). Это список с буквенными шорткатами: Browser (с выбором профиля), Terminal, Files, Diff, PR, Device.
- Открытое становится вкладкой.

**Встроенный браузер — только десктоп** (`apps/desktop/src/preview/*`, `<webview>`).

**Annotate-режим:**
- Кнопка: `PreviewChromeRow.tsx:235`.
- Пикер в странице: `apps/desktop/src/preview/PickPreload.ts`, на `react-grab`.
- Отправка в композер: `PreviewPanel.tsx` `onSendAnnotation`.

### Uno Work (technoob228/uno-work @ v0.0.132)

**Сайдбар** (`apps/web/src/components/Sidebar.tsx`, 3.8k) — дерево по проектам.
- Блок **Assistant**: `Sidebar.tsx:2787`, `isAssistantProjectId`.
- `MachineChip` у каждого треда.
- Footer: `SidebarEnvSwitcher` + Settings.
- `sidebarGrouping.ts` (группировка по машинам) реализован, но выключен: `SIDEBAR_MACHINE_GROUPING_ENABLED = false`.
- Поля pin / settle / snooze отсутствуют. `lastVisitedAt` есть (6 файлов).

**Шапка чата** (`chat/ChatHeader.tsx`):
- Название, бейдж проекта, toggle dev mode.
- Dev-кнопки: scripts, Open in, git, terminal, diff.
- Всегда видны Folder (`:243`), Globe (`:263`) и PanelRight (`:279`, только если есть превью-файлы).

**Правая панель** — `preview/PreviewPane.tsx` (1.6k).
- Вкладки файлов и браузера, «+» → «файл или страница».
- Монтируется глобально в `AppSidebarLayout.tsx:66`.
- Diff — отдельная панель (`routes/_chat.$environmentId.$threadId.tsx`).

**Браузер:**
- Десктоп: `<webview>` в `preview/BrowserPane.tsx:743`, с device toolbar и сохранёнными логинами. Веб: заглушка «только в десктопе» (`BrowserPane.tsx:741,806`).
- BrowserBridge: агент шлёт команды через `/api/browser/*` (`apps/server/src/browserBridge.ts`, `BrowserBridgeListener.tsx`).
- Роутинг: `browserCommandRouter.ts` выбирает webview клиента или headless Playwright на сервере (`serverBrowser.ts`) по `settings.browser.executor` (auto / local / server).
- Live-трансляции и Take control в этом чекауте нет. План — `.plans/21-server-side-browser.md`, «Phase 2, sketch».
- В памяти агента упомянута ветка `feat/browser-live-view` (CDP screencast, Take control, `requestHelp`): `uno-workspace/agent-memory/work_browser_live_view_2026_09_24.md`. **Где она сейчас — не нашёл.**

**Chrome-расширение:** в доступных репо нет ни одного `manifest.json`.
- Спека: `uno-workspace/knowledge/uno-work-browser-spec.md:100-124` — MV3 «Uno Work Companion».
- Путь по спеке: `uno-work-app/apps/extension/`. Этот репо не подключён к сессии.

## Предложенные решения

### Сайдбар

| | Вариант | Что нужно | Рекомендация |
|---|---|---|---|
| Classic | упрощённый (`Main.dc.html`) | только фронт | **по умолчанию** |
| Inbox A | плоский список, фильтр проекта, точка непрочитанного, плашки Working / Needs you | фронт + существующий `lastVisitedAt` | **рекомендую** |
| Inbox B | A + группа «Needs you» сверху | +1 правило сортировки | позже, если люди пропускают ждущие треды |
| Inbox C | как t3: Pinned / Active / полки | сервер + контракты + миграции, 1.5–3 недели | нет — секции решили не показывать |

Classic упрощённый — что меняется:
- Assistant — одна строка сверху.
- Сортировка, группировка и «show unreachable» уходят в меню.
- Чип машины только когда машин > 1.
- Footer: «All machines ▾» + шестерёнка.

Uno-добавки (`UnoExtras.dc.html`):
- **Assistant** — одна закреплённая строка сверху (рекомендую). Альтернативы: секция (как сейчас) или иконка в шапке.
- **Машины** — чип у треда и фильтр в футере, только если машин больше одной.

### Правая панель (`App.dc.html` = новое, `Now.dc.html` = как сейчас)

**Шапка.** Folder / Globe / PanelRight → одна кнопка `Panel ⌘J`. Dev-кнопки не трогаем.

**Лаунчер.** «+» в полосе вкладок или пустая панель → плитки Browser / Files / Terminal / Changes / Apps / Sites с буквенными шорткатами. Открытое становится обычной вкладкой `PreviewPane`.

**Браузер — чип источника в адресной строке** (`Локально ▾`). Дропдаун из 3 пунктов + «Открывать … по умолчанию»:
- **Локально.**
  - Десктоп: webview в панели, как сейчас.
  - Веб: страница открывается во вкладке Chrome пользователя через расширение — встроить чужой сайт в iframe нельзя (X-Frame-Options / CSP).
- **Облако агента.** Live-трансляция (CDP screencast), курсор «Uno», `Take control` / `Hand back`, агент может попросить помощи (`requestHelp`).
- **Мой Chrome.** Подключение в 3 шага прямо в панели:
  1. Поставить расширение.
  2. Сверить код.
  3. Выбрать вкладки.

  Агент видит только расшаренные вкладки и вкладки, которые открыл сам.

**Вариант по умолчанию** — новая настройка браузера рядом с `settings.browser.executor`. Плитка Browser открывает сразу дефолт, без вопроса.

**Режим комментирования** (кнопка в тулбаре, `C`):
- Клик по элементу → заметка → номер на элементе.
- «Send to chat» → в композер уходят заметки + селекторы + скриншоты.
- Десктоп: превью-скрипт в webview по образцу t3 `PickPreload.ts`.
- Облако: клик по кадру трансляции → `DOM.getNodeForLocation` через CDP (вторая очередь).

## Порядок работ (рекомендация)

1. Лаунчер правой панели + кнопка `Panel` в шапке — только фронт (`ChatHeader.tsx`, `PreviewPane.tsx`).
2. Сайдбар: Classic-упрощённый + Inbox A за настройкой (`legacySidebar`-подобный флаг, наоборот: `sidebarInboxEnabled`, default false).
3. Комментирование в десктопном браузере.
4. Чип источника + «по умолчанию» (сначала Локально / Облако-headless).
5. Облачный браузер: live view, Take control, `requestHelp` — найти / восстановить `feat/browser-live-view`.
6. Chrome-расширение «Uno Work Companion» + «Локально» в веб-версии через него.

## Открытые вопросы к Мише

- Где актуальный код live view и расширения: `uno-work-app` или ветки `uno-work`? Нужно подключить репо к сессии.
- Подтвердить порядок работ выше.
- Inbox A или сразу A+B.

## Костыли / оговорки прототипов

- Все данные выдуманные (треды, машины, сайты, приложения).
- `Now.dc.html` рисует сайдбар уже упрощённым: оба экрана — один компонент `App.dc.html`. Настоящий нынешний сайдбар — `ClassicToday.dc.html`.
- Тексты браузера на русском, остальное на английском — так же смешано в текущем приложении (`BrowserPane.tsx` по-русски).
