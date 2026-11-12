// Astro integration: after the build, draw a 1200x630 social card for every page from its own
// og:title / og:description and write it to dist/og/<page>.png. Base.astro points og:image there.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const fontDir = join(here, '..', 'og-fonts');

/** The card path for a page path, shared with Base.astro. "/" -> "/og/index.png", "/docs/faq/" -> "/og/docs/faq.png" */
export function ogPath(pathname) {
  const p = pathname.replace(/\/index\.html$|\.html$/, '').replace(/^\/+|\/+$/g, '');
  return `/og/${p || 'index'}.png`;
}

const C = { paper: '#edefe6', ink: '#1e2b1e', dim: '#4f5c4b', leaf: '#2f6e35', leafInk: '#f3f6ee', soil: '#5b3f2b', line: '#d4d8c8', wheat: '#d9a441', carrot: '#e07b39' };
const h = (type, style, ...children) => ({ type, props: { style: { display: 'flex', ...style }, children: children.flat().filter((c) => c !== null && c !== false) } });

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'");
const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`)) || html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${prop}"`));
  return m ? decode(m[1]) : '';
};
const clip = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 1)).replace(/[,.;:]$/, '') + '…');

function section(pathname) {
  if (pathname.startsWith('/docs/reference')) return 'Sprout reference';
  if (pathname.startsWith('/docs')) return 'Docs';
  if (pathname.startsWith('/leaderboard')) return 'Leaderboard';
  if (pathname.startsWith('/download')) return 'Download';
  return null;
}

// A strip of farm along the bottom edge: soil with crops at different stages.
function field() {
  const crops = [C.leaf, C.wheat, C.leaf, C.carrot, C.leaf, C.leaf, C.wheat, C.leaf, C.carrot, C.leaf, C.leaf, C.wheat, C.leaf, C.carrot];
  return h('div', { width: 1200, height: 64, flexDirection: 'column' },
    h('div', { width: 1200, height: 30, alignItems: 'flex-end', justifyContent: 'space-evenly' },
      crops.map((c, i) => h('div', { width: 26, height: 12 + ((i * 7) % 18), background: c, borderRadius: '13px 13px 3px 3px' }))),
    h('div', { width: 1200, height: 34, background: C.soil }));
}

function card({ title, description, label, host, logo }) {
  const size = title.length > 48 ? 64 : title.length > 28 ? 76 : 92;
  return h('div', { width: 1200, height: 630, background: C.paper, flexDirection: 'column', fontFamily: 'Atkinson' },
    h('div', { width: 1200, height: 566, flexDirection: 'column', padding: '60px 80px 24px' },
      h('div', { alignItems: 'center', gap: 18 },
        { type: 'img', props: { src: logo, width: 60, height: 60 } },
        h('div', { fontFamily: 'Bricolage', fontSize: 40, color: C.ink }, 'Tendril'),
        label ? h('div', { marginLeft: 8, fontSize: 26, color: C.leaf, border: `2px solid ${C.leaf}`, borderRadius: 999, padding: '4px 18px' }, label) : null),
      h('div', { flexDirection: 'column', flexGrow: 1, justifyContent: 'center' },
        h('div', { fontFamily: 'Bricolage', fontSize: size, lineHeight: 1.05, color: C.ink, letterSpacing: -1.5, maxWidth: 1000 }, title),
        description ? h('div', { fontSize: 32, lineHeight: 1.4, color: C.dim, marginTop: 24, maxWidth: 960 }, clip(description, 150)) : null),
      h('div', { fontFamily: 'Mono', fontSize: 24, color: C.leaf }, host)),
    field());
}

async function* htmlFiles(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'play' && e.name !== '_astro') yield* htmlFiles(p); }
    else if (e.name.endsWith('.html') && e.name !== '404.html') yield p;
  }
}

export default function og() {
  let site;
  return {
    name: 'tendril-og',
    hooks: {
      'astro:config:done': ({ config }) => { site = config.site; },
      'astro:build:done': async ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        const fonts = [
          { name: 'Bricolage', data: await readFile(join(fontDir, 'bricolage-800.ttf')), weight: 800 },
          { name: 'Atkinson', data: await readFile(join(fontDir, 'atkinson-400.ttf')), weight: 400 },
          { name: 'Mono', data: await readFile(join(fontDir, 'jetbrains-600.ttf')), weight: 600 },
        ];
        const logo = `data:image/svg+xml;base64,${(await readFile(join(here, '..', 'public', 'favicon.svg'))).toString('base64')}`;
        const host = new URL(site ?? 'https://tendril.hokora.xyz').host;
        let n = 0;
        for await (const file of htmlFiles(out)) {
          const pathname = '/' + relative(out, file).split(sep).join('/');
          const html = await readFile(file, 'utf8');
          const title = meta(html, 'og:title').replace(/ \| Tendril$/, '').replace(/^Tendril: /, '');
          if (!title) continue;
          const t = title.charAt(0).toUpperCase() + title.slice(1);
          const svg = await satori(card({ title: t, description: meta(html, 'og:description'), label: section(pathname), host, logo }), { width: 1200, height: 630, fonts });
          const target = join(out, ogPath(pathname));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
          n++;
        }
        logger.info(`${n} social cards written to /og/`);
      },
    },
  };
}
