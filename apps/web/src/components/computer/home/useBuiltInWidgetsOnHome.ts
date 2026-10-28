import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import {
  HOME_BUILT_IN_WIDGETS_SEEN_KEY,
  newBuiltInWidgetBlocks,
  type HomeBlockId,
  type HomeLayoutAction,
} from "./homeLayout";

const SEEN_SCHEMA = Schema.NullOr(Schema.Array(Schema.String));

/**
 * The built-in widgets Home comes with ("AI plan limits", 0.0.157) land on a
 * layout saved before they existed — once per device; one the person removes
 * stays removed (newBuiltInWidgetBlocks).
 */
export function useBuiltInWidgetsOnHome(layout: {
  readonly blocks: ReadonlyArray<HomeBlockId>;
  readonly dispatch: (action: HomeLayoutAction) => void;
}) {
  const [seen, setSeen] = useLocalStorage<
    ReadonlyArray<string> | null,
    ReadonlyArray<string> | null
  >(HOME_BUILT_IN_WIDGETS_SEEN_KEY, null, SEEN_SCHEMA);
  const { blocks, dispatch } = layout;
  useEffect(() => {
    const next = newBuiltInWidgetBlocks({ blocks, seen });
    if (seen !== null && next.add.length === 0 && next.seen.length === seen.length) return;
    for (const id of next.add) dispatch({ type: "add", id });
    setSeen(next.seen);
  }, [blocks, seen, dispatch, setSeen]);
}
