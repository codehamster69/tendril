// Integer reference implementation of the proposed v4 table rule (rev 2) + synthetic month of play.
// node brain/notes/E1a-market-sim.mjs            (SMOOTH=0 disables the 3:2:1 average for comparison)
export const BASE=[0,2,3,1,6,4,5,8];                  // item 1..7: carrot wheat clover pumpkin berry apple honey
export const TARGET=[0,194,129,388,65,97,78,49];      // permille of units; = equal revenue share (units ~ 1/base price), sums to 1000
export const MIN_PLAYERS=10, STEP=250, LO=500, HI=2000, W=process.env.SMOOTH==='0'?[1,0,0]:[3,2,1];
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
// Blended target share: half the fixed equal-revenue share, half the trailing mean of observed shares over the last
// WINDOW rows (days) that had enough data; the fixed share alone until MIN_VALID valid days exist. TRAIL_NUM/DEN = weight of the trailing half.
export const WINDOW=14, MIN_VALID=7, TRAIL_NUM=+process.env.TRAIL_NUM||1, TRAIL_DEN=+process.env.TRAIL_DEN||2;
export function blendedTarget(hist /* observed share vectors (or null) of the last rows, newest last, incl. today's */){
  const win=hist.slice(-WINDOW).filter(Boolean), t=[0];
  for(let c=1;c<=7;c++){
    if(win.length<MIN_VALID){ t[c]=TARGET[c]; continue; }
    let sum=0; for(const h of win) sum+=h[c];
    const trail=Math.floor(sum/win.length);
    t[c]=Math.max(1,Math.floor(((TRAIL_DEN-TRAIL_NUM)*TARGET[c]+TRAIL_NUM*trail)/TRAIL_DEN));
  }
  return t;
}
// observed shares of one day's per-player sold vectors, or null when fewer than MIN_PLAYERS counted
export function observedShare(sold){
  const rows=sold.filter(s=>{let u=0;for(let c=1;c<=7;c++)u+=s[c];return u>0});
  const N=rows.length; if(N<MIN_PLAYERS) return null;
  const sh=[0];
  for(let c=1;c<=7;c++){ let sum=0; for(const s of rows){let u=0;for(let k=1;k<=7;k++)u+=s[k];sum+=Math.floor(1000*s[c]/u)} sh[c]=Math.floor(sum/N); }
  return sh;
}
// raw target multipliers (permille): neutral when too little data, else against the blended target share
export function rawTarget(share, tgt){
  const t=[0];
  for(let c=1;c<=7;c++){
    if(!share){ t[c]=1000; continue; }
    const rho=Math.floor(1000*share[c]/tgt[c]);
    t[c]=clamp(Math.floor(2000000/(1000+rho)),LO,HI);
  }
  return t;
}
const NEUTRAL=[0,...Array(7).fill(1000)];
// hist = raw targets of the two previous days (null/undefined = neutral)
export function nextMult(prev, raw, h1, h2){
  const a=raw, b=h1||NEUTRAL, d=h2||NEUTRAL, m=[0];
  for(let c=1;c<=7;c++){
    const avg=Math.floor((W[0]*a[c]+W[1]*b[c]+W[2]*d[c])/(W[0]+W[1]+W[2]));
    m[c]=prev[c]+clamp(avg-prev[c],-STEP,STEP);
  }
  return m;
}
export const centi=m=>m.map((x,c)=>c?Math.floor(BASE[c]*x/10):0);
let seed=12345; const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296};
function players(n,m,o={}){
  const out=[];
  for(let i=0;i<n;i++){
    const s=Array(8).fill(0), scale=100+Math.floor(rnd()*500);
    if(o.fixed){ const f=o.fixed(i); for(let c=1;c<=7;c++) s[c]=Math.floor(scale*f[c]/1000); out.push(s); continue; }
    if(o.mono && i<o.mono){ s[o.crop]=scale; out.push(s); continue; }
    let tot=0; const w=[0];
    for(let c=1;c<=7;c++){ w[c]=TARGET[c]*Math.pow(m[c]/1000,o.k??3)*(0.6+rnd()*0.8); tot+=w[c]; }
    for(let c=1;c<=7;c++) s[c]=Math.floor(scale*w[c]/tot);
    out.push(s);
  }
  return out;
}
export let DAYS=30;
export function run(name,nOf,opt=()=>({}),quiet){
  let m=[0,...Array(7).fill(1000)], h1=null, h2=null, lo=1e9, hi=0, maxStep=0, rows=[], shares=[];
  for(let d=1; d<=DAYS; d++){
    const n=nOf(d), sh=observedShare(n>0?players(n,m,opt(d)||{}):[]); shares.push(sh);
    const raw=rawTarget(sh,blendedTarget(shares)), nm=nextMult(m,raw,h1,h2);
    for(let c=1;c<=7;c++){ lo=Math.min(lo,nm[c]); hi=Math.max(hi,nm[c]); maxStep=Math.max(maxStep,Math.abs(nm[c]-m[c])); }
    h2=h1; h1=raw; m=nm; rows.push([d,n,...m.slice(1)]);
  }
  // wobble over days 10..30: direction reversals per item and swing (max-min)
  let rev=0, swing=0;
  for(let c=0;c<7;c++){
    let last=0, mn=1e9, mx=0;
    for(let i=9;i<DAYS;i++){ const v=rows[i][2+c], dlt=v-rows[i-1][2+c]; mn=Math.min(mn,v); mx=Math.max(mx,v);
      if(dlt!==0){ if(last&&Math.sign(dlt)!==last) rev++; last=Math.sign(dlt);} }
    swing=Math.max(swing,mx-mn);
  }
  if(!quiet) console.log(`\n${name}: min ${lo/10}% max ${hi/10}% maxDailyStep ${maxStep/10} pts | days10-30 reversals ${rev}/147, worst swing ${swing/10} pts`);
  return {rows,lo,hi,maxStep,rev,swing};
}
const show=(rows,days=[1,2,3,4,5,6,8,12,16,20,25,30])=>{console.log('day  n  carrot wheat clover pumpkin berry apple honey (% of base)');
  for(const r of rows) if(days.includes(r[0])) console.log(String(r[0]).padStart(3),String(r[1]).padStart(5),...r.slice(2).map(x=>String(x/10).padStart(6)))};
