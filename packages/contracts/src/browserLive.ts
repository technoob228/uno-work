/**
 * Live view of the machine's own browser.
 *
 * On a Work machine in the cloud the browser lives where the agent lives — on
 * the machine. The app does not get a second browser: it gets the picture of
 * that one (a CDP screencast) and can drive it after the person explicitly
 * takes control. While the person is in control the agent's commands wait;
 * the agent can ask for the person (`requestHelp`) and waits until the
 * browser is handed back.
 */
import { Schema } from "effect";

import { NonNegativeInt } from "./baseSchemas.ts";
import { BrowserBridgeRequestContext } from "./server.ts";

/** Who drives the page right now. */
export const BrowserLiveControl = Schema.Literals(["agent", "human"]);
export type BrowserLiveControl = typeof BrowserLiveControl.Type;

/** Where this browser runs — shown on every live tab. */
export const BrowserLiveLocation = Schema.Struct({
  /** Host name of the machine (the Work computer's name on a box). */
  machine: Schema.String,
  /** Public address sites see; null until known or when lookup failed. */
  publicIp: Schema.NullOr(Schema.String),
  /** `headful` = a real window on a virtual display (sites can't tell it's automated as easily). */
  display: Schema.Literals(["headful", "headless"]),
  /** Browser process is up right now. */
  running: Schema.Boolean,
});
export type BrowserLiveLocation = typeof BrowserLiveLocation.Type;

export const BrowserLiveHelpRequest = Schema.Struct({
  reason: Schema.String,
  requestedAt: Schema.String,
});
export type BrowserLiveHelpRequest = typeof BrowserLiveHelpRequest.Type;

export const BrowserLivePage = Schema.Struct({
  pageId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  context: Schema.optional(BrowserBridgeRequestContext),
  control: BrowserLiveControl,
  help: Schema.NullOr(BrowserLiveHelpRequest),
  /**
   * Bumped when the agent opens a page or asks for help: the app brings the
   * tab to the front on a bump, and leaves a tab the person closed alone
   * otherwise.
   */
  attention: NonNegativeInt,
  /** The agent has a command waiting for the person to hand the browser back. */
  agentWaiting: Schema.Boolean,
  width: NonNegativeInt,
  height: NonNegativeInt,
});
export type BrowserLivePage = typeof BrowserLivePage.Type;

export const BrowserLiveState = Schema.Struct({
  /**
   * The agents of this machine browse here (a machine in the cloud). The app
   * then opens pages for its chats in this browser instead of its own panel.
   */
  agentsBrowseHere: Schema.Boolean,
  location: BrowserLiveLocation,
  pages: Schema.Array(BrowserLivePage),
});
export type BrowserLiveState = typeof BrowserLiveState.Type;

/** One JPEG frame of a page. `data` is base64 without the data: prefix. */
export const BrowserLiveFrame = Schema.Struct({
  pageId: Schema.String,
  data: Schema.String,
  /** CSS pixels of the page the frame shows — input coordinates use these. */
  width: NonNegativeInt,
  height: NonNegativeInt,
});
export type BrowserLiveFrame = typeof BrowserLiveFrame.Type;

export const BrowserLiveModifiers = Schema.Struct({
  alt: Schema.optional(Schema.Boolean),
  ctrl: Schema.optional(Schema.Boolean),
  meta: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
});
export type BrowserLiveModifiers = typeof BrowserLiveModifiers.Type;

export const BrowserLiveInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mouse"),
    action: Schema.Literals(["move", "down", "up"]),
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
    clickCount: Schema.optional(NonNegativeInt),
    modifiers: Schema.optional(BrowserLiveModifiers),
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    x: Schema.Number,
    y: Schema.Number,
    deltaX: Schema.Number,
    deltaY: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    /** DOM `KeyboardEvent.key`. */
    key: Schema.String,
    /** DOM `KeyboardEvent.code`. */
    code: Schema.optional(Schema.String),
    modifiers: Schema.optional(BrowserLiveModifiers),
  }),
  /** Paste / IME: text inserted as is. */
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
]);
export type BrowserLiveInputEvent = typeof BrowserLiveInputEvent.Type;

export const BrowserLiveFramesInput = Schema.Struct({ pageId: Schema.String });
export type BrowserLiveFramesInput = typeof BrowserLiveFramesInput.Type;

export const BrowserLiveInputPayload = Schema.Struct({
  pageId: Schema.String,
  event: BrowserLiveInputEvent,
});
export type BrowserLiveInputPayload = typeof BrowserLiveInputPayload.Type;

export const BrowserLiveSetControlInput = Schema.Struct({
  pageId: Schema.String,
  control: BrowserLiveControl,
});
export type BrowserLiveSetControlInput = typeof BrowserLiveSetControlInput.Type;

export const BrowserLiveNavigateInput = Schema.Struct({
  pageId: Schema.String,
  action: Schema.Literals(["goto", "back", "forward", "reload"]),
  url: Schema.optional(Schema.String),
});
export type BrowserLiveNavigateInput = typeof BrowserLiveNavigateInput.Type;

/**
 * The person opens a page in the machine's browser for a chat (the "+" menu).
 * An empty `url` opens a blank page to type an address into.
 */
export const BrowserLiveOpenInput = Schema.Struct({
  context: BrowserBridgeRequestContext,
  url: Schema.String,
});
export type BrowserLiveOpenInput = typeof BrowserLiveOpenInput.Type;

export const BrowserLiveOpenResult = Schema.Struct({ pageId: Schema.String });
export type BrowserLiveOpenResult = typeof BrowserLiveOpenResult.Type;

export const BrowserLiveCloseInput = Schema.Struct({ pageId: Schema.String });
export type BrowserLiveCloseInput = typeof BrowserLiveCloseInput.Type;

export class BrowserLiveError extends Schema.TaggedErrorClass<BrowserLiveError>()(
  "BrowserLiveError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
