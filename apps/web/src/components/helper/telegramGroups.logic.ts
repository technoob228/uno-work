/**
 * Pure helpers of the Telegram page's "Groups" section: the name to show and
 * the next list of picked people. See `TelegramGroupsSection.tsx`.
 */
import type { ManagerTelegramGroupPerson, ManagerTelegramGroupView } from "@t3tools/contracts";

/** What a group is called: its Telegram name, the owner's label, else its id. */
export function groupDisplayName(
  group: { readonly chatId: string; readonly title: string | null },
  labels: Readonly<Record<string, string>>,
): string {
  return group.title ?? labels[group.chatId] ?? `Group ${group.chatId}`;
}

/** Ids picked in a group right now (the owner is never part of the list). */
export function selectedIds(group: ManagerTelegramGroupView): ReadonlyArray<string> {
  return group.people.filter((person) => person.selected && !person.owner).map((p) => p.id);
}

/** The picked list after a press on one person. */
export function togglePerson(
  group: ManagerTelegramGroupView,
  personId: string,
): ReadonlyArray<string> {
  const current = selectedIds(group);
  return current.includes(personId)
    ? current.filter((id) => id !== personId)
    : [...current, personId];
}

/** People to choose from: everyone seen who is not the owner. */
export function pickablePeople(
  group: ManagerTelegramGroupView,
): ReadonlyArray<ManagerTelegramGroupPerson> {
  return group.people.filter((person) => !person.owner);
}
