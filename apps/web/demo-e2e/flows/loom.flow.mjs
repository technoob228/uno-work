// Loom Work flows on the demo build: the real composer and recorder in
// Chrome with fake camera/mic and an auto-picked screen.
import { composer, flow, openDemo, openDemoHome, startRecording } from "../harness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPEECH = "On the pricing page, put the Pro card first";

async function cardStatus(page, step) {
  return page.getByTestId(`recording-${step}`).getAttribute("data-status");
}

async function waitStatus(page, step, status, timeout = 20_000) {
  await page
    .locator(`[data-testid="recording-${step}"][data-status="${status}"]`)
    .waitFor({ timeout });
}

/** Wraps getDisplayMedia/getUserMedia so a flow can end the share or refuse a device. */
async function instrumentMedia(page, { refuse = [] } = {}) {
  await page.addInitScript((refused) => {
    const md = navigator.mediaDevices;
    const display = md.getDisplayMedia.bind(md);
    const user = md.getUserMedia.bind(md);
    md.getDisplayMedia = async (constraints) => {
      if (refused.includes("screen")) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      const stream = await display(constraints);
      window.__lastDisplay = stream;
      return stream;
    };
    md.getUserMedia = async (constraints) => {
      if (constraints?.video && refused.includes("camera")) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      if (constraints?.audio && refused.includes("microphone")) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      return user(constraints);
    };
  }, refuse);
}

