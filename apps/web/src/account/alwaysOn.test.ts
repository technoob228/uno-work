import { describe, expect, it } from "vitest";

import {
  type AccountComputer,
  describeCreateError,
  parseAccountComputer,
  parsePlanCatalog,
  parseSubscription,
} from "./accountOverview";
import {
  aboutDuration,
  alwaysOnCard,
  alwaysOnLadder,
  alwaysOnTitle,
  boostRate,
  boostUnitSentence,
  boostsBreakdown,
  boostsBurningLine,
  boostsComputerTag,
  boostsTitle,
  computerToSleep,
  needMoreSentence,
  nextAlwaysOnPlan,
  nextPlanLabel,
  ofGb,
  outOfBoostsDetail,
  parsePeakExceeded,
  runPastPlanChoices,
  runningNowLine,
  showsAlwaysOn,
  sleepEarnsSentence,
} from "./alwaysOn";
import { AccountHttpError } from "./unoAccount";

/** A generation-2 plan as /box-plans sends it with the always-on fields. */
const gen2 = (slug: string, name: string, price: number, ramGb: number, boosts: number) => ({
  slug,
  name,
  price_usd: price,
  generation: 2,
  base_slug: slug.replace(/-ai$/, ""),
  max_box: { ram_mb: ramGb * 1024, vcpu: ramGb },
  peak: { ram_mb: ramGb * 1024, vcpu: ramGb },
  disk_gb: 40,
  s3_gb: 100,
  boost_hours: boosts,
  always_on: { ram_mb: ramGb * 1024, vcpu: ramGb },
  boost_to: { ram_mb: ramGb * 2048, vcpu: ramGb * 2 },
  boosts_per_month: boosts,
  boost_unit_ram_mb: ramGb * 1024,
  ...(slug.endsWith("-ai") ? { ai_fast_unlimited: true, ai_hours_monthly: 40 } : {}),
});

const catalog = parsePlanCatalog({
  plans_v2: true,
  plans: [
    gen2("small", "Small", 5, 1, 5),
    gen2("plus", "Plus", 20, 4, 10),
    gen2("plus-ai", "Plus", 50, 4, 10),
    gen2("pro-v2", "Pro", 70, 16, 20),
    gen2("pro-v2-ai", "Pro", 120, 16, 20),
    { slug: "builder", price_usd: 22, legacy: true, max_box: { ram_mb: 4096, vcpu: 2 } },
  ],
});

const plusSub = (over: Record<string, unknown> = {}) =>
  parseSubscription({
    plan: "plus",
    price_usd: 20,
    plan_limits: gen2("plus", "Plus", 20, 4, 10),
    usage: { running_ram_mb: 3072, running_vcpu: 2, disk_gb_used: 20, box_count: 3 },
    plan_view: "always_on",
    always_on: {
      ram_mb: 4096,
      vcpu: 4,
      running_ram_mb: 3072,
      running_vcpu: 2,
      on_boosts_ram_mb: 0,
      computers: 3,
      computers_running: 1,
      computers_asleep: 2,
    },
    boosts: {
      left: 23,
      left_exact: 23.4,
      per_month: 10,
      earned: 13,
      used: 0.6,
      resets_at: "2026-11-01T00:00:00Z",
      earn: { enabled: true, per_sleep_hour: 1, monthly_cap: 20 },
      unit_ram_mb: 4096,
      burning_per_hour: 0,
      hours_left_at_this_rate: null,
      run_on_boosts: true,
    },
    ...over,
  })!;

describe("who sees always on", () => {
  it("plan_view always_on with the numbers", () => {
    expect(showsAlwaysOn(plusSub())).toBe(true);
  });

  it("old plans, an older console and Free keep the old screens", () => {
    expect(showsAlwaysOn(plusSub({ plan_view: "hours" }))).toBe(false);
    expect(showsAlwaysOn(plusSub({ plan_view: undefined, always_on: undefined }))).toBe(false);
    expect(showsAlwaysOn(null)).toBe(false);
    // always_on promised but no numbers: nothing to show, old screen.
    expect(showsAlwaysOn(plusSub({ always_on: undefined }))).toBe(false);
  });

  it("the ladder: by plan_view for subscribers, by the feature without a plan or on a trial", () => {
    expect(alwaysOnLadder(plusSub(), [])).toBe(true);
    expect(alwaysOnLadder(plusSub({ plan_view: "hours" }), ["plan_always_on"])).toBe(false);
    expect(alwaysOnLadder(plusSub({ plan_view: undefined }), ["plan_always_on"])).toBe(false);
    expect(alwaysOnLadder(null, ["plan_always_on"])).toBe(true);
    expect(alwaysOnLadder(null, [])).toBe(false);
    expect(alwaysOnLadder(plusSub({ plan_view: "trial" }), ["plan_always_on"])).toBe(true);
  });
});