if (process.argv[1].endsWith('E1a-market-sim.mjs')){
  console.log('weights',W.join(':'),'step',STEP/10,'pts min players',MIN_PLAYERS);
  show(run('A steady 200 players',()=>200).rows);
  show(run('B growth 8 -> 3000 players',d=>Math.floor(8*Math.pow(3000/8,(d-1)/29))).rows);
  show(run('C 30 of 200 sell only wheat every day',()=>200,()=>({mono:30,crop:2})).rows);
  show(run('D 20% of 50 sell only carrots',()=>50,()=>({mono:10,crop:1})).rows);
  show(run('E 200 players, 10 dormant days, then 6, then 12',d=>d<=10?200:d<=20?0:d<=25?6:12).rows);
  show(run('F herding, price sensitivity k=8',()=>200,()=>({k:8})).rows);
  show(run('G everyone sells only carrots',()=>200,()=>({mono:200,crop:1})).rows);
  show(run('H everyone sells only honey for 12 days then back to normal',()=>200,d=>d<=12?{mono:200,crop:7}:{}).rows);
  // (a) 90% of volume is carrot for 30 days (rest follows the fixed mix); carrot must settle above the floor
  const mix=(c1,frac)=>()=>{const f=Array(8).fill(0);let rest=0;for(let c=1;c<=7;c++)if(c!==c1)rest+=TARGET[c];
    for(let c=1;c<=7;c++)f[c]=c===c1?frac:Math.floor((1000-frac)*TARGET[c]/rest);return f};
  show(run('(a) 90% of volume is carrot, 30 days',()=>200,()=>({fixed:mix(1,900)})).rows);
  // (b) crowd is 90% carrot until day 14, 90% wheat from day 15 (45 days, to see re-centring)
  DAYS=45;
  const b=run('(b) 90% carrot, shifts to 90% wheat on day 15',()=>200,d=>({fixed:d<15?mix(1,900):mix(2,900)}));
  show(b.rows,[1,5,10,14,15,16,17,18,20,23,26,29,35,40,45]);
  console.log('carrot/wheat multipliers day 14..18:',b.rows.slice(13,18).map(r=>r[2]/10+'/'+r[3]/10).join('  '));
}