export const flows = [
  flow("main-record-watch-send", async ({ page, url, step, shot }) => {
    await step("open the chat", () => openDemo(page, url));
    await shot("chat");
    await step("open the Record popover", async () => {
      await page.getByTestId("record-button").first().click();
      await page.getByTestId("record-popup").waitFor();
      await sleep(400);
    });
    await shot("record-popover");
    await page.keyboard.press("Escape");
    await step("start: screen + camera + mic", () => startRecording(page));
    await sleep(2500);
    await shot("recording-bar");
    await step("pause and resume", async () => {
      await page.getByTestId("recording-pause").click();
      await page.locator('[data-testid="recording-bar"][data-phase="paused"]').waitFor();
      await sleep(1500);
      await shot("paused");
      await page.getByTestId("recording-pause").click();
      await page.locator('[data-testid="recording-bar"][data-phase="recording"]').waitFor();
    });
    await sleep(2500);
    await step("Done", () => page.getByTestId("recording-stop").click());
    await step("card appears and saves", async () => {
      await page.getByTestId("recording-composer-card").waitFor({ timeout: 15_000 });
      await shot("card-working");
      await waitStatus(page, "save", "done");
      await waitStatus(page, "watch", "done");
    });
    await step("words are in the box", async () => {
      await page.waitForFunction(
        (text) => document.querySelector('[contenteditable="true"]')?.textContent?.includes(text),
        SPEECH,
        { timeout: 10_000 },
      );
    });
    await step("duration excludes the pause", async () => {
      const label = await page.getByTestId("recording-thumb").innerText();
      const [m, s] = label.trim().split(":").map(Number);
      const seconds = m * 60 + s;
      if (seconds < 4 || seconds > 7)
        throw new Error(`duration ${label} — expected ~5 s without the pause`);
    });
    await step("play the preview", async () => {
      await page.getByTestId("recording-thumb").click();
      await page.getByTestId("recording-composer-player").waitFor();
      await sleep(800);
    });
    await shot("card-ready");
    await step("the files went where they should", async () => {
      const log = await page.evaluate(() => window.__loomDemo.log.join("\n"));
      for (const want of [
        "drive Recordings/",
        "share Recordings/Screen recording",
        "describe /home/uno/.uno-recordings/",
        "remove /home/uno/.uno-recordings/",
      ]) {
        if (!log.includes(want)) throw new Error(`missing "${want}" in\n${log}`);
      }
    });
    await step("add a line and send", async () => {
      const box = composer(page);
      await box.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Also check it on a phone.");
      await page.keyboard.press("Enter");
    });
    await step("message card with player", async () => {
      await page.getByTestId("recording-message-card").waitFor({ timeout: 10_000 });
      await page.getByTestId("recording-message-player").waitFor();
      if (
        await page
          .getByTestId("recording-composer-card")
          .isVisible()
          .catch(() => false)
      ) {
        throw new Error("the composer card should be gone after sending");
      }
    });
    await step("what the agent saw", async () => {
      await page.getByTestId("recording-message-what").click();
      await page.getByTestId("recording-message-summary").waitFor();
    });
    await step("the agent answers", () =>
      page
        .getByText("Watched your recording", { exact: false })
        .first()
        .waitFor({ timeout: 15_000 }),
    );
    await sleep(600);
    await shot("sent-and-answered");
  }),

  flow("home-show-the-agent", async ({ page, url, step, shot }) => {
    await step("open Home", () => openDemoHome(page, url));
    await step("the chip sits next to Add a project", async () => {
      const chips = await page
        .getByTestId("home-starters")
        .locator("button")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
      const at = chips.indexOf("home-upload-project");
      if (at === -1 || chips[at + 1] !== "home-show-agent")
        throw new Error(`chips: ${chips.join(", ")}`);
    });
    await step("the chip opens the same popover", async () => {
      await page.getByTestId("home-show-agent").click();
      await page.getByTestId("record-popup").waitFor();
      await sleep(400);
    });
    await shot("popover");
    await page.keyboard.press("Escape");
    await step("record a few seconds", async () => {
      await startRecording(page, { trigger: "home-show-agent" });
      await sleep(3000);
      await page.getByTestId("recording-stop").click();
    });
    await step("the card is in Home's box; sending waits for the agent", async () => {
      await page
        .getByTestId("home-recording")
        .getByTestId("recording-composer-card")
        .waitFor({ timeout: 15_000 });
      await page.getByTestId("home-composer").press("Enter");
      await page.getByText("Wait until", { exact: false }).first().waitFor({ timeout: 5_000 });
      if (!new URL(page.url()).hash.startsWith("#/computer"))
        throw new Error(`left Home while the recording was busy: ${page.url()}`);
    });
    await step("saved, watched, the words are in Home's box", async () => {
      await waitStatus(page, "save", "done");
      await waitStatus(page, "watch", "done");
      await page.waitForFunction(
        (text) => document.querySelector('[data-testid="home-composer"]')?.value?.includes(text),
        SPEECH,
        { timeout: 10_000 },
      );
    });
    await step("edits stay: the words aren't put in again", async () => {
      const box = page.getByTestId("home-composer");
      await box.click();
      // The caret to the very end (End stops at the end of a wrapped line).
      await box.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
      await page.keyboard.type(" Also check it on a phone.");
      await sleep(500);
      const value = await box.inputValue();
      if (!value.endsWith("Also check it on a phone.") || value.split(SPEECH).length !== 2)
        throw new Error(`box: ${value}`);
    });
    for (const close of await page.getByRole("button", { name: "Dismiss notification" }).all())
      await close.click().catch(() => undefined);
    await sleep(600);
    await shot("card-in-home");
    await step("send → a new chat with the recording", async () => {
      await page.getByTestId("home-composer").press("Enter");
      await page.waitForFunction(() => !location.hash.startsWith("#/computer"), null, {
        timeout: 15_000,
      });
      await page.getByTestId("recording-message-card").waitFor({ timeout: 20_000 });
      await page.getByTestId("recording-message-player").waitFor();
      await page.getByText("Also check it on a phone.", { exact: false }).first().waitFor();
    });
    await step("nothing left behind: no card in the chat's box or on Home", async () => {
      await sleep(500);
      if (await page.getByTestId("recording-composer-card").count())
        throw new Error("a composer card after sending");
      const left = await page.evaluate(() =>
        Object.keys(window.__loomDemo.recordingItems?.() ?? {}),
      );
      if (left.length) throw new Error(`recordings left in the store: ${left.join(", ")}`);
    });
    await step("the agent answers", () =>
      page
        .getByText("Watched your recording", { exact: false })
        .first()
        .waitFor({ timeout: 15_000 }),
    );
    await sleep(600);
    await shot("new-chat");
  }),

  flow("edge-upload-breaks-retry", async ({ page, url, step, shot }) => {
    await step("open", () => openDemo(page, url, { scenario: "upload-breaks" }));
    await step("record 2 s", async () => {
      await startRecording(page, { camera: false });
      await sleep(2000);
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes("No access to"))
        throw new Error("a device was refused: " + text.match(/No access to[^.]*/)[0]);
      await page.getByTestId("recording-stop").click();
    });
    await step("save fails, watch still works", async () => {
      await waitStatus(page, "save", "failed");
      await waitStatus(page, "watch", "done");
    });
    await shot("upload-failed");
    await step("Retry", async () => {
      await page.getByTestId("recording-save-retry").click();
      await waitStatus(page, "save", "done");
    });
    await shot("upload-retried");
  }),

  flow("edge-watch-fails-retry", async ({ page, url, step, shot }) => {
    await step("open", () => openDemo(page, url, { scenario: "watch-fails" }));
    await step("record", async () => {
      await startRecording(page, { camera: false });
      await sleep(1500);
      await page.getByTestId("recording-stop").click();
    });
    await step("watch fails with the gateway's words", async () => {
      await waitStatus(page, "watch", "failed");
      await page.getByText("gateway took too long", { exact: false }).first().waitFor();
    });
    await shot("watch-failed");
    await step("Retry → watched, words in the box", async () => {
      await page.getByTestId("recording-watch-retry").click();
      await waitStatus(page, "watch", "done");
      await page.waitForFunction(
        (text) => document.querySelector('[contenteditable="true"]')?.textContent?.includes(text),
        SPEECH,
      );
    });
    await shot("watch-retried");
  }),

  flow("edge-drive-full", async ({ page, url, step, shot }) => {
    await step("open", () => openDemo(page, url, { scenario: "drive-full" }));
    await step("record", async () => {
      await startRecording(page, { camera: false });
      await sleep(1500);
      await page.getByTestId("recording-stop").click();
    });
    await step("Drive full is said plainly; the agent still watched", async () => {
      await waitStatus(page, "save", "failed");
      await page.getByText("Uno Drive is full", { exact: false }).first().waitFor();
      await waitStatus(page, "watch", "done");
    });
    await shot("drive-full");
    await step("can still send: the message says it isn't in Drive", async () => {
      await composer(page).click();
      await page.keyboard.press("Enter");
      await page.getByTestId("recording-message-card").waitFor();
      await page.getByText("Not in Uno Drive").first().waitFor();
    });
    await shot("drive-full-sent");
  }),

  flow("edge-silent", async ({ page, url, step, shot }) => {
    await step("open", () => openDemo(page, url, { scenario: "silent" }));
    await step("record without the microphone", async () => {
      await startRecording(page, { camera: false, microphone: false });
      await sleep(1500);
      await page.getByTestId("recording-stop").click();
    });
    await step("a neutral ask goes in the box", async () => {
      await waitStatus(page, "watch", "done");
      await page.waitForFunction(() =>
        document
          .querySelector('[contenteditable="true"]')
          ?.textContent?.includes("Do what I showed"),
      );
    });
    await shot("silent");
  }),

  flow("edge-discard", async ({ page, url, step, shot }) => {
    await step("open", () => openDemo(page, url));
    await step("record and discard", async () => {
      await startRecording(page, { camera: false });
      await sleep(1000);
      await page.getByTestId("recording-discard").click();
      await shot("discard-confirm");
      await page.getByTestId("recording-discard-confirm").click();
    });
    await step("no bar, no card", async () => {
      await page.getByTestId("recording-bar").waitFor({ state: "detached" });
      await sleep(500);
      if (await page.getByTestId("recording-composer-card").count())
        throw new Error("card after discard");
    });
  }),

  flow("edge-picker-closed", async ({ page, url, step }) => {
    await instrumentMedia(page, { refuse: ["screen"] });
    await step("open", () => openDemo(page, url));
    await step("Start, the person closes the picker", async () => {
      await page.getByTestId("record-button").first().click();
      await page.getByTestId("record-start").click();
      await sleep(800);
    });
    await step("nothing happens: no bar, no error", async () => {
      if (await page.getByTestId("recording-bar").count())
        throw new Error("bar after a closed picker");
      if (await page.getByText("Couldn't start recording").count())
        throw new Error("error toast for a closed picker");
    });
  }),

  flow("edge-camera-mic-refused", async ({ page, url, step, shot }) => {
    await instrumentMedia(page, { refuse: ["camera", "microphone"] });
    await step("open", () => openDemo(page, url));
    await step("records anyway and says so", async () => {
      await startRecording(page, { camera: true, microphone: true });
      await page.waitForFunction(() => document.body.innerText.includes("No access to the camera"));
      await page.waitForFunction(() =>
        document.body.innerText.includes("No access to the microphone"),
      );
      await page.getByTestId("recording-no-mic").waitFor();
      if (await page.getByTestId("recording-camera-preview").count())
        throw new Error("camera preview without a camera");
    });
    await shot("refused");
    await page.getByTestId("recording-stop").click();
    await page.getByTestId("recording-composer-card").waitFor();
  }),

  flow("edge-stop-sharing", async ({ page, url, step }) => {
    await instrumentMedia(page);
    await step("open", () => openDemo(page, url));
    await step("record, then the browser's Stop sharing", async () => {
      await startRecording(page, { camera: false });
      await sleep(1500);
      await page.evaluate(() => {
        const track = window.__lastDisplay.getVideoTracks()[0];
        track.stop();
        track.dispatchEvent(new Event("ended"));
      });
    });
    await step("finishes like Done", () =>
      page.getByTestId("recording-composer-card").waitFor({ timeout: 10_000 }),
    );
  }),

  flow("edge-background-tab", async ({ page, url, step, shot }) => {
    await step("open", () => openDemo(page, url));
    await step("record with the camera, minimize Work's window for 5 s", async () => {
      await startRecording(page, { camera: true });
      await sleep(1000);
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      await sleep(600);
      const hidden = await page.evaluate(() => document.visibilityState);
      await sleep(4400);
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await sleep(1000);
      await page.getByTestId("recording-stop").click();
      console.log(`    (Work's page was "${hidden}" while minimized)`);
    });
    await step("the recording kept going (≥ 5 s, frames all along)", async () => {
      await page.getByTestId("recording-composer-card").waitFor();
      const label = await page.getByTestId("recording-thumb").innerText();
      const [m, s] = label.trim().split(":").map(Number);
      if (m * 60 + s < 5) throw new Error(`only ${label}`);
      // The composited video really has frames from the whole time: play it
      // to the end and count the decoded frames (≈ 30 per second if the
      // canvas kept being drawn while the page was hidden).
      const result = await page.evaluate(async () => {
        const video = document.querySelector('[data-testid="recording-thumb"] video');
        const blob = await fetch(video.src).then((r) => r.blob());
        const probe = document.createElement("video");
        probe.muted = true;
        probe.playbackRate = 2;
        probe.src = URL.createObjectURL(blob);
        const ended = new Promise((r) => probe.addEventListener("ended", r, { once: true }));
        await probe.play().catch(() => undefined);
        await Promise.race([ended, new Promise((r) => setTimeout(r, 15000))]);
        const quality = probe.getVideoPlaybackQuality?.();
        return { size: blob.size, frames: quality?.totalVideoFrames ?? -1, t: probe.currentTime };
      });
      console.log(
        `    (blob ${result.size} B, ${result.frames} frames over ${result.t.toFixed(1)} s)`,
      );
      if (result.size < 50_000) throw new Error(`recording too small: ${result.size}`);
      if (result.frames >= 0 && result.frames < result.t * 15) {
        throw new Error(
          `only ${result.frames} frames in ${result.t.toFixed(1)} s — drawing stalled while hidden`,
        );
      }
    });
    await shot("background");
  }),
];