describe("the canon words", () => {
  const sub = plusSub();

  it("what is bought and what runs now", () => {
    expect(alwaysOnTitle(4096)).toBe("Always on · 4 GB");
    expect(runningNowLine(sub.alwaysOn!)).toBe("Running now · 3 of 4 GB");
    expect(ofGb(512, 4096)).toBe("512 MB of 4 GB");
    expect(ofGb(0, 4096)).toBe("0 of 4 GB");
    expect(runningNowLine({ ...sub.alwaysOn!, runningRamMb: 8192, onBoostsRamMb: 4096 })).toBe(
      "Running now · 4 of 4 GB + 4 GB on boosts",
    );
  });

  it("boosts: left, where they came from, when they start over, what one is", () => {
    const boosts = sub.boosts!;
    expect(boostsTitle(boosts)).toBe("⚡ Boosts · 23 left");
    expect(boostsBreakdown(boosts)).toBe(
      "10 with your plan + 13 earned while asleep · new on Nov 1",
    );
    expect(boostsBreakdown({ ...boosts, earned: 0 })).toBe("10 with your plan · new on Nov 1");
    expect(boostUnitSentence(boosts)).toBe(
      "1 boost = 4 GB more for an hour. Every hour a computer sleeps earns one (up to 20 a month).",
    );
    expect(boostUnitSentence({ ...boosts, earn: null })).toBe("1 boost = 4 GB more for an hour.");
    expect(sleepEarnsSentence({ enabled: true, perSleepHour: 0.1, monthlyCap: 10 })).toBe(
      "Every 10 hours a computer sleeps earn one (up to 10 a month).",
    );
    expect(sleepEarnsSentence({ enabled: false, perSleepHour: 1, monthlyCap: 20 })).toBeNull();
  });

  it("what if I need more", () => {
    expect(needMoreSentence(4096)).toBe(
      "Need more than 4 GB? Start another computer on boosts. When boosts run out, it goes to sleep — your main computer stays on.",
    );
  });

  it("boosts burning right now", () => {
    expect(boostsBurningLine(sub.boosts!)).toBeNull();
    expect(
      boostsBurningLine({ ...sub.boosts!, burningPerHour: 1, hoursLeftAtThisRate: 23.4 }),
    ).toBe("Using 1 boost an hour right now — enough for about a day.");
    expect(boostsBurningLine({ ...sub.boosts!, burningPerHour: 0.5 })).toBe(
      "Using ½ boost an hour right now — enough for about 2 days.",
    );
  });

  it("durations and rates", () => {
    expect(aboutDuration(0.5)).toBe("less than an hour");
    expect(aboutDuration(1)).toBe("about an hour");
    expect(aboutDuration(5.4)).toBe("about 5 hours");
    expect(aboutDuration(23)).toBe("about a day");
    expect(aboutDuration(72)).toBe("about 3 days");
    expect(boostRate(1)).toBe("1 boost an hour");
    expect(boostRate(2)).toBe("2 boosts an hour");
    expect(boostRate(0.5)).toBe("½ boost an hour");
  });
});

describe("plan cards", () => {
  it("three numbers at most: price, GB, boosts — and one Uno AI line", () => {
    const plus = catalog.plans.find((p) => p.slug === "plus")!;
    const plusAi = catalog.plans.find((p) => p.slug === "plus-ai")!;
    expect(alwaysOnCard(plus)).toEqual({
      alwaysOn: "Always on 4 GB",
      boosts: "⚡ 10 boosts a month",
      ai: "Works with Uno AI",
    });
    expect(alwaysOnCard(plusAi)?.ai).toBe("Uno AI: Fast is unlimited. Smart uses your AI time.");
  });

  it("no always-on figures (older console): the old card", () => {
    const old = parsePlanCatalog({ plans: [{ slug: "pro", price_usd: 69 }] }).plans[0]!;
    expect(old.alwaysOn).toBeNull();
    expect(alwaysOnCard(old)).toBeNull();
  });

  it("the next plan up, same Uno AI flavour", () => {
    const next = nextAlwaysOnPlan(catalog, plusSub())!;
    expect(next.slug).toBe("pro-v2");
    expect(nextPlanLabel(next)).toBe("Get Pro — always on 16 GB, $70/mo");
    const aiSub = plusSub({ plan: "plus-ai", plan_limits: gen2("plus-ai", "Plus", 50, 4, 10) });
    expect(nextAlwaysOnPlan(catalog, aiSub)?.slug).toBe("pro-v2-ai");
  });
});

