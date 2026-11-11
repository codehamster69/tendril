// Installers come from .github/workflows/release.yml (electron-builder, unsigned for now).
// When a release is published, set RELEASE.version and fill each build's `url` (and optionally size, sha256).
// A null url shows "Coming soon".
export type Os = 'windows' | 'mac' | 'linux';

export interface Build { label: string; file: string; url: string | null; size?: string; sha256?: string }
export interface Platform { os: Os; name: string; requirements: string; builds: Build[] }

export const RELEASE = { version: '0.0.1', channel: 'Early access' };
const v = RELEASE.version;

export const PLATFORMS: Platform[] = [
  {
    os: 'windows', name: 'Windows',
    requirements: 'Windows 10 or 11, 64-bit.',
    builds: [{ label: 'Installer (.exe)', file: `Tendril-${v}-win-x64.exe`, url: null }],
  },
  {
    os: 'mac', name: 'macOS',
    requirements: 'macOS 12 Monterey or later.',
    builds: [
      { label: 'Apple silicon (.dmg)', file: `Tendril-${v}-mac-arm64.dmg`, url: null },
      { label: 'Intel (.dmg)', file: `Tendril-${v}-mac-x64.dmg`, url: null },
    ],
  },
  {
    os: 'linux', name: 'Linux',
    requirements: '64-bit x86. Ubuntu 22.04, Fedora 38 or newer.',
    builds: [
      { label: 'AppImage', file: `Tendril-${v}-linux-x86_64.AppImage`, url: null },
      { label: 'Debian / Ubuntu (.deb)', file: `Tendril-${v}-linux-amd64.deb`, url: null },
    ],
  },
];

export const released = PLATFORMS.some((p) => p.builds.some((b) => b.url));
