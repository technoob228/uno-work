import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

type ModelPickerSearchableModel = {
  /** Driver kind — indexed so "codex" still matches a Codex Personal instance. */
  driverKind: string;
  /**
   * Instance display name (e.g. "Codex Personal"). Indexed as a search
   * field so typing the custom instance's user-authored name matches its
   * models directly instead of just the driver kind.
   */
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
};

const MODEL_PICKER_FAVORITE_SCORE_BOOST = 24;

export type ModelPickerSearchIndex = {
  readonly fields: ReadonlyArray<string>;
  readonly tieBreaker: string;
};

export function getModelPickerSearchTokens(query: string): string[] {
  return normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

function getModelPickerSearchFields(
  model: ModelPickerSearchableModel,
  tieBreaker: string,
): string[] {
  return [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    normalizeSearchQuery(model.driverKind),
    normalizeSearchQuery(model.providerDisplayName),
    tieBreaker,
  ];
}

function scoreModelPickerSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery(
    [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" "),
  );
}

export function createModelPickerSearchIndex(
  model: ModelPickerSearchableModel,
): ModelPickerSearchIndex {
  const tieBreaker = buildModelPickerSearchText(model);
  return {
    fields: getModelPickerSearchFields(model, tieBreaker),
    tieBreaker,
  };
}

export function scoreModelPickerSearchIndex(
  searchIndex: ModelPickerSearchIndex,
  tokens: ReadonlyArray<string>,
  options?: { readonly isFavorite?: boolean },
): number | null {
  if (tokens.length === 0) {
    return 0;
  }

  let score = 0;

  for (const token of tokens) {
    const tokenScores = searchIndex.fields
      .map((field, index) => scoreModelPickerSearchToken(field, token, index * 10))
      .filter((fieldScore): fieldScore is number => fieldScore !== null);

    if (tokenScores.length === 0) {
      return null;
    }

    score += Math.min(...tokenScores);
  }

  return options?.isFavorite === true ? score - MODEL_PICKER_FAVORITE_SCORE_BOOST : score;
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  return scoreModelPickerSearchIndex(
    createModelPickerSearchIndex(model),
    getModelPickerSearchTokens(query),
    model.isFavorite === undefined ? undefined : { isFavorite: model.isFavorite },
  );
}
