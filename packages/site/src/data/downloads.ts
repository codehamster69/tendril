// Installers are published as GitHub release assets by .github/workflows/release.yml (electron-builder names:
// `Tendril-<version>-<os>-<arch>.<ext>`). The site asks GitHub for the latest release in the browser, so a new
// release shows up without redeploying. Set PUBLIC_RELEASES_REPO ("owner/name", a public repo) at build time.
export type Os = 'windows' | 'mac' | 'linux';
export type BuildId = 'win-x64' | 'mac-arm64' | 'mac-x64' | 'linux-appimage' | 'linux-deb';

export interface Build { id: BuildId; label: string; match: string /* regex source, tested against asset names */ }
export interface Platform { os: Os; name: string; requirements: string; builds: Build[] }

export const RELEASES_REPO: string = import.meta.env.PUBLIC_RELEASES_REPO || 'codehamster69/tendril';
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`;

export const PLATFORMS: Platform[] = [
  {
    os: 'windows', name: 'Windows',
    requirements: 'Windows 10 or 11, 64-bit.',
    builds: [{ id: 'win-x64', label: 'Installer (.exe)', match: '\\.exe$' }],
  },
  {
    os: 'mac', name: 'macOS',
    requirements: 'macOS 12 Monterey or later.',
    builds: [
      { id: 'mac-arm64', label: 'Apple silicon (.dmg)', match: 'arm64\\.dmg$' },
      { id: 'mac-x64', label: 'Intel (.dmg)', match: '(x64|x86_64)\\.dmg$' },
    ],
  },
  {
    os: 'linux', name: 'Linux',
    requirements: '64-bit x86. Ubuntu 22.04, Fedora 38 or newer.',
    builds: [
      { id: 'linux-appimage', label: 'AppImage', match: '\\.AppImage$' },
      { id: 'linux-deb', label: 'Debian / Ubuntu (.deb)', match: '\\.deb$' },
    ],
  },
];
