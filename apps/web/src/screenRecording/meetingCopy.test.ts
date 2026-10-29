import { describe, expect, it, vi } from "vitest";

import {
  buildMeetingCopy,
  copyToMeetings,
  meetingFolderName,
  meetingSegments,
  newMeetingId,
} from "./meetingCopy";
import { INITIAL_SAVE, INITIAL_WATCH, type RecordingItem, fileRecordingMeeting } from "./pipeline";

const TIMELINE = [
  { t: 4, say: "Вот тут криво.", see: "the Save button sits below the form", do: "clicked Save" },
  { t: 0, say: "Это страница настроек.", see: "Acme CRM, Settings", do: "" },
  { t: 9, say: "", see: "a toast 'Saved'", do: "" },
  { t: 11, say: "", see: "", do: "" },
];

const INPUT = {
  id: "abc123def4",
  createdAt: new Date(2026, 9, 29, 14, 2, 11),
  durationMs: 12_400,
  width: 1280,
  height: 800,
  driveKey: "Recordings/Screen recording 2026-10-29 at 14.02.11.webm",
  shareUrl: "https://console.uno.place/api/v1/drive/d/tok",
  shareExpiresAt: "2026-11-05T11:02:11Z",
  speech: "Это страница настроек. Вот тут криво.",
  visual: "Settings page",
  timeline: TIMELINE,
};

describe("meetingSegments", () => {
  it("turns the timeline into Notetaker lines in order, without empty moments", () => {
    expect(meetingSegments(TIMELINE, "", "", 12)).toEqual([
      {
        start: 0,
        end: 4,
        speaker: "Me",
        text: "Это страница настроек.",
        screen: "Acme CRM, Settings",
        did: "",
      },
      {
        start: 4,
        end: 9,
        speaker: "Me",
        text: "Вот тут криво.",
        screen: "the Save button sits below the form",
        did: "clicked Save",
      },
      { start: 9, end: 12, speaker: "", text: "", screen: "a toast 'Saved'", did: "" },
    ]);
  });

  it("falls back to the whole speech without a timeline (older gateway)", () => {
    expect(meetingSegments([], " Сделай кнопку синей ", "Settings page", 30)).toEqual([
      {
        start: 0,
        end: 30,
        speaker: "Me",
        text: "Сделай кнопку синей",
        screen: "Settings page",
        did: "",
      },
    ]);
    expect(meetingSegments([], "", "", 30)).toEqual([]);
  });
});

describe("buildMeetingCopy", () => {
  it("writes the folder Notetaker reads, meeting.json last", () => {
    const copy = buildMeetingCopy(INPUT)!;
    expect(copy.folder).toBe(meetingFolderName(INPUT.createdAt));
    expect(copy.folder).toBe("2026-10-29 14-02 Screen recording");
    expect(copy.files.map((f) => f.name)).toEqual([
      "transcript.json",
      "transcript.md",
      "meeting.json",
    ]);
    const meeting = JSON.parse(copy.files[2]!.contents);
    expect(meeting).toMatchObject({
      id: "abc123def4",
      title: "",
      source: "screen",
      template: "screen",
      status: "summarizing",
      duration: 12,
      folder: "2026-10-29 14-02 Screen recording",
      screen: {
        drive_key: INPUT.driveKey,
        share_url: INPUT.shareUrl,
        share_expires_at: INPUT.shareExpiresAt,
        width: 1280,
        height: 800,
        from: "uno-work",
      },
    });
    expect(meeting.created_at).toMatch(/^2026-10-29T14:02:11[+-]\d\d:\d\d$/);
    const md = copy.files[1]!.contents;
    expect(md).toContain("**[00:04]** Me: Вот тут криво.");
    expect(md).toContain("_On screen: the Save button sits below the form_  \n_Did: clicked Save_");
  });

  it("is nothing when nothing was said or seen", () => {
    expect(buildMeetingCopy({ ...INPUT, timeline: [], speech: "", visual: "" })).toBeNull();
  });
});

describe("newMeetingId", () => {
  it("is 10 of [a-z0-9] (Notetaker's id)", () => {
    for (let i = 0; i < 50; i++) expect(newMeetingId()).toMatch(/^[a-z0-9]{10}$/);
    expect(newMeetingId(() => 0.999999)).toBe("9999999999");
  });
});

