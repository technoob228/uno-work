import { describe, expect, it } from "@effect/vitest";

import {
  isRelayCredential,
  parseRelayCredential,
  redactConnectorSecrets,
  relayCredential,
  slackFileRequest,
  slackRelayApiBase,
  slackRelayEventsUrl,
  slackUploadTarget,
  telegramApiUrl,
  telegramFileUrl,
} from "./channelRelay.ts";

const CONSOLE = "https://console.example.test";
const TGR = "tgr_0123456789abcdef0123456789abcdef";
const SLR = "slr_fedcba9876543210fedcba9876543210";

describe("relay credentials", () => {
  it("recognises only `unorelay:<token>` as a relay credential", () => {
    expect(parseRelayCredential(relayCredential(TGR))).toBe(TGR);
    expect(isRelayCredential(`unorelay:${SLR}`)).toBe(true);
    expect(parseRelayCredential("123456:ABC-own-bot")).toBeNull();
    expect(parseRelayCredential("xoxb-1-2-3")).toBeNull();
    expect(parseRelayCredential("unorelay:")).toBeNull();
  });
});

describe("Telegram URLs", () => {
  it("talks to api.telegram.org with an own bot token", () => {
    expect(telegramApiUrl("123:own", "getUpdates", CONSOLE)).toBe(
      "https://api.telegram.org/bot123:own/getUpdates",
    );
    expect(telegramFileUrl("123:own", "voice/file_1.oga", CONSOLE)).toBe(
      "https://api.telegram.org/file/bot123:own/voice/file_1.oga",
    );
  });

  it("talks to the console's Bot-API mirror in relay mode", () => {
    const credential = relayCredential(TGR);
    expect(telegramApiUrl(credential, "sendMessage", CONSOLE)).toBe(
      `${CONSOLE}/api/v1/work-relay/telegram/bot${TGR}/sendMessage`,
    );
    expect(telegramApiUrl(credential, "unoRegisterStartCode", CONSOLE)).toBe(
      `${CONSOLE}/api/v1/work-relay/telegram/bot${TGR}/unoRegisterStartCode`,
    );
    expect(telegramFileUrl(credential, "photos/file_2.jpg", CONSOLE)).toBe(
      `${CONSOLE}/api/v1/work-relay/telegram/file/bot${TGR}/photos/file_2.jpg`,
    );
  });
});

describe("Slack URLs", () => {
  it("builds the Web-API base, the events long poll and the file/upload proxies", () => {
    expect(slackRelayApiBase(SLR, CONSOLE)).toBe(`${CONSOLE}/api/v1/work-relay/slack/${SLR}/api/`);
    expect(slackRelayEventsUrl(SLR, "42", 25, CONSOLE)).toBe(
      `${CONSOLE}/api/v1/work-relay/slack/${SLR}/events?after=42&wait=25`,
    );
    const fileUrl = "https://files.slack.com/files-pri/T1-F1/download/a b.png";
    expect(slackFileRequest(relayCredential(SLR), fileUrl, CONSOLE)).toEqual({
      url: `${CONSOLE}/api/v1/work-relay/slack/${SLR}/file?url=${encodeURIComponent(fileUrl).replace(/%20/g, "+")}`,
      headers: {},
    });
    const uploadUrl = "https://files.slack.com/upload/v1/abc?x=1";
    expect(slackUploadTarget(relayCredential(SLR), uploadUrl, CONSOLE)).toBe(
      `${CONSOLE}/api/v1/work-relay/slack/${SLR}/upload?url=${encodeURIComponent(uploadUrl)}`,
    );
  });

  it("keeps the direct Slack path for own tokens", () => {
    const fileUrl = "https://files.slack.com/files-pri/T1-F1/download/x.png";
    expect(slackFileRequest("xoxb-own", fileUrl, CONSOLE)).toEqual({
      url: fileUrl,
      headers: { authorization: "Bearer xoxb-own" },
    });
    expect(slackUploadTarget("xoxb-own", "https://files.slack.com/upload/v1/abc", CONSOLE)).toBe(
      "https://files.slack.com/upload/v1/abc",
    );
  });
});

describe("redactConnectorSecrets", () => {
  it("never lets a bot or relay token through", () => {
    const text = [
      `GET ${CONSOLE}/api/v1/work-relay/telegram/bot${TGR}/getUpdates failed`,
      "https://api.telegram.org/bot123:own-secret/getMe",
      `stored unorelay:${SLR}`,
      `bare ${SLR}`,
    ].join("\n");
    const redacted = redactConnectorSecrets(text);
    expect(redacted).not.toContain(TGR);
    expect(redacted).not.toContain(SLR);
    expect(redacted).not.toContain("own-secret");
  });
});
