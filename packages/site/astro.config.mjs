import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { sprout } from './src/sprout-lang.ts';
import og from './scripts/og.mjs';

// PUBLIC_ORIGIN is the deployed origin (also used by the server for OAuth). Only canonical URLs and the sitemap use it.
// On Vercel, VERCEL_PROJECT_PRODUCTION_URL is the project's production domain (set automatically at build time).
const site = process.env.PUBLIC_ORIGIN
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    || 'https://tendril-xi.vercel.app';

export default defineConfig({
  site,
  trailingSlash: 'ignore',
  integrations: [mdx(), sitemap({
    filter: (page) => !page.includes('/play/'),
    // Closed daily pages are rendered by the API function, so the build cannot list them: they get their own sitemap (G2).
    customSitemaps: [`${site}/sitemap-daily.xml`],
  }), og()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      defaultColor: false,
      langs: [sprout],
    },
  },
});
