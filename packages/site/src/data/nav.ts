export interface NavItem { href: string; title: string }
export interface NavGroup { title: string; items: NavItem[] }

export const DOCS_NAV: NavGroup[] = [
  {
    title: 'Start here',
    items: [
      { href: '/docs/', title: 'Getting started' },
      { href: '/docs/how-to-play/', title: 'How the farm works' },
      { href: '/docs/research/', title: 'Research and buildings' },
    ],
  },
  {
    title: 'Sprout',
    items: [
      { href: '/docs/sprout/', title: 'Learn Sprout' },
      { href: '/docs/python/', title: 'Sprout for Python programmers' },
      { href: '/docs/running/', title: 'How programs run' },
      { href: '/docs/reference/', title: 'Reference' },
      { href: '/docs/examples/', title: 'Example programs' },
    ],
  },
  {
    title: 'Competing',
    items: [
      { href: '/docs/leaderboard/', title: 'Leaderboard and fair play' },
      { href: '/docs/daily/', title: 'Daily challenge' },
      { href: '/docs/faq/', title: 'FAQ' },
    ],
  },
];

export const FLAT_NAV: NavItem[] = DOCS_NAV.flatMap((g) => g.items);
