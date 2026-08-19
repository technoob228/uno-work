import { assert, it } from "@effect/vitest";

import {
  emptyFrameMessage,
  isEmptyFrameError,
  isEmptyScreenshot,
  isEmptyScreenshotResultData,
  pngDataUrl,
  screenshotBytes,
  PNG_DATA_URL_PREFIX,
} from "./browserScreenshot.ts";

/** 1×1 прозрачный PNG — минимальный настоящий кадр. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

it("treats a payload-less data URL as an empty frame", () => {
  assert.equal(screenshotBytes(PNG_DATA_URL_PREFIX), 0);
  assert.isTrue(isEmptyScreenshot(PNG_DATA_URL_PREFIX));
  assert.isTrue(isEmptyScreenshot(undefined));
  assert.isTrue(isEmptyScreenshot(""));
});

it("accepts a real PNG and reports its size in bytes", () => {
  const dataUrl = pngDataUrl(TINY_PNG_BASE64);
  assert.isFalse(isEmptyScreenshot(dataUrl));
  assert.equal(screenshotBytes(dataUrl), Buffer.from(TINY_PNG_BASE64, "base64").length);
});

it("recognises its own empty-frame message", () => {
  const message = emptyFrameMessage({ capturedBy: "panel", attempts: 3, bytes: 0 });
  assert.isTrue(isEmptyFrameError(message));
  assert.isFalse(isEmptyFrameError("Browser command timed out after 30000ms."));
  assert.isFalse(isEmptyFrameError(undefined));
});

it("spots an ok result whose dataUrl is blank", () => {
  assert.isTrue(isEmptyScreenshotResultData({ dataUrl: PNG_DATA_URL_PREFIX }));
  assert.isFalse(isEmptyScreenshotResultData({ dataUrl: pngDataUrl(TINY_PNG_BASE64) }));
  assert.isFalse(isEmptyScreenshotResultData({ url: "https://example.com/" }));
  assert.isFalse(isEmptyScreenshotResultData(null));
});
