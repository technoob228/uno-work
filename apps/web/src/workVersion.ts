/** Uno Work version strings ("0.0.118", "v0.0.118"): normalize and compare. */

export function normalizeWorkVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, "");
  return trimmed ? trimmed : null;
}

/** -1 / 0 / 1; unparsable parts compare as text so "different" stays different. */
export function compareWorkVersions(a: string, b: string): number {
  const pa = (normalizeWorkVersion(a) ?? "").split(/[.+-]/);
  const pb = (normalizeWorkVersion(b) ?? "").split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
