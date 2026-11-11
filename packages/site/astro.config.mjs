import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { sprout } from './src/sprout-lang.ts';

export default defineConfig({
  // PUBLIC_ORIGIN is the deployed origin (also used by the server for OAuth). Only canonical URLs and the sitemap use it.
  site: process.env.PUBLIC_ORIGIN || 'https://tendril.vercel.app',
  trailingSlash: 'ignore',
  integrations: [mdx(), sitemap({ filter: (page) => !page.includes('/play/') })],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      defaultColor: false,
      langs: [sprout],
    },
  },
});