describe("starting past the plan", () => {
  const body = {
    error: "PEAK_EXCEEDED",
    message: "Your always-on 4 GB is in use.",
    always_on_ram_mb: 4096,
    running_ram_mb: 4096,
    need_ram_mb: 4096,
    run_on_boosts: {
      possible: true,
      boosts_left: 23,
      boosts_per_hour: 1,
      hours_about: 23,
      resets_at: "2026-11-01T00:00:00Z",
      reason: "",
    },
  };
  const computer = (raw: Record<string, unknown>): AccountComputer =>
    parseAccountComputer({ ram_mb: 4096, vcpu: 2, ...raw })!;
  const unoWork = computer({ id: 1, name: "uno-work", status: "running", work_machine: true });

  it("reads the whole 409 answer, even when the text was cut short", () => {
    const error = new AccountHttpError(409, `409: ${JSON.stringify(body).slice(0, 200)}`, body);
    const peak = parsePeakExceeded(error)!;
    expect(peak.needRamMb).toBe(4096);
    expect(peak.runOnBoosts).toMatchObject({ possible: true, boostsLeft: 23, boostsPerHour: 1 });
    expect(peak.runOnBoosts?.reason).toBeNull();
  });

  it("an older console: PEAK_EXCEEDED without run_on_boosts, or another error", () => {
    const old = new Error('409: {"error":"PEAK_EXCEEDED"}');
    expect(parsePeakExceeded(old)?.runOnBoosts).toBeNull();
    expect(parsePeakExceeded(new Error('409: {"error":"SHAPE_TOO_LARGE"}'))).toBeNull();
    expect(parsePeakExceeded("boom")).toBeNull();
    // The old words stay for an older console.
    expect(describeCreateError(old).message).toBe(
      "Your plan is already running as much as it can at once. Put a computer to sleep or pick a bigger plan.",
    );
    // A console with the always-on sentence says it its way.
    expect(describeCreateError(new AccountHttpError(409, "409: …", body)).message).toBe(
      "Your always-on 4 GB is in use. Put a computer to sleep or pick a bigger plan.",
    );
  });

  it("the three ways out, in the canon words", () => {
    const peak = parsePeakExceeded(new AccountHttpError(409, "409", body))!;
    const choices = runPastPlanChoices({
      name: "scraper",
      ramMb: 4096,
      peak,
      computers: [unoWork],
      nextPlan: nextAlwaysOnPlan(catalog, plusSub()),
    });
    expect(choices.title).toBe("Start “scraper” — 4 GB?");
    expect(choices.lead).toBe("Your always-on 4 GB is busy.");
    expect(choices.boosts).toEqual({
      possible: true,
      title: "⚡ Run it on boosts",
      detail:
        "1 boost an hour · you have 23, about a day. When they run out it sleeps; uno-work stays on.",
    });
    expect(choices.sleep?.title).toBe("Put uno-work to sleep and start scraper instead");
    expect(choices.nextPlan?.title).toBe("Get Pro — always on 16 GB, $70/mo");
  });

  it("not possible: the console's reason instead of the offer", () => {
    const no = {
      ...body,
      run_on_boosts: { possible: false, boosts_left: 0, reason: "You have no boosts left." },
    };
    const choices = runPastPlanChoices({
      name: "scraper",
      ramMb: 4096,
      peak: parsePeakExceeded(new AccountHttpError(409, "409", no))!,
      computers: [unoWork],
      nextPlan: null,
    });
    expect(choices.boosts.possible).toBe(false);
    expect(choices.boosts.detail).toBe("You have no boosts left.");
    expect(choices.nextPlan).toBeNull();
  });

  it("sleeps the smallest running computer that makes room, a server before Uno Work", () => {
    const peak = { alwaysOnRamMb: 4096, runningRamMb: 4096 };
    const bot = computer({ id: 2, name: "bot", status: "running", ram_mb: 2048 });
    const vpn = computer({ id: 3, name: "vpn", status: "running", ram_mb: 2048 });
    const asleep = computer({ id: 4, name: "old", status: "sleeping", ram_mb: 4096 });
    expect(computerToSleep([unoWork, asleep], peak, 4096)?.name).toBe("uno-work");
    expect(computerToSleep([bot, vpn], peak, 2048)?.name).toBe("bot");
    // Neither 2 GB computer alone frees 4 GB.
    expect(computerToSleep([bot, vpn], peak, 4096)).toBeNull();
  });
});

describe("a computer on boosts", () => {
  const sub = plusSub();
  const onBoosts = (status: string) =>
    parseAccountComputer({ id: 9, name: "scraper", status, run_on_boosts: true })!;

  it("tags it while it runs, and when the boosts ran out", () => {
    expect(boostsComputerTag(onBoosts("running"), sub.boosts)).toBe("on-boosts");
    expect(boostsComputerTag(onBoosts("sleeping"), { left: 0 })).toBe("out-of-boosts");
    // Asleep with boosts left: it just sleeps.
    expect(boostsComputerTag(onBoosts("sleeping"), sub.boosts)).toBeNull();
    // Older console: no flag, no tag.
    expect(
      boostsComputerTag(parseAccountComputer({ id: 1, status: "running" })!, sub.boosts),
    ).toBeNull();
  });

  it("says when it wakes", () => {
    expect(outOfBoostsDetail("2026-11-01T00:00:00Z")).toBe(
      "Asleep — boosts ran out. Wakes when your plan has room, or on Nov 1.",
    );
  });
});
