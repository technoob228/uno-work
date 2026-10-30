/**
 * Two chats for looking at the chat feed itself (T3 Code port S4, 29.10): a
 * finished turn with many steps (reads, a search, an edit, commands, a note
 * in between, the answer with code) and a turn still running with the
 * agent's latest thought. Shapes are the daemon's activities as OpenCode
 * reports them, so the real feed derives its rows from them. Demo only.
 */

const at = (base: number, seconds: number) => new Date(base + seconds * 1000).toISOString();

type Activity = {
  id: string;
  tone: "tool" | "info" | "error" | "approval";
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  turnId: string;
  createdAt: string;
};

function tool(
  id: string,
  turnId: string,
  createdAt: string,
  name: string,
  itemType: string,
  input: Record<string, unknown>,
  detail?: string,
): Activity {
  return {
    id,
    tone: "tool",
    kind: "tool.completed",
    summary: name,
    payload: {
      itemType,
      status: "completed",
      title: name,
      ...(detail || input.filePath
        ? { detail: detail ?? String(input.filePath).split("/").slice(-2).join("/") }
        : {}),
      // OpenCode's shape: the input sits under `state` (not read as changed
      // files); a write lists its file, a command carries its line.
      data: {
        tool: name,
        state: { status: "completed", input },
        ...(input.command ? { command: input.command } : {}),
        ...(itemType === "file_change" ? { files: [{ path: input.filePath }] } : {}),
      },
    },
    turnId,
    createdAt,
  };
}

function thought(id: string, turnId: string, createdAt: string, detail: string): Activity {
  return {
    id,
    tone: "info",
    kind: "task.progress",
    summary: "Reasoning update",
    payload: { taskId: `reasoning:${id}`, summary: "Thinking it through", detail },
    turnId,
    createdAt,
  };
}

const MODEL = { instanceId: "uno", model: "uno/smart" };

function thread(input: {
  id: string;
  projectId: string;
  title: string;
  messages: ReadonlyArray<Record<string, unknown>>;
  activities: ReadonlyArray<Activity>;
  turn: { turnId: string; startedAt: string; completedAt: string | null; answerId: string | null };
  updatedAt: string;
}) {
  const running = input.turn.completedAt === null;
  return {
    id: input.id,
    projectId: input.projectId,
    title: input.title,
    modelSelection: MODEL,
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: input.turn.turnId,
      state: running ? "running" : "completed",
      requestedAt: input.turn.startedAt,
      startedAt: input.turn.startedAt,
      completedAt: input.turn.completedAt,
      assistantMessageId: input.turn.answerId,
    },
    createdAt: input.messages[0]?.createdAt,
    updatedAt: input.updatedAt,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    settledOverride: null,
    settledAt: null,
    spawnedByThreadId: null,
    controller: "human",
    controlChangedAt: null,
    assistantRole: null,
    deletedAt: null,
    messages: input.messages,
    proposedPlans: [],
    activities: input.activities,
    checkpoints: [],
    session: {
      threadId: input.id,
      status: running ? "running" : "ready",
      providerName: "uno",
      providerInstanceId: "uno",
      runtimeMode: "full-access",
      activeTurnId: running ? input.turn.turnId : null,
      lastError: null,
      updatedAt: input.updatedAt,
    },
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: string,
  turnId: string | null,
  streaming = false,
) {
  return { id, role, text, turnId, streaming, createdAt, updatedAt: createdAt };
}

const ANSWER = `Fixed — the signup form now sends the welcome email.

The form posted to \`/api/signup\`, and the handler saved the person but never called the mailer. I added the call after the save and a test for it:

\`\`\`ts
const user = await saveUser(form);
await sendWelcomeEmail(user.email, { name: user.name });
return Response.json({ ok: true });
\`\`\`

All 14 tests pass. Try it on your site: sign up with your own address and the email should arrive within a minute.`;