describe("copyToMeetings", () => {
  function deps(existing: string[]) {
    const writes: Array<{ cwd: string; relativePath: string; contents: string }> = [];
    return {
      writes,
      deps: {
        homePath: async () => "/home/unowork/",
        folderExists: async (path: string) => existing.includes(path),
        writeFile: vi.fn(async (input: { cwd: string; relativePath: string; contents: string }) => {
          writes.push(input);
        }),
      },
    };
  }

  it("writes nothing without ~/Meetings (no Notetaker)", async () => {
    const { deps: d, writes } = deps([]);
    expect(await copyToMeetings(INPUT, d)).toBeNull();
    expect(writes).toEqual([]);
  });

  it("writes into ~/Meetings, a second folder of the same minute gets (2)", async () => {
    const { deps: d, writes } = deps([
      "/home/unowork/Meetings",
      "/home/unowork/Meetings/2026-10-29 14-02 Screen recording",
    ]);
    expect(await copyToMeetings(INPUT, d)).toBe("Meetings/2026-10-29 14-02 Screen recording (2)");
    expect(writes.map((w) => w.relativePath)).toEqual([
      "Meetings/2026-10-29 14-02 Screen recording (2)/transcript.json",
      "Meetings/2026-10-29 14-02 Screen recording (2)/transcript.md",
      "Meetings/2026-10-29 14-02 Screen recording (2)/meeting.json",
    ]);
    expect(writes.every((w) => w.cwd === "/home/unowork")).toBe(true);
    expect(JSON.parse(writes[2]!.contents).folder).toBe("2026-10-29 14-02 Screen recording (2)");
  });
});

describe("fileRecordingMeeting", () => {
  function recording(overrides: Partial<RecordingItem> = {}): RecordingItem {
    return {
      id: "rec1",
      threadKey: "thread-1",
      environmentId: "env-1",
      name: "Screen recording 2026-10-29 at 14.02.11.webm",
      mimeType: "video/webm",
      sizeBytes: 10,
      durationMs: 12_400,
      blob: new Blob(["x"]),
      previewUrl: "blob:preview",
      agentParts: [],
      agentCopyMimeType: null,
      hasVoice: true,
      width: 1280,
      height: 800,
      events: [],
      liveFrames: [],
      createdAt: "2026-10-29T11:02:11Z",
      save: {
        ...INITIAL_SAVE,
        status: "done",
        driveKey: INPUT.driveKey,
        shareUrl: INPUT.shareUrl,
        shareExpiresAt: INPUT.shareExpiresAt,
      },
      watch: { ...INITIAL_WATCH, status: "done", speech: INPUT.speech, timeline: TIMELINE },
      prefilled: false,
      ...overrides,
    };
  }

  function pipelineDeps(folderExists?: (path: string) => Promise<boolean>) {
    const writeFile = vi.fn(async () => undefined);
    return {
      writeFile,
      deps: {
        homePath: async () => "/home/unowork",
        writeFile,
        driveState: vi.fn(),
        copyToCloud: vi.fn(),
        shareCreate: vi.fn(),
        describe: vi.fn(),
        removePaths: vi.fn(),
        deleteCloud: vi.fn(),
        ...(folderExists ? { folderExists } : {}),
      },
    };
  }

  it("files a saved and watched recording", async () => {
    const { deps, writeFile } = pipelineDeps(async (p) => p === "/home/unowork/Meetings");
    const folder = await fileRecordingMeeting(recording(), deps, () => "abc123def4");
    expect(folder).toMatch(/^Meetings\/2026-10-29 \d\d-02 Screen recording$/);
    expect(writeFile).toHaveBeenCalledTimes(3);
  });

  it("waits for both steps, and never fails the recording", async () => {
    const { deps, writeFile } = pipelineDeps(async () => true);
    expect(
      await fileRecordingMeeting(
        recording({ watch: { ...INITIAL_WATCH, status: "failed" } }),
        deps,
      ),
    ).toBeNull();
    expect(
      await fileRecordingMeeting(recording({ save: { ...INITIAL_SAVE, status: "running" } }), deps),
    ).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
    writeFile.mockRejectedValueOnce(new Error("disk full"));
    const failing = pipelineDeps(async (p) => p.endsWith("/Meetings"));
    failing.writeFile.mockRejectedValueOnce(new Error("disk full"));
    expect(await fileRecordingMeeting(recording(), failing.deps)).toBeNull();
  });

  it("does nothing on a Work without folderExists (older runtime)", async () => {
    const { deps, writeFile } = pipelineDeps();
    expect(await fileRecordingMeeting(recording(), deps)).toBeNull();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
