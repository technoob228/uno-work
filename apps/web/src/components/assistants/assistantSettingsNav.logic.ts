/**
 * One place for an assistant's settings (Misha 29.10: "I open the assistants'
 * settings and land who knows where; I couldn't go back and change an
 * assistant"). With the assistants update every door — the sidebar, the
 * header of its chat, the Assistants list, old links to the 0.0.105 card
 * (`view=card`) and the 0.0.106 page (`view=local`) — opens the same page:
 * `/assistants?view=profile&env=…&project=…`.
 *
 * Kept free of React so the choices are unit-tested.
 */

export interface SettingsMember {
  readonly environmentId: string;
  readonly projectId: string;
  readonly isUno: boolean;
  readonly revoked: boolean;
}

/** The search of an assistant's page. */
export function assistantSettingsSearch(
  member: Pick<SettingsMember, "environmentId" | "projectId">,
) {
  return { view: "profile" as const, env: member.environmentId, project: member.projectId };
}

/**
 * The member an old link meant: `view=card` was the active computer's Uno,
 * `view=local&project=…` one of its other assistants. The active computer's
 * one first, then any computer's (one Uno per account in variant D); null when
 * there is none — the old page stays then.
 */
export function memberOfLegacyView<M extends SettingsMember>(
  team: ReadonlyArray<M>,
  link: { readonly view: "card" | "local"; readonly project?: string | undefined },
  activeEnvironmentId: string | null,
): M | null {
  const wanted = (member: M) =>
    link.view === "card" ? member.isUno : member.projectId === link.project;
  const live = team.filter((member) => !member.revoked || link.view === "local");
  return (
    live.find((member) => wanted(member) && member.environmentId === activeEnvironmentId) ??
    live.find(wanted) ??
    null
  );
}

/** Uno first, then the helpers in the sidebar's order, the removed ones last. */
export function settingsListOrder<M extends SettingsMember>(
  team: ReadonlyArray<M>,
): {
  readonly live: ReadonlyArray<M>;
  readonly removed: ReadonlyArray<M>;
} {
  const live = team.filter((member) => !member.revoked);
  return {
    live: [...live.filter((member) => member.isUno), ...live.filter((member) => !member.isUno)],
    removed: team.filter((member) => member.revoked),
  };
}
