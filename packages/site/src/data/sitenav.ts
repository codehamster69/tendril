// The one list that drives the header, the phone menu and the footer. Add a page here and it shows up everywhere.
// An entry with `when` only appears once that page exists in src/pages, so Gallery and Seed packets can be listed
// before they ship without leaving a dead link.
export interface SiteLink { href: string; title: string; hint?: string; when?: string }
export interface SiteGroup { title: string; links: SiteLink[] }

export const TOP: SiteLink[] = [
  { href: '/play/', title: 'Play', hint: 'Open the game in your browser' },
  { href: '/play/?mode=daily', title: 'Today', hint: "Today's farm, the same for everyone" },
  { href: '/leaderboard/', title: 'Leaderboard', hint: 'Every score replayed and checked' },
];

export const GROUPS: SiteGroup[] = [
  { title: 'Learn', links: [
    { href: '/docs/', title: 'Getting started', hint: 'Your first ten minutes' },
    { href: '/docs/sprout/', title: 'Learn Sprout', hint: 'The language, step by step' },
    { href: '/docs/reference/', title: 'Reference', hint: 'Every command, searchable' },
    { href: '/docs/examples/', title: 'Example programs', hint: 'Copy one and change it' },
    { href: '/docs/how-to-play/', title: 'How the farm works', hint: 'Crops, bots and money' },
  ] },
  { title: 'Community', links: [
    { href: '/docs/models/', title: 'Bench', hint: 'Humans against AI models' },
    { href: '/gallery/', title: 'Gallery', hint: 'Farms and pictures players made', when: '/gallery/' },
    { href: '/seeds/', title: 'Seed packets', hint: 'Programs to copy and remix', when: '/seeds/' },
    { href: '/season-1/', title: 'Season 1', hint: 'The weekly season' },
    { href: '/duel/', title: 'Duels', hint: 'Race a friend on the same farm' },
  ] },
];

const pages = Object.keys(import.meta.glob('../pages/**/*.{astro,mdx}')).map((p) => p.replace('../pages', '').replace(/\.(astro|mdx)$/, '').replace(/\/index$/, '') + '/');
export const exists = (href: string): boolean => pages.includes(href);
export const visible = (links: SiteLink[]): SiteLink[] => links.filter((l) => !l.when || exists(l.when));
