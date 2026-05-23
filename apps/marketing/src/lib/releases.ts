const REPO = "technoob228/uno-work";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "uno-work-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export type ReleasePlatform = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64";

const ASSET_MATCHERS: Record<ReleasePlatform, Array<(name: string) => boolean>> = {
  "mac-arm64": [
    (name) => name.endsWith("-arm64.dmg"),
    (name) => name.endsWith(".dmg"),
    (name) => name.endsWith(".zip"),
  ],
  "mac-x64": [
    (name) => name.endsWith("-x64.dmg"),
    (name) => name.endsWith(".dmg"),
    (name) => name.endsWith(".zip"),
  ],
  "win-x64": [(name) => name.endsWith("-x64.exe"), (name) => name.endsWith(".exe")],
  "linux-x64": [(name) => name.endsWith("-x86_64.AppImage"), (name) => name.endsWith(".AppImage")],
};

function isInstallerAsset(name: string): boolean {
  return !name.endsWith(".blockmap") && !name.endsWith(".yml");
}

export function pickReleaseAsset(
  assets: ReleaseAsset[],
  platform: ReleasePlatform,
): ReleaseAsset | null {
  const installers = assets.filter((asset) => isInstallerAsset(asset.name));

  for (const matches of ASSET_MATCHERS[platform]) {
    const asset = installers.find((candidate) => matches(candidate.name));
    if (asset) return asset;
  }

  return null;
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const data = await fetch(API_URL).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}