const FILES_ANSWER = `Done, the launch report is in \`~/UnoWork/Reports/launch-report.md\` and the numbers behind it in ~/UnoWork/Reports/october-numbers.csv.

The page lives in \`/home/uno/projects/landing/web/index.html\`, and its styles are in web/styles.css. What changed:

- **The form:** \`app/signup/page.tsx\` and app/api/signup/route.ts:12
- **The mailer:** \`lib/mail.ts\`, its test is route.test.ts
- **The plan:** docs/launch-plan.md, and everything for the launch is in \`docs/\`

| File | What it is |
|---|---|
| \`README.md\` | How to run the site |
| \`Dockerfile\` | The container |
| \`.env.example\` | The settings it needs |

Open \`index.html\` to see the page. Your notes are in \`~/Documents/meeting notes.md\`.

These stay text: the \`/api/signup\` route, \`npm test\`, example.com, version 1.2.3, \`not-there.md\`, and/or, https://uno.place/developers, the signup 24/7.`;

/** The showcase chats for the page's own computer, in `projectId`. */
export function timelineShowcaseThreads(projectId: string, root: string) {
  const now = Date.now();
  // ── A finished turn: 2 min 10 s of work, folded under its answer ──
  const t0 = now - 26 * 60_000;
  const done = "showcase-done";
  const doneTurn = "turn-showcase-done-2";
  const file = (name: string) => `${root}/${name}`;
  const finished = thread({
    id: done,
    projectId,
    title: "Signup form doesn't send emails",
    messages: [
      message(`${done}-u1`, "user", "Hi! Can you look at my site's code?", at(t0, -600), null),
      message(
        `${done}-a1`,
        "assistant",
        "Sure — it's a small Next.js site with a signup form and a blog. What should I look at?",
        at(t0, -560),
        "turn-showcase-done-1",
      ),
      message(
        `${done}-u2`,
        "user",
        "The signup form doesn't send the welcome email. Can you fix it?",
        at(t0, 0),
        null,
      ),
      message(
        `${done}-a2`,
        "assistant",
        "The form posts to `/api/signup`, but the handler never calls the mailer. I'll add the call and a test.",
        at(t0, 48),
        doneTurn,
      ),
      message(`${done}-a3`, "assistant", ANSWER, at(t0, 130), doneTurn),
    ],
    activities: [
      thought(
        `${done}-th1`,
        doneTurn,
        at(t0, 6),
        "…a form that doesn't send mail is usually the handler. Let me read the form and its route first.",
      ),
      tool(`${done}-r1`, doneTurn, at(t0, 9), "read", "dynamic_tool_call", {
        filePath: file("app/signup/page.tsx"),
      }),
      tool(`${done}-r2`, doneTurn, at(t0, 13), "read", "dynamic_tool_call", {
        filePath: file("app/api/signup/route.ts"),
      }),
      tool(`${done}-g1`, doneTurn, at(t0, 19), "grep", "dynamic_tool_call", {
        pattern: "sendWelcomeEmail",
      }),
      tool(`${done}-r3`, doneTurn, at(t0, 25), "read", "dynamic_tool_call", {
        filePath: file("lib/mail.ts"),
      }),
      tool(`${done}-e1`, doneTurn, at(t0, 62), "edit", "file_change", {
        filePath: file("app/api/signup/route.ts"),
      }),
      tool(`${done}-e2`, doneTurn, at(t0, 78), "write", "file_change", {
        filePath: file("app/api/signup/route.test.ts"),
      }),
      tool(
        `${done}-c1`,
        doneTurn,
        at(t0, 101),
        "bash",
        "command_execution",
        { command: "npm test" },
        "14 passed",
      ),
      tool(
        `${done}-c2`,
        doneTurn,
        at(t0, 118),
        "bash",
        "command_execution",
        { command: "npm run lint" },
        "No problems",
      ),
    ],
    turn: {
      turnId: doneTurn,
      startedAt: at(t0, 0),
      completedAt: at(t0, 130),
      answerId: `${done}-a3`,
    },
    updatedAt: at(t0, 130),
  });

  // ── A turn still running: steps so far + the latest thought ──
  const t1 = now - 75_000;
  const live = "showcase-live";
  const liveTurn = "turn-showcase-live-1";
  const running = thread({
    id: live,
    projectId,
    title: "Thank-you page after signup",
    messages: [
      message(
        `${live}-u1`,
        "user",
        "After someone signs up, show a thank-you page with a link back to the blog.",
        at(t1, 0),
        null,
      ),
    ],
    activities: [
      tool(`${live}-r1`, liveTurn, at(t1, 8), "read", "dynamic_tool_call", {
        filePath: file("app/signup/page.tsx"),
      }),
      tool(`${live}-r2`, liveTurn, at(t1, 12), "read", "dynamic_tool_call", {
        filePath: file("app/layout.tsx"),
      }),
      tool(`${live}-g1`, liveTurn, at(t1, 17), "glob", "dynamic_tool_call", {
        pattern: "app/**/page.tsx",
      }),
      tool(`${live}-e1`, liveTurn, at(t1, 40), "write", "file_change", {
        filePath: file("app/thanks/page.tsx"),
      }),
      thought(
        `${live}-th1`,
        liveTurn,
        at(t1, 58),
        "…the page itself is done and uses the blog's layout. Now the form has to go there after a successful signup instead of showing the alert. The router",
      ),
    ],
    turn: { turnId: liveTurn, startedAt: at(t1, 0), completedAt: null, answerId: null },
    updatedAt: at(t1, 58),
  });

  // ── A turn waiting for an OK on a step ──
  const t2 = now - 40_000;
  const ask = "showcase-ask";
  const askTurn = "turn-showcase-ask-1";
  const asking = thread({
    id: ask,
    projectId,
    title: "Send emails with a real mailer",
    messages: [
      message(
        `${ask}-u1`,
        "user",
        "Use a real mail service for the welcome email instead of the console log.",
        at(t2, 0),
        null,
      ),
    ],
    activities: [
      tool(`${ask}-r1`, askTurn, at(t2, 6), "read", "dynamic_tool_call", {
        filePath: file("lib/mail.ts"),
      }),
      tool(`${ask}-r2`, askTurn, at(t2, 9), "read", "dynamic_tool_call", {
        filePath: file("package.json"),
      }),
      {
        id: `${ask}-approval`,
        tone: "approval",
        kind: "approval.requested",
        summary: "Waiting for your OK",
        payload: {
          requestId: `${ask}-request`,
          requestKind: "command",
          detail: "npm install nodemailer",
        },
        turnId: askTurn,
        createdAt: at(t2, 14),
      },
    ],
    turn: { turnId: askTurn, startedAt: at(t2, 0), completedAt: null, answerId: null },
    updatedAt: at(t2, 14),
  });

  // ── An answer that names files every way an agent does (Misha 30.10) ──
  const t3 = now - 12 * 60_000;
  const files = "showcase-files";
  const filesTurn = "turn-showcase-files-1";
  const naming = thread({
    id: files,
    projectId,
    title: "Launch report and the page",
    messages: [
      message(
        `${files}-u1`,
        "user",
        "Put together the launch report and tell me where everything is.",
        at(t3, 0),
        null,
      ),
      message(`${files}-a1`, "assistant", FILES_ANSWER, at(t3, 79), filesTurn),
    ],
    activities: [
      tool(`${files}-r1`, filesTurn, at(t3, 9), "read", "dynamic_tool_call", {
        filePath: file("web/index.html"),
      }),
      tool(`${files}-w1`, filesTurn, at(t3, 40), "write", "file_change", {
        filePath: "/home/uno/UnoWork/Reports/launch-report.md",
      }),
    ],
    turn: { turnId: filesTurn, startedAt: at(t3, 0), completedAt: at(t3, 79), answerId: `${files}-a1` },
    updatedAt: at(t3, 79),
  });

  return [running, finished, asking, naming];
}
