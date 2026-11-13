// Tier name colours. Light values are darkened from the profile mockup so every one clears 4.5:1 on the page paper
// and on panels; dark values are the mockup's. packages/rating/test/docs.test.ts checks the ratios.
export const TIER_COLORS_LIGHT: Record<string, string> = {
  seed: '#6b4a32', seedling: '#6a6320', shoot: '#3e6d21', vine: '#1c6e60',
  bloom: '#7b3a86', orchard: '#b43129', grove: '#94510c', evergreen: '#0f4d2a',
};
export const TIER_COLORS_DARK: Record<string, string> = {
  seed: '#b08866', seedling: '#d4c86a', shoot: '#9bd16a', vine: '#5fd0bd',
  bloom: '#c07ac9', orchard: '#e0675c', grove: '#f0a04a', evergreen: '#b7f0c0',
};
export const TIER_GOLD_LIGHT = '#b98a12';
export const TIER_GOLD_DARK = '#e2be4f';

const vars = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `--t-${k}:${v};`).join('');
/** CSS injected by arenaCss: tier variables per theme, and the .tier-<key> name classes. */
export const tierCss = `
:root{${vars(TIER_COLORS_LIGHT)}--t-gold:${TIER_GOLD_LIGHT};}
@media (prefers-color-scheme: dark){:root{${vars(TIER_COLORS_DARK)}--t-gold:${TIER_GOLD_DARK};}}
${Object.keys(TIER_COLORS_LIGHT).map((k) => `.tier-${k}{color:var(--t-${k});}`).join('\n')}
a.player[class*="tier-"]{font-weight:600;}
a.player.tier-evergreen{text-decoration-color:var(--t-gold);text-decoration-thickness:2px;}
.delta{font-variant-numeric:tabular-nums;font-size:.85em;margin-left:.4rem;white-space:nowrap;}
.delta.up{color:var(--leaf);}.delta.down{color:var(--apple);}
`;
