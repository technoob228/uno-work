/**
 * Automations from any chat (29.10, T3's `schedule_task` & co.): the
 * `uno-work` tools `automation_create`, `automations_list`,
 * `automation_update`, `automation_delete`, `automation_run_now`.
 *
 * "Do this every day at 9" in a chat → `automation_create`: by default the
 * chat itself runs it (each run is a new message here, with this chat's
 * context, model and mode); `runIn: "new_chat"` opens a new chat in this
 * project for every run. In an assistant's own conversation the assistant
 * runs it (as `uno-manager`'s automation_create). A chat sees and changes
 * only the automations it runs; `automations_list {scope: "all"}` reads
 * every one on the computer.
 *
 * The console keeps them and wakes the computer when one is due
 * (`AutomationsService`, `eventLoop.ts`).
 *
 * @module automations/chatTools
 */
import {
  AUTOMATION_INSTRUCTION_MAX_CHARS,
  AUTOMATION_NAME_MAX_CHARS,
  describeAutomationTrigger,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { ObjectSchema } from "../unoWork/argsSchema.ts";
import type { AutomationChatTools } from "./AutomationsService.ts";

export const AUTOMATION_CHAT_TOOL_NAMES = [
  "automation_create",
  "automations_list",
  "automation_update",
  "automation_delete",
  "automation_run_now",
] as const;

/** What the tools need from `uno-work`'s deps (narrow: no import cycle). */
export interface AutomationChatToolDeps {
  /** Bound to the calling chat. Absent: this Uno Work has no automations wiring. */
  readonly automations?: AutomationChatTools;
}

export interface AutomationChatToolKit<E> {
  readonly fail: (message: string) => E;
}

const UNAVAILABLE =
  "Automations aren't available in this Uno Work. Tell the person what you wanted to set up; don't use cron, systemd timers or a sleep loop.";

const TRIGGER_SCHEMA = {
  type: "object",
  description:
    'When it runs. On a schedule: {"kind":"schedule","cron":"0 9 * * 1-5","timezone":"Europe/Berlin","label":"Weekdays at 09:00"} — a five-field cron (day of week 0 = Sunday; at most every 15 minutes: "*/30 * * * *" = every 30 minutes, "0 9 * * 1,3,5" = Mon, Wed, Fri at 9), the person\'s IANA time zone (ask if unknown) and the same in words. When a pull request opens or updates in a GitHub repository: {"kind":"github.pull_request","repo":"owner/name"}. When another service calls a secret URL: {"kind":"webhook"} (only for a chat, not an assistant; the person copies the URL from the Automations page; you never see it).',
  properties: {
    kind: { type: "string", enum: ["schedule", "github.pull_request", "webhook"] },
    cron: { type: "string" },
    timezone: { type: "string" },
    label: { type: "string" },
    repo: { type: "string", description: "owner/name" },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

const ID_SCHEMA = { type: "integer", minimum: 1, description: "From automations_list." } as const;

const str = (args: Record<string, unknown>, key: string): string =>
  typeof args[key] === "string" ? (args[key] as string) : "";

function triggerWords(args: Record<string, unknown>): string {
  const trigger = args["trigger"];
  if (typeof trigger !== "object" || trigger === null) return "";
  const t = trigger as Record<string, unknown>;
  if (t["kind"] === "schedule")
    return typeof t["label"] === "string" ? t["label"] : "on a schedule";
  if (t["kind"] === "github.pull_request" && typeof t["repo"] === "string") {
    return describeAutomationTrigger({ kind: "github.pull_request", repo: t["repo"] });
  }
  if (t["kind"] === "webhook") return describeAutomationTrigger({ kind: "webhook" });
  return "";
}

/** A public URL that starts work here: the person allows it, whatever the mode. */
const triggerLevel = (args: Record<string, unknown>) => {
  const trigger = args["trigger"];
  return typeof trigger === "object" &&
    trigger !== null &&
    (trigger as Record<string, unknown>)["kind"] === "webhook"
    ? ("sensitive" as const)
    : ("change" as const);
};

/** The tool definitions; `kit.fail` makes `uno-work`'s own tool error. */
export function automationChatTools<E>(kit: AutomationChatToolKit<E>) {
  const withTools = <A>(
    deps: AutomationChatToolDeps,
    run: (tools: AutomationChatTools) => Effect.Effect<A, { readonly message: string }>,
  ): Effect.Effect<A, E> =>
    deps.automations === undefined
      ? Effect.fail(kit.fail(UNAVAILABLE))
      : run(deps.automations).pipe(Effect.mapError((error) => kit.fail(error.message)));

  return [
    {
      name: "automation_create",
      group: "chats" as const,
      description:
        'Set up an automation: work that repeats on a schedule ("every weekday at 9 …", "every 30 minutes …", "Mon, Wed, Fri …") or every time a pull request opens or updates in a GitHub repository. Use it — never cron, systemd timers, `sleep` loops or a background script — whenever the person asks for something regular. ' +
        "A form on a site that should start work: site_forms_set {chat}, not this. " +
        "By default THIS chat runs it: each run arrives here as a new message (with this chat's context) and you do the work; runIn: \"new_chat\" opens a fresh chat in this project for every run instead. Uno keeps it and wakes this cloud computer when it's due. " +
        "Write `instruction` self-contained: what to do each time. Returns `tell`: say it to the person in one line.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            maxLength: AUTOMATION_NAME_MAX_CHARS,
            description: 'Short name the person sees, e.g. "Morning summary".',
          },
          instruction: {
            type: "string",
            minLength: 1,
            maxLength: AUTOMATION_INSTRUCTION_MAX_CHARS,
            description: "What to do each time it runs.",
          },
          trigger: TRIGGER_SCHEMA,
          runIn: {
            type: "string",
            enum: ["this_chat", "new_chat"],
            description: "Default this_chat.",
          },
          enabled: { type: "boolean" },
        },
        required: ["instruction", "trigger"],
        additionalProperties: false,
      } satisfies ObjectSchema,
      level: triggerLevel,
      approvalTitle: (args: Record<string, unknown>) => {
        const when = triggerWords(args);
        return `Set up an automation${when ? ` — ${when}` : ""}: “${(str(args, "name") || str(args, "instruction")).slice(0, 80)}”`;
      },
      run: (deps: AutomationChatToolDeps, args: Record<string, unknown>) =>
        withTools(deps, (tools) => tools.create(args)),
    },
    {
      name: "automations_list",
      group: "chats" as const,
      description:
        "The automations this chat runs (id, name, when in words, instruction, on/off, status, next and last run). scope: \"all\" lists every automation on this computer (assistants' and other chats' too). Check it before creating one so you don't duplicate.",
      inputSchema: {
        type: "object",
        properties: { scope: { type: "string", enum: ["this_chat", "all"] } },
        additionalProperties: false,
      } satisfies ObjectSchema,
      level: "safe" as const,
      run: (deps: AutomationChatToolDeps, args: Record<string, unknown>) =>
        withTools(deps, (tools) => tools.list(args)),
    },
    {
      name: "automation_update",
      group: "chats" as const,
      description:
        "Change one of this chat's automations by id: pause or resume it (enabled), rename it, change the instruction or when it runs.",
      inputSchema: {
        type: "object",
        properties: {
          id: ID_SCHEMA,
          enabled: { type: "boolean" },
          name: { type: "string", maxLength: AUTOMATION_NAME_MAX_CHARS },
          instruction: { type: "string", maxLength: AUTOMATION_INSTRUCTION_MAX_CHARS },
          trigger: TRIGGER_SCHEMA,
        },
        required: ["id"],
        additionalProperties: false,
      } satisfies ObjectSchema,
      level: triggerLevel,
      approvalTitle: (args: Record<string, unknown>) =>
        args["enabled"] === false
          ? `Pause automation ${String(args["id"])}`
          : `Change automation ${String(args["id"])}`,
      run: (deps: AutomationChatToolDeps, args: Record<string, unknown>) =>
        withTools(deps, (tools) => tools.update(args)),
    },
    {
      name: "automation_delete",
      group: "chats" as const,
      description:
        "Delete one of this chat's automations by id, when the person wants it gone for good (to pause: automation_update enabled: false).",
      inputSchema: {
        type: "object",
        properties: { id: ID_SCHEMA },
        required: ["id"],
        additionalProperties: false,
      } satisfies ObjectSchema,
      level: "change" as const,
      approvalTitle: (args: Record<string, unknown>) => `Delete automation ${String(args["id"])}`,
      run: (deps: AutomationChatToolDeps, args: Record<string, unknown>) =>
        withTools(deps, (tools) => tools.remove(args)),
    },
    {
      name: "automation_run_now",
      group: "chats" as const,
      description:
        "Run one of this chat's automations now, once (its schedule doesn't change). The run arrives as a new message where it runs.",
      inputSchema: {
        type: "object",
        properties: { id: ID_SCHEMA },
        required: ["id"],
        additionalProperties: false,
      } satisfies ObjectSchema,
      level: "change" as const,
      approvalTitle: (args: Record<string, unknown>) => `Run automation ${String(args["id"])} now`,
      run: (deps: AutomationChatToolDeps, args: Record<string, unknown>) =>
        withTools(deps, (tools) => tools.runNow(args)),
    },
  ];
}
