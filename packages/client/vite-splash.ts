// Inlines the splash screen (CSS, markup and a tiny script) into every page so it paints before any module loads.
// One source for index.html, replay.html and room.html. boot.ts takes over once the app script runs.
const CSS = `
html{background:#14110f}
#splash{position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:radial-gradient(120% 90% at 50% 20%,#2a2018,#14110f 70%);color:#f4ead8;font:600 15px/1.4 'Atkinson Hyperlegible Next',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;opacity:1;transition:opacity .4s ease}
#splash.sp-out{opacity:0;pointer-events:none}
#splash .sp-mark{width:84px;height:84px;fill:none;stroke:#8fcf6a;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
#splash .sp-name{font:700 34px/1 'Bricolage Grotesque','Avenir Next',ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em}
#splash .sp-bar{position:relative;width:min(320px,70vw);height:6px;border-radius:999px;background:rgba(244,234,216,.16);overflow:visible}
#splash .sp-bar i{position:absolute;left:0;top:0;bottom:0;width:calc(var(--p,0)*100%);border-radius:999px;background:linear-gradient(90deg,#8fcf6a,#f2b84b);transition:width .25s ease}
#splash .sp-bar b{position:absolute;top:-5px;left:calc(var(--p,0)*100% - 8px);width:16px;height:16px;transition:left .25s ease}
#splash .sp-bar b svg{display:block;width:16px;height:16px;fill:#8fcf6a}
#splash .sp-status{margin:0;color:#c9b99c;font-size:14px;min-height:1.4em}
#splash .sp-tip{margin:0;max-width:min(420px,84vw);text-align:center;color:#c9b99c;font-size:13px;font-weight:400}
#splash .sp-tip b{color:#f2b84b;font-weight:600}
#splash .sp-fail{display:none;flex-direction:column;align-items:center;gap:10px;max-width:min(420px,84vw);text-align:center}
#splash.sp-failed .sp-fail{display:flex}
#splash.sp-failed .sp-bar,#splash.sp-failed .sp-status{display:none}
#splash .sp-fail p{margin:0;color:#ef7a66}
#splash .sp-fail button{font:inherit;color:#14110f;background:#f2b84b;border:0;border-radius:999px;padding:.5rem 1.2rem;cursor:pointer}
#splash .sp-fail button:focus-visible{outline:2px solid #f4ead8;outline-offset:2px}
#farm-stage.sp-glide canvas{animation:sp-glide .9s cubic-bezier(.2,.7,.2,1) both}
@keyframes sp-glide{from{transform:scale(1.07)}to{transform:scale(1)}}
@media (prefers-reduced-motion:reduce){#splash,#splash .sp-bar i,#splash .sp-bar b{transition:none}#farm-stage.sp-glide canvas{animation:none}}
`;

const MARKUP = `<div id="splash" role="status" aria-live="polite">
<svg class="sp-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 29c0-9 0-15 0-18"/><path d="M16 15c-6 0-10-4-10-10 6 0 10 4 10 10Z"/><path d="M16 12c0-5 3-8 9-8 0 5-3 8-9 8Z"/></svg>
<div class="sp-name">Tendril</div>
<div class="sp-bar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i><b><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14C2 6 6 2 14 2c0 8-4 12-12 12Z"/></svg></b></div>
<p class="sp-status">Starting up…</p>
<p class="sp-tip"></p>
<div class="sp-fail"><p></p><button type="button">Retry</button></div>
</div>`;

// Runs before any module: shows one tip per load, and reports a script or style file that failed to load.
const SCRIPT = `(function(){var s=document.getElementById('splash');if(!s)return;
var tips=['Actions cost ticks. Questions are free.','<b>scan()</b> describes the tile below your bot.','Indent the lines that belong inside a <b>repeat</b> block.','<b>wait 100</b> gives a carrot time to grow.','Press <b>Space</b> to run or pause. <b>F10</b> steps one line.','<b>F9</b> sets a breakpoint on the current line.','A run is a day. Run to sunset to see your score.'];
var n=0;try{n=(parseInt(localStorage.getItem('tendril.tip'),10)||0)+1;localStorage.setItem('tendril.tip',String(n))}catch(e){n=Math.floor(Math.random()*tips.length)}
s.querySelector('.sp-tip').innerHTML=tips[n%tips.length];
function fail(m){s.classList.add('sp-failed');s.querySelector('.sp-fail p').textContent=m;s.setAttribute('role','alert')}
window.__splashFail=fail;
s.querySelector('.sp-fail button').addEventListener('click',function(){location.reload()});
window.addEventListener('error',function(e){var t=e.target;if(t&&(t.tagName==='SCRIPT'||t.tagName==='LINK'))fail('Tendril could not load its files. Check your connection and try again.')},true);
})();`;

export function splash() {
  return {
    name: 'tendril-splash',
    transformIndexHtml: {
      order: 'pre' as const,
      handler: (html: string) => html
        .replace(/<head>/i, `<head>\n<style id="splash-css">${CSS}</style>`)
        .replace(/<body([^>]*)>/i, `<body$1>\n${MARKUP}\n<script>${SCRIPT}</script>`),
    },
  };
}
