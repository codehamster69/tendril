// Browser-side: find the latest release's installers and the visitor's system.
import { PLATFORMS, RELEASES_REPO } from '../data/downloads';
import type { BuildId, Os } from '../data/downloads';

export interface Asset { url: string; name: string; size: number }
export interface Release { version: string; page: string; assets: Partial<Record<BuildId, Asset>> }

const KEY = `tendril.release.${RELEASES_REPO}`;

export async function latestRelease(): Promise<Release | null> {
  try {
    const cached = sessionStorage.getItem(KEY);
    if (cached) return JSON.parse(cached) as Release | null;
  } catch { /* storage unavailable */ }
  let release: Release | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    if (res.ok) {
      const data = (await res.json()) as { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string; size: number }[] };
      const assets: Release['assets'] = {};
      for (const b of PLATFORMS.flatMap((p) => p.builds)) {
        const a = data.assets.find((x) => new RegExp(b.match).test(x.name) && !x.name.endsWith('.blockmap'));
        if (a) assets[b.id] = { url: a.browser_download_url, name: a.name, size: a.size };
      }
      if (Object.keys(assets).length) release = { version: data.tag_name.replace(/^v/, ''), page: data.html_url, assets };
    } else if (res.status !== 404) {
      return null; // rate limited or GitHub down: don't cache, try again next page
    }
  } catch {
    return null;
  }
  try { sessionStorage.setItem(KEY, JSON.stringify(release)); } catch { /* ignore */ }
  return release;
}

export function detectOs(): Os | null {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return null;
}

/** The build to offer first. On Macs, Chromium can report the CPU; Safari and Firefox can't, so default to Apple silicon. */
export async function preferredBuild(os: Os): Promise<BuildId> {
  if (os === 'windows') return 'win-x64';
  if (os === 'linux') return /Ubuntu|Debian/i.test(navigator.userAgent) ? 'linux-deb' : 'linux-appimage';
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string }> } }).userAgentData;
    const v = await uad?.getHighEntropyValues(['architecture']);
    if (v?.architecture === 'x86') return 'mac-x64';
  } catch { /* not available */ }
  return 'mac-arm64';
}

export const megabytes = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`;
