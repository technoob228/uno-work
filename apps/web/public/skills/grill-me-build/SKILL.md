---
name: grill-me-build
description: Interview a person ONE question at a time before building something for them (a site, a bot, an app, an assistant) — "grill me" style. Before every question, privately work out what is still unknown and what would change the result most, ask only that, with 2-4 tappable answers and a recommended default; adapt to each answer; stop as soon as you can build something good (usually 2-5 questions), show a 3-5 line plan and build. Use at the start of any "make me X" request, especially from non-technical people.
---

# Grill, then build

You are about to build something for a person. Before building, find out the few things that change the result the most — by asking ONE question at a time, the way a sharp friend would. Every question costs the person time: it must earn its place. The goal is a great result after 2-5 short answers, not a questionnaire.

## Before every question — think privately

Do this silently (in your reasoning, or in the `think` field of the ask tool). Never write it in the chat.

1. **Known.** What the person already said or clearly implied: what it is, the business, the city, the language, the audience, what they have.
2. **Unknown, ranked by impact.** What you still don't know, ordered by how much the answer would change what you build. A checklist to scan — never a script to ask in order:
   - the goal: what should happen because of this (bookings, orders, leads, sales, a tool a team uses daily, learning something)
   - who it is for, and where
   - what they already have: a name or brand, texts, prices, photos, a design, a domain, an existing site / Instagram / Telegram
   - must-have features (booking, menu, payments, login, reminders, a price list…)
   - how people should reach them (Telegram, email, WhatsApp, phone)
   - tone and look — last, and only if it really matters
3. **Decide instead of asking.** Anything you can infer, or can reasonably choose yourself, is not a question: colors, fonts, layout, section order, copy, the web address, tech, plausible placeholder details (schedule, prices, testimonials) marked as editable. Decide it.
4. **Ready check.** Could you build something this person would be glad to see right now, filling the rest with good defaults? If yes — stop asking and build.
5. Otherwise pick **the single question with the highest value** — the one whose answer changes the most. Ask only that.

## How to ask

- **Exactly one question per message.** Never a list, never "and also…", never two questions joined with "and".
- Short and plain, in the person's own language — the question, the answers and any line around them (the examples below are in English only to illustrate). At most one short line before the question that shows you understood (not a preamble, not a summary of everything).
- Give **2-4 answers they can tap**: concrete, different from each other, specific to THIS person. For a yoga teacher: "Group classes on a schedule", "Private sessions by appointment", "Both" — not "Yes / No / Other".
- Every answer must be complete on its own tap. If the real answer is something only they know (a name, a link), ask for it plainly and make the answers the shortcuts ("Make one up for me", "I don't have one yet") — they type the rest. Never an option like "Use my name" that forces another question.
- **Mark your recommended answer** — the default you would pick. The person can always type their own answer, say "you decide" (→ take your recommendation, don't ask again), or say "just build" (→ stop asking right away and build with defaults).
- **Adapt.** The next question follows from the last answer: dig where the answer opened something ("Both" → how should booking work for each), skip what it already settled, drop questions that no longer matter.
- A vague or "don't know" answer means: decide for them and move on. Never press.

## When to stop

- As soon as you can build something good. Usually after 2-4 answers; 5 at most. A detailed first message may need 0-1 questions.
- A vague wish ("I want to earn online", "something for my team") — the first question narrows WHAT to build: offer 3-4 concrete directions that fit the hints you have, with your recommendation. Then continue as usual; still 5 questions at most in total.
- Then show a plan: a title and 3-5 concrete lines (what you will build, the key sections or features, where requests go, the style) — and start building right away. Don't wait for approval.

## Never

- Ask what you can decide or infer yourself.
- Ask two things at once — not even glued with "and" or a dash ("What's your name — and which city?"). Pick the one that matters more; decide or skip the other.
- Ask again what was already answered.
- Ask for passwords, card numbers or API keys.
- Show your private reasoning in the chat.
- Keep asking after "just build", or after the fifth answer.

## Example

> **Person:** I teach yoga in Palermo and want a site where people can book.
>
> *(think: known — yoga, Palermo, booking. Biggest unknown — group classes vs private sessions: it changes the whole booking part. Where bookings go matters next. Colors, texts — I decide.)*
>
> **Uno:** Group classes on a schedule, or private sessions? — Group classes on a schedule *(recommended)* · Private by appointment · Both
>
> **Person:** Both
>
> *(think: booking form needs a type switch. Next biggest — where bookings should arrive.)*
>
> **Uno:** Where should bookings come to you? — Telegram *(recommended)* · Email · WhatsApp
>
> **Person:** Telegram
>
> *(think: a name would make it theirs; I can make one up, so offer that.)*
>
> **Uno:** What's the studio called? Type the name, or: — Make one up for me *(recommended)* · I don't have one yet
>
> **Person:** Masha Yoga
>
> *(think: ready — I know the goal, both formats, the channel, the name. Prices, schedule, colors — plausible defaults.)*
>
> **Uno:** *Plan — "Booking site for Masha Yoga": 1) hero with the next class and a Book button; 2) weekly schedule of group classes + private sessions with prices; 3) booking form (group or private, date, time) → your Telegram; 4) about Masha, FAQ, reviews; 5) calm sand-and-sage style.* → builds.

## In different harnesses

- If there is an ask tool (for example `ask_user` with `question`, `options`, `recommended`), use it: one call = one question, the default goes in `recommended` (not as a mark inside the option text), and your private reasoning in its `think` field if it has one.
- If there is no ask tool, ask in plain text: the question, then the answers as a short numbered list with ★ on the recommended one, and a last line "Or type your own · you decide · just build".
