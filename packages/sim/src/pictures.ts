// Crop Circles (SIM_SPEC section 7): the picture pool and the procedural fallback. Pure; no I/O, no clock.
// Every picture here is original pixel art released under CC0, drawn for Tendril. The pool is data; `drawPicture` picks from it by the brief seed.
import type { Picture } from './types.ts';
import { rand } from './weather.ts';

/**
 * Cell codes of a picture, one character each in `Picture.cells`: 0 untilled grass, 1 tilled soil, 2..7 a ripe crop (code = crop id + 1:
 * carrot, wheat, clover, pumpkin, berry, apple), 8 the barn pixel (matches anything). That is eight colours plus the barn.
 */
export const PICTURE_PALETTE: readonly string[] = ['grass', 'soil', 'carrot', 'wheat', 'clover', 'pumpkin', 'berry', 'apple', 'barn'];
export const PIC_GRASS = 0, PIC_SOIL = 1, PIC_BARN = 8;
/** Letters used in the readable pool below, in code order (`B` is the barn). */
const LETTERS = '.scwlpbaB';
/** Sizes a picture may have: 8x8 (the barn plot), 16x8 (two plots) or 16x16 (four plots). */
export const PICTURE_SIZES: readonly (readonly [number, number])[] = [[8, 8], [16, 8], [16, 16]];
/** Share of the draws that use a procedural glyph instead of the hand-made pool: 1 in `GLYPH_ONE_IN`. */
export const GLYPH_ONE_IN = 5;

const toCells = (rows: string): string => [...rows.replaceAll('/', '')].map((ch) => String(LETTERS.indexOf(ch))).join('');

// [id, title, w, h, rows joined by '/'] . grass, s soil, c carrot, w wheat, l clover, p pumpkin, b berry, a apple, B barn.
// Tile (0,0) of every picture is the barn pixel.
const POOL: readonly (readonly [string, string, number, number, string])[] = [
  ['heart', "A heart", 8, 8, 'Bsssssss/.bb..bb./bbbbbbbb/bbbbbbbb/bbbbbbbb/.bbbbbb./ssbbbbss/...bb...'],
  ['apple', "An apple", 8, 8, 'B..ll.../saaaaaas/aaaaaaaa/aaaaaaaa/aaaaaaaa/aaaaaaaa/.aaaaaa./ssaaaass'],
  ['carrot', "A carrot", 8, 8, 'B.lllls./.lllllls/scccccc./.ccccccs/s.ccccs./.scccc.s/s.scc.s./.s.ccs.s'],
  ['pumpkin', "A pumpkin", 8, 8, 'Bs.lls.s/spppppp./pppppppp/pppppppp/pppppppp/pppppppp/.pppppps/s.s.s.s.'],
  ['strawberry', "A strawberry", 8, 8, 'Blllllls/saaaaaas/aaaaaaaa/aaaaaaaa/saaaaaas/saaaaaas/s.aaaa.s/sssaasss'],
  ['sheaf', "A wheat sheaf", 8, 8, 'B.sww.s./s.wwwws./swwwwww./swwwwww./s.lllls./s.sll.s./s.sll.s./s.lllls.'],
  ['mushroom', "A mushroom", 8, 8, 'Bsaaaa.s/.aaaaaas/aawaawaa/aaaaaaaa/.swwww.s/.swwww.s/.swwww.s/.wwwwwws'],
  ['tree', "A tree", 8, 8, 'Bsllllss/slllllls/llllllll/llllllll/slllllls/ss.pp.ss/sssppsss/ssppppss'],
  ['flower', "A flower", 8, 8, 'Bsaaaa../sawwwwa./.awwwwas/..aaaass/ss.lls../ssllll../..sll.ss/..sll.ss'],
  ['farmhouse', "A farmhouse", 8, 8, 'Bssaasss/..aaaa../saaaaaas/aaaaaaaa/wwwwwwww/wwppppww/wwppppww/wwppppww'],
  ['star', "A star", 8, 8, 'B..ww.../ssswwsss/wwwwwwww/swwwwwws/..wwww../swwwwwws/.ww..ww./swssssws'],
  ['cat', "A cat", 8, 8, 'Bcs.s.cp/pccccccp/clcccclc/cccccccc/cccppccc/.ccccccs/s.ccccs./.s.s.s.s'],
  ['rabbit', "A rabbit", 8, 8, 'Bw.s.sws/sws.s.w./.wws.wws/wwwwwwww/wlwwwwlw/wwwwwwww/.wwwwwws/s.sbb.s.'],
  ['owl', "An owl", 8, 8, 'Bssssssb/bbbbbbbb/bwwbbwwb/bwlbblwb/bbbbbbbb/bwwwwwwb/sbwwwwbs/ssccccss'],
  ['frog', "A frog", 8, 8, 'Bws.s.wl/llllllll/llllllll/llllllll/lwwwwwwl/sllllll./l.llllsl/l.s.s.sl'],
  ['butterfly', "A butterfly", 8, 8, 'Bp.wwspp/pppwwppp/.ppwwpps/.slwwl.s/.bbwwbbs/bbbwwbbb/bb.wwsbb/bs.wws.b'],
  ['ladybird', "A ladybird", 8, 8, 'Bsaaaass/saaaaaas/abaaaaba/aaabbaaa/aaaaaaaa/abaaaaba/saaaaaas/ssaaaass'],
  ['bee', "A bee", 8, 8, 'Bs..ss.l/ll..ssll/.wwwwwws/.bbbbbbs/swwwwww./sbbbbbb./..wwwwss/..sbb.ss'],
  ['skull', "A skull", 8, 8, 'Bwwwwwws/wwwwwwww/wbbwwbbw/wbbwwbbw/wwwwwwww/.wwwwww./swbwwbws/.wwwwww.'],
  ['ghost', "A ghost", 8, 8, 'Bwwwwww./wwwwwwww/wbwwwwbw/wwwwwwww/wwwwwwww/wwwwwwww/wwwwwwww/wswsswsw'],
  ['robot', "A robot", 8, 8, 'B.spp.s./.wwwwwws/wllwwllw/wwwwwwww/wbbbbbbw/.wwwwwws/swsww.w./.w.wwsws'],
  ['crown', "A crown", 8, 8, 'Bsws.w.w/w.wwwwsw/wwwwwwww/wpwppwpw/wwwwwwww/wwwwwwww/.s.s.s.s/s.s.s.s.'],
  ['mug', "A mug", 8, 8, 'Bsssssss/wwwwwwww/wwwwwwww/wwwwwwww/wwwwwwww/swwwwwws/swwwwwws/sswwwwss'],
  ['bell', "A bell", 8, 8, 'B.sww.s./s.wwwws./swwwwww./swwwwww./wwwwwwww/wwwwwwww/wwwwwwww/s.pppps.'],
  ['sun', "The sun", 8, 8, 'Bs.wws.s/wswwww.w/.wwwwwws/wwwwwwww/wwwwwwww/.wwwwwws/wswwww.w/.s.wws.s'],
  ['pine', "A pine tree", 8, 8, 'Bs.lls../ssllll../..llllss/.lllllls/sllllll./llllllll/..spp.ss/..spp.ss'],
  ['cactus', "A cactus", 8, 8, 'Bs.lls../ss.lls../l.sll.sl/l.llllsl/llllllll/ss.lls../..sll.ss/..sll.ss'],
  ['gem', "A gem", 8, 8, 'Bssbbsss/..bbbb../sbbbbbbs/bbbbbbbb/bbbbbbbb/.bbbbbb./ssbbbbss/...bb...'],
  ['kite', "A kite", 8, 8, 'B..pp.../ssppppss/.pppppp./pppppppp/.pppppp./ssppppss/...ww.../sssllsss'],
  ['balloon', "A balloon", 8, 8, 'Bpppppp./pppppppp/pppppppp/pppppppp/spppppp./.spppp.s/s.sll.s./.s.lls.s'],
  ['tulip', "A tulip", 8, 8, 'Bs.aas.a/aaaaaaaa/aaaaaaaa/saaaaaa./.s.lls.s/s.sll.s./.lllllls/s.sll.s.'],
  ['sunflower', "A sunflower", 8, 8, 'Bswwwwsw/swwwwwws/wwppppww/wppppppw/wwppppww/swwwwwws/s..ll..s/ssllllss'],
  ['acorn', "An acorn", 8, 8, 'B.spp.s./spppppp./pppppppp/swwwwww./swwwwww./s.wwwws./s.wwwws./s.sww.s.'],
  ['pear', "A pear", 8, 8, 'Bs.wws.s/.sllll.s/.sllll.s/.lllllls/.lllllls/llllllll/llllllll/.lllllls'],
  ['grapes', "A bunch of grapes", 8, 8, 'Bssllsss/bbbbbbbb/bbbbbbbb/sbbbbbbs/ssbbbbss/ssbbbbss/sssbbsss/sssbbsss'],
  ['corn', "A corn cob", 8, 8, 'Bs.wws../sswwww../..wwwwss/..wwwwss/sswwww../slwwwwl./.lllllls/..llllss'],
  ['beet', "A beetroot", 8, 8, 'Bsllllss/..llll../sbbbbbbs/bbbbbbbb/bbbbbbbb/.bbbbbb./ssbbbbss/...bb...'],
  ['bat', "A bat", 8, 8, 'B......b/bbssssbb/bbbbbbbb/bbpbbpbb/bbbbbbbb/bsbbbbsb/......../ssssssss'],
  ['bird', "A little bird", 8, 8, 'B.ccccs./.ccccccs/clcccclc/ccppppcc/scccccc./.scccc.s/s.w.sws./.wws.wws'],
  ['bear', "A bear", 8, 8, 'Bc.s.scc/cccccccc/clcccclc/cwwwwwwc/cwppppwc/scccccc./.ccccccs/s.s.s.s.'],
  ['pig', "A pig", 8, 8, 'Bcsssscc/cccccccc/clcccclc/cccccccc/ccppppcc/ccppppcc/sccccccs/ssssssss'],
  ['sheep', "A sheep", 8, 8, 'Bwwwwww./wwwwwwww/wwwwwwww/wccccccw/wclcclcw/wccccccw/scccccc./s.ccccs.'],
  ['cow', "A cow", 8, 8, 'Bs.s.s.p/wwwwwwww/wwbwwbww/wwwwwwww/wwwwwwww/wppppppw/.pppppps/.s.s.s.s'],
  ['turtle', "A turtle", 8, 8, 'Bssccsss/csllllsc/slwwwwls/llwwwwll/llwwwwll/slwwwwls/csllllsc/sssccsss'],
  ['crab', "A crab", 8, 8, 'Bs..ss.a/aa..ssaa/.aaaaaas/aalaalaa/aaaaaaaa/saaaaaa./a.as.asa/a.ss..sa'],
  ['hourglass', "An hourglass", 8, 8, 'Bwwwwwww/.wwwwww./sswwwwss/...ww.../ssswwsss/..wwww../swwwwwws/wwwwwwww'],
  ['castle', "A castle", 8, 8, 'B.w..w.w/wwwwwwww/wwwwwwww/wwwwwwww/wwppppww/wwppppww/wwppppww/wwppppww'],
  ['rocket', "A rocket", 8, 8, 'B.scc.s./.swwww.s/s.wllws./.wwwwwws/swwwwww./ccwwwwcc/c.ppppsc/.s.pps.s'],
  ['smiley', "A smiley face", 8, 8, 'Bwwwwwws/wwwwwwww/wbwwwwbw/wwwwwwww/wwwwwwww/wbwwwwbw/.bbbbbbs/s.wwwws.'],
  ['pumpkinface', "A jack-o-lantern", 8, 8, 'Bssllsss/spppppps/pbppppbp/pppppppp/pbpbbpbp/sppbbpps/s.pppp.s/ssssssss'],
  ['lollipop', "A lollipop", 8, 8, 'Baaaaaa./aawwwwaa/awaaaawa/aaaaaaaa/saaaaaa./s.sll.s./s.sll.s./s.sll.s.'],
  ['clover', "A four-leaf clover", 8, 8, 'Blls.lls/llllllll/llllllll/.lllllls/.sllll.s/.s.lls.s/.s.lls.s/.sllll.s'],
  ['cherries', "Cherries", 8, 8, 'Blsllsls/lslsslsl/ls.ll.sl/as.aa.sa/aa.aa.aa/aa.aa.aa/sassssas/ssssssss'],
  ['teapot', "A teapot", 8, 8, 'Bs.pps../spppppp./pppppppp/pppppppp/pppppppp/spppppp./.pppppps/..ss..ss'],
  ['lantern', "A lantern", 8, 8, 'Bssppsss/..pppp../spppppps/pppppppp/pppppppp/.pppppp./ssppppss/...pp...'],
  ['plus', "A plus sign", 8, 8, 'B..pp.../sssppsss/...pp.../pppppppp/pppppppp/sssppsss/...pp.../sssppsss'],
  ['arrow', "An arrow", 8, 8, 'B.sww.s./.swwww.s/swwwwww./wwwwwwww/s.sww.s./.s.wws.s/s.sww.s./.s.wws.s'],
  ['bowl', "A fruit bowl", 8, 8, 'Bc.bbscs/cbcbbcbc/pppppppp/spppppp./.pppppps/s.pppps./.spppp.s/s.s.s.s.'],
  ['tulips', "Two tulips", 8, 8, 'Bssppssp/pppppppp/spp..pps/sll..lls/sll..lls/sll..lls/sll..lls/ssssssss'],
  ['mouse', "A mouse", 8, 8, 'Bws.s.ww/wwwwwwww/wlwwwwlw/wwwwwwww/wwppppww/swwwwww./swsww.w./s.s.s.s.'],
  ['lion', "A lion", 8, 8, 'Bppppppp/cccccccc/clcccclc/cccccccc/cppppppc/.ccccccs/.scccc.s/.s.s.s.s'],
  ['koala', "A koala", 8, 8, 'Bwssssww/wwwwwwww/wlwwwwlw/wwwwwwww/wwppppww/swwwwwws/swwwwwws/ssssssss'],
  ['dragonfly', "A dragonfly", 8, 8, 'Bs..ss.l/ll..ssll/.lsww.ls/..wwwwss/sswwww../sslwwl../..sww.ss/..sww.ss'],
  ['tent', "A tent", 8, 8, 'Bssppsss/..pppp../spppppps/pppppppp/ppwwwwpp/ppwwwwpp/ppwwwwpp/ppwwwwpp'],
  ['barnhouse', "A little barn", 8, 8, 'B.aaaa../saaaaaas/aaaaaaaa/aaaaaaaa/awawwawa/aapwwpaa/aapwwpaa/aapwwpaa'],
  ['fence', "A fence", 8, 8, 'B.ppppsp/pppppppp/p.ppppsp/pppppppp/p.ppppsp/pspppp.p/p.ppppsp/pspppp.p'],
  ['pawprint', "A paw print", 8, 8, 'Bp.ppsps/s.s.s.s./.pppppps/pppppppp/pppppppp/spppppp./.p.ppsps/s.s.s.s.'],
  ['pizza', "A pizza slice", 8, 8, 'Bwwwwwww/wwpwwpww/swwwwwws/swpwwpws/s.wwww.s/s.wwww.s/s..ww..s/ssswwsss'],
  ['cupcake', "A cupcake", 8, 8, 'B.scc.s./swwwwww./wwwwwwww/wwwwwwww/spppppp./spppppp./spppppp./s.pppps.'],
  ['icecream', "An ice cream", 8, 8, 'Bwwwwwws/wwwwwwww/wwwwwwww/.pppppps/.pppppps/.spppp.s/.spppp.s/.s.pps.s'],
  ['eggs', "A fried egg", 8, 8, 'Bwwwwwws/wwwwwwww/wwppppww/wppppppw/wwppppww/swwwwwws/ssssssss/ssssssss'],
  ['bunch', "A bunch of carrots", 8, 8, 'Bsl.sl.l/lsl.sl.l/ccscc.cc/ccscc.cc/sc.ccsc./sc.ccsc./..cs.css/..ss..ss'],
  ['farmerhat', "A farmer hat", 8, 8, 'Bsssssss/.wwwwww./wwwwwwww/wwwwwwww/wwwwwwww/pppppppp/pppppppp/........'],
  ['scarecrow', "A scarecrow", 8, 8, 'Bwwwwww./wwwwwwww/wbwwwwbw/wppwwppw/.wwwwww./pppppppp/.pppppp./spsppsps'],
  ['seedling', "A seedling", 8, 8, 'B.s.s.s./.s.s.s.s/l.sll.sl/llllllll/sllllll./.s.lls.s/s.spp.s./.s.pps.s'],
  ['watering', "A watering drop", 8, 8, 'Bs.lls.s/s.lllls./.lllllls/sllllll./llllllll/llllllll/llllllll/sllllll.'],
  ['egg', "An egg", 8, 8, 'Bswwwwss/swwwwwws/swwwwwws/wwwwwwww/wwwwwwww/wwwwwwww/swwwwwws/sswwwwss'],
  ['cloverleaf', "A shamrock", 8, 8, 'Bll.sll./llllllll/sllllll./s.lllls./sllwwll./s.lwwls./s.sww.s./s.sww.s.'],
  ['rainbow', "A rainbow", 16, 8, 'Bsaaaaaaaaaaaa.s/.aappppppppppaas/aappwwwwwwwwppaa/appwwllllllwwppa/apwwllbbbbllwwpa/apwlbb.s.sbblwpa/apwlbs.s.s.blwpa/apwlbs.s.s.blwpa'],
  ['bridge', "A bridge", 16, 8, 'Bsssssssssssssss/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wswwww.ww.wwwwsw/wswppp.ww.pppwsw/wswppp.ww.pppwsw/pppppppppppppppp/ssssssssssssssss'],
  ['wingedbutterfly', "A big butterfly", 16, 8, 'Bs..sspwwp..ss.p/pp..sppwwpp.sspp/pppp.ppwwppspppp/pppp..lwwlsspppp/sbbbsslwwl..bbb./bbbbbsbwwb.bbbbb/bbbb..bwwbssbbbb/.bbs..sww.ss.bbs'],
  ['bigbat', "A bat in flight", 16, 8, 'Bssssssbbssssssb/bb....bbbb....bb/bbbssbbbbbbssbbb/bbbbbbbbbbbbbbbb/bsbbbbpbbpbbbbsb/....bbbbbbbb..../sssssssbbsssssss/................'],
  ['mustache', "A mustache", 16, 8, 'B.............../ssssssssssssssss/.pp..pppppp..pp./pppppppppppppppp/p.pppppppppppp.p/ssssssssssssssss/................/ssssssssssssssss'],
  ['glasses', "A pair of glasses", 16, 8, 'B.s.s.s.s.s.s.s./.bbbbs.s.s.bbbbs/b.s.sbs.s.b.s.sb/bsws.b.s.sbs.w.b/b.s.sbbbbbb.s.sb/.bbbbs.s.s.bbbbs/s.s.s.s.s.s.s.s./.s.s.s.s.s.s.s.s'],
  ['bowtie', "A bow tie", 16, 8, 'Bs.s.s.s.s.s.s.s/a.s.s.saa.s.s.sa/aaas.aaaaaas.aaa/aaaaaaaaaaaaaaaa/aaas.aaaaaas.aaa/a.s.s.saa.s.s.sa/.s.s.s.s.s.s.s.s/s.s.s.s.s.s.s.s.'],
  ['smile', "A big smile", 16, 8, 'B.............../ssssssssssssssss/w......ww......w/swsssswsswssssws/..wwwww..wwwww../ssswwwsssswwwsss/................/ssssssssssssssss'],
  ['pyramid', "A pyramid", 16, 8, 'B.s.s.sww.s.s.s./s.s.s.wwwws.s.s./s.s.swwwwww.s.s./s.s.wwwwwwwws.s./s.swwwwwwwwww.s./s.wwwwwwwwwwwws./swwwwwwwwwwwwww./wwwwwwwwwwwwwwww'],
  ['bigbarn', "A big barn", 16, 8, 'Bs.saaaaaaaa.s.s/.saaaaaaaaaaaa.s/aaaaaaaaaaaaaaaa/awwwwwwwwwwwwwwa/awwwppppppppwwwa/awwwppppppppwwwa/awwwppppppppwwwa/awwwppppppppwwwa'],
  ['campsite', "A campsite", 16, 8, 'Bsssssssssssssss/sssssccccccsssss/ss..cccccccc..ss/ss.cccccccccc.ss/ssccccccccccccss/scccccppppcccccs/cccccppppppccccc/cccccppppppccccc'],
  ['waves', "Waves", 16, 8, 'Bsbbssbbbb..bb../sb..bb..ssbbssb./b.sb..bs.bssb.sb/..ss..ss..ss..ss/ssbbssbbbb..bb../sb..bb..ssbbssb./b.sb..bs.bssb.sb/..ss..ss..ss..ss'],
  ['castlewide', "A long wall", 16, 8, 'Bswswswsswswswsw/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwppppwwppppwww/wwwppppwwppppwww/wwwppppwwppppwww'],
  ['hedge', "A hedge", 16, 8, 'B.............../llllsllllllsllll/llllllllllllllll/llllllllllllllll/l.llllllllllll.l/llllsllllllsllll/pppppppppppppppp/ssssssssssssssss'],
  ['bigflowerbed', "A flower bed", 16, 8, 'B.b.c.b.sbscsbsc/.l.l.l.llslslsls/c.b.c.b.sbscsbsc/.l.l.l.llslslsls/pppppppppppppppp/pppppppppppppppp/s.s.s.s.s.s.s.s./.s.s.s.s.s.s.s.s'],
  ['trainfront', "A train", 16, 8, 'Bs.s.bbbbbbs.s.s/bbbbbbbbbbbbbbbb/bwwbwwbbbbwwbwwb/bbbbbbbbbbbbbbbb/bbbbbbbbbbbbbbbb/spp.spp.spp.spp./.s.s.s.s.s.s.s.s/s.s.s.s.s.s.s.s.'],
  ['bigcrown', "A royal crown", 16, 8, 'Bsswsswsswsswssw/ww.ww.wwww.ww.ww/wwwwwwwwwwwwwwww/wpwwwpwppwpwwwpw/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/s..............s/ssssssssssssssss'],
  ['sunset', "A sunset", 16, 8, 'B.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.scccccc.s.s./s.s.cpccccpcs.s./s.scppwccwppc.s./pppppppppppppppp/pppppppppppppppp/s.s.s.s.s.s.s.s.'],
  ['fish', "A fish", 16, 8, 'Bs.s.s.s.s.s.s.s/.sbbbb.s.s.sbsbs/.bbbbbbs.s.bbb.b/bbwlbbbbbsbbbbbb/bbbbbbbbbb.bbbbb/.bbbbbbs.s.bbb.b/.sbbbb.s.s.sbsbs/.s.s.s.s.s.s.s.s'],
  ['snake', "A snake", 16, 8, 'Bs..ssllls..ss../ss..sl..sl..ss../..ss..ss..ssl.ss/..slllss..sll.ss/ssl.ssl.ssl.ss../ssl.ss.lll..ss../..sl..ss..ss..ss/..ssllls..ssp.ss'],
  ['car', "A car", 16, 8, 'Bs..ss..ss..ss../ss..sccccs..ss../..ssccccccss..ss/..cccccccccc..ss/sccccccccccccs../sccccccccccccs../..pp..ss..pp..ss/..pp..ss..pp..ss'],
  ['boat', "A sailboat", 16, 8, 'Bsssssswssssssss/......ww......../ssssswwwssssssss/....wwww......../ssswwwwwssssssss/.......p......../cccccccccccccccc/.cccccccccccccc.'],
  ['caterpillar', "A caterpillar", 16, 8, 'B.............../ssssssssssssssss/.lll.lll.lll.ll./llllllllllllllll/lcllcllcllcllcll/sllssllssllsslls/.p.p.p.p.p.p.p.p/ssssssssssssssss'],
  ['snail', "A snail", 16, 8, 'B.s.s.s.s.s.s.s./.s.s.ppppp.s.s.s/s.s.pppppppps.s./.s.ppp.sppppps.s/s.spp.ppspppp.s./.s.pppppppppps.s/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwws'],
  ['whale', "A whale", 16, 8, 'Bs.s.s.s.s.s.s.s/s.s.sbbbbbs.s.s./.s.bbbbbbbbb.s.b/s.bbbbbbbbbbb.bb/.bbwbbbbbbbbbbbs/sbbbbbbbbbbbbbb./.sbbbbbbbbbbbb.s/s.sbbbbbbbbbb.s.'],
  ['tractor', "A tractor", 16, 8, 'Bsssssssssssssss/s...pp.........s/s...pppppp.....s/spppppppppp....s/spppppppppppp..s/s.pp....pp.....s/spppp..pppp....s/ssppssssppssssss'],
  ['trainside', "A freight train", 16, 8, 'B.s.s.s.s.s.s.s./s.ccc.sppps.ppp./s.ccc.sppps.ppp./cccccccccccccccc/cccccccccccccccc/sbb.sbb.sbb.sbb./s.s.s.s.s.s.s.s./wwwwwwwwwwwwwwww'],
  ['duck', "A duck", 16, 8, 'Bs.s.s.s.s.s.s.s/.s.s.s.scc.s.s.s/.s.s.s.ccccs.s.s/.s.s.s.cllcpps.s/.s.s.s.scccs.s.s/.swwwwwwwccs.s.s/.wwwwwwwwwws.s.s/.swwwwwwws.s.s.s'],
  ['dog', "A dog", 16, 8, 'Bs..ss..ss..ss../ss..pp..ss..ss../..spppps..ssp.ss/..spllppppppppps/ss.pppppppppppp./ss..pp.pps.ppsp./..ssppspp.spp.ss/..ssppspp.spp.ss'],
  ['bigheart', "A big heart", 16, 16, 'Bs..ss..ss..ss../sbbbbs..ss.bbbb./bbbbbbss..bbbbbb/bbbbbbbs.bbbbbbb/bbbbbbbbbbbbbbbb/bbbbbbbbbbbbbbbb/bbbbbbbbbbbbbbbb/bbbbbbbbbbbbbbbb/sbbbbbbbbbbbbbb./ssbbbbbbbbbbbb../..sbbbbbbbbbb.ss/..ssbbbbbbbb..ss/ss..sbbbbbb.ss../ss..ssbbbb..ss../..ss..sbb.ss..ss/..ss..ss..ss..ss'],
  ['bigapple', "A big apple", 16, 16, 'Bssssssppsssssss/......lppl....../ssaaaasppsaaaass/.aaaaaaaaaaaaaa./aaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaa/saaaaaaaaaaaaaas/.aaaaaaaaaaaaaa./ssaaaaaaaaaaaass/...aaaaaaaaaa.../ssssssssssssssss/................'],
  ['bigpumpkin', "A big pumpkin", 16, 16, 'B......ll......./sssssssllsssssss/...ppppllpppp.../ssppppppppppppss/.pppppppppppppp./pppppppppppppppp/pppppppppppppppp/pppppppppppppppp/pppppppppppppppp/pppppppppppppppp/pppppppppppppppp/spppppppppppppps/..pppppppppppp../sssppppppppppsss/................/ssssssssssssssss'],
  ['jack', "A jack-o-lantern", 16, 16, 'B.s.s.sll.s.s.s./.s.s.sllll.s.s.s/s.pppppppppppps./.pppppppppppppps/pppppppppppppppp/ppbbppppppppbbpp/ppbbppppppppbbpp/pppppppppppppppp/pppppppppppppppp/pbpbpbpbbpbpbpbp/ppbbbbbbbbbbbbpp/.pppppbbbbppppps/s.pppppppppppps./.s.pppppppppps.s/s.s.s.s.s.s.s.s./.s.s.s.s.s.s.s.s'],
  ['bigsun', "A shining sun", 16, 16, 'Bs.s.s.wws.s.s.s/w.s.s.sww.s.s.sw/.w.s.swwww.s.sws/s.wwwwwwwwwwwws./.swwwwwwwwwwww.s/swwwwwwwwwwwwww./.wwwwwwwwwwwwwws/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/swwwwwwwwwwwwww./.wwwwwwwwwwwwwws/s.wwwwwwwwwwwws./.swwwwwwwwwwww.s/sws.s.wwwws.s.w./ws.s.s.wws.s.s.w/s.s.s.sww.s.s.s.'],
  ['bigflower', "A big flower", 16, 16, 'Bssppssssssppsss/s.pppppppppppp.s/spppppppppppppps/spppwwwwwwwwppps/ppppwwwwwwwwpppp/ppppwwwwwwwwpppp/spppwwwwwwwwppps/spppppppppppppps/s.pppppppppppp.s/s......ll......s/s.....llll.....s/s....llllll....s/s......ll......s/s......ll......s/s...l..ll..l...s/sssssllllllsssss'],
  ['bigtree', "A big tree", 16, 16, 'B.sllllllllll.s./s.lllllllllllls./sllllllllllllll./llllllllllllllll/llllllllllllllll/llllllllllllllll/llllllllllllllll/sllllllllllllll./s.lllllllllllls./s.s.s.spp.s.s.s./s.s.s.spp.s.s.s./s.s.s.pppps.s.s./s.s.s.pppps.s.s./s.s.s.pppps.s.s./s.s.spppppp.s.s./s.s.spppppp.s.s.'],
  ['bigmushroom', "A big mushroom", 16, 16, 'Bs.saaaaaaaa.s.s/.saaaaaaaaaaaa.s/.aaawwaaaawwaaas/.aawwwaaaawwwaas/aaaaaaaaaaaaaaaa/aaaaaaaaaaaaaaaa/aawwaaaaaaaawwaa/.aaaaaaaaaaaaaas/.s.s.s.s.s.s.s.s/.s.wwwwwwwwwws.s/.s.wwwwwwwwwws.s/.s.wwwwwwwwwws.s/.s.wwwwwwwwwws.s/.s.wwwwwwwwwws.s/.swwwwwwwwwwww.s/.s.s.s.s.s.s.s.s'],
  ['bigcat', "A big cat", 16, 16, 'Bcsssssssssssscp/pccssssssssssccp/pccc........cccp/pcccccc..ccccccp/pcccccc..ccccccp/cccccccccccccccc/cclllcccccclllcc/cclllcccccclllcc/cccccccccccccccc/ccccccppppcccccc/ccccccppppcccccc/sccccccccccccccs/ssccccccccccccss/ss.cccccccccc.ss/ssssssssssssssss/ssssssssssssssss'],
  ['bigfox', "A fox", 16, 16, 'Bp..ss..ss..sspp/pcp.ss..ss..spcp/pccc..ss..sscccp/cccccccs.ccccccc/wcccccc.sccccccw/wwccccccccccccww/wcllccccccccllcw/wcllccccccccllcw/wwccccccccccccww/wwwwccccccccwwww/.wwwwwccccwwwwws/..wwwwwppwwwwwss/ss.wwwwwwwwwws../ss..wwwwwwwwss../..ss..ss..ss..ss/..ss..ss..ss..ss'],
  ['bigowl', "A big owl", 16, 16, 'Bssssssbbssssssb/bb....bbbb....bb/bbbbbbbbbbbbbbbb/bwwwbwwwwwwbwwwb/bwlwbwlwwlwbwlwb/bwwwbwwwwwwbwwwb/bbbbbbbbbbbbbbbb/bbbppbbbbbbppbbb/bbbbppbbbbppbbbb/bwwwwwwwwwwwwwwb/bwwwwwwwwwwwwwwb/.bwwwwwwwwwwwwb./ssbwwwwwwwwwwbss/...bbbbbbbbbb.../sssccssssssccsss/...cc......cc...'],
  ['bigskull', "A big skull", 16, 16, 'B.wwwwwwwwwwww../swwwwwwwwwwwwwws/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wbbbwwwwwwwwbbbw/wbbbwwwwwwwwbbbw/wbbbwwwwwwwwbbbw/wwwwwwwwwwwwwwww/.wwwwwwbbwwwwww./sswwwwwwwwwwwwss/..wbwbwbbwbwbw../sswbwbwbbwbwbwss/..wwwwwwwwwwww../ssssssssssssssss/................/ssssssssssssssss'],
  ['bigcastle', "A castle", 16, 16, 'B.wwsww.sww.wwsw/wsww.wws.wwsww.w/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwllllllllllwww/wwwllllllllllwww/wwwppppppppppwww/wwwppppppppppwww/wwwppppppppppwww/wwwppppppppppwww/wwwppppppppppwww/wwwppppppppppwww'],
  ['bigrocket', "A rocket", 16, 16, 'Bs.s.s.ccs.s.s.s/s.s.s.ccccs.s.s./.s.s.ccccccs.s.s/s.s.wwwwwwwws.s./.s.swwwwwwww.s.s/s.swwwwwwwwww.s./.s.wwwllllwwws.s/s.swwwllllwww.s./.s.wwwwwwwwwws.s/s.cwwwwwwwwwwcs./.ccwwwwwwwwwwccs/cccwwwwwwwwwwccc/cc.ppppppppppscc/c.s.pppppppps.sc/.s.s.pppppps.s.s/s.s.s.pppps.s.s.'],
  ['bighouse', "A cottage", 16, 16, 'Bssssssaasssssss/s.....aaaa.....s/s....aaaaaa....s/s...aaaaaaaa...s/s..aaaaaaaaaa..s/s.aaaaaaaaaaaa.s/saaaaaaaaaaaaaas/aaaaaaaaaaaaaaaa/wwwwwwwwwwwwwwww/wllwwwwwwwwwwllw/wllwwppppppwwllw/wwwwwppppppwwwww/wwwwwppppppwwwww/wwwwwppppppwwwww/wwwwwppppppwwwww/wwwwwppppppwwwww'],
  ['bigfrog', "A big frog", 16, 16, 'Bww.s.s.s.s.swwl/llwls.s.s.s.lwll/llllllllllllllll/llllllllllllllll/llllllllllllllll/llllllllllllllll/lbbbbbbbbbbbbbbl/llllllllllllllll/sllllllllllllll./sllllllllllllll./llllllllllllllll/llsllllllllll.ll/l.sllllllllll.sl/s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s.'],
  ['bigrobot', "A big robot", 16, 16, 'Bs.s.s.pps.s.s.s/.s.s.s.wws.s.s.s/.swwwwwwwwwwww.s/.wwwwwwwwwwwwwws/.wllwwwwwwwwllws/.wllwwwwwwwwllws/.wwwwwwwwwwwwwws/.wbbbbbbbbbbbbws/.swwwwwwwwwwww.s/.wwwwwwwwwwwwwws/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wswwwwwwwwwwww.w/.swwwwwwwwwwww.s/.sww.wwwwwwsww.s/.sww.wwwwwwsww.s'],
  ['bigstar', "A big star", 16, 16, 'Bsssssswwsssssss/ssssssswwsssssss/ss....wwww....ss/ss....wwww....ss/wwwwwwwwwwwwwwww/swwwwwwwwwwwwwws/sswwwwwwwwwwwwss/ss.wwwwwwwwww.ss/ss.wwwwwwwwww.ss/sswwwwwwwwwwwwss/sswwwwwwwwwwwwss/swwww.wwww.wwwws/swww...ww...wwws/wwww........wwww/wwssssssssssssww/wssssssssssssssw'],
  ['bigghost', "A ghost", 16, 16, 'Bswwwwwwwwwwww../swwwwwwwwwwwwww./wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwbbwwwwwwwwbbww/wwbbwwwwwwwwbbww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwbbbbbbbbwwww/wwwwwbbbbbbwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/ww.www.wwswwwsww/w.sww.sww.sww.sw/..ss..ss..ss..ss'],
  ['bigbear', "A bear", 16, 16, 'Bcsssssssssssscc/cccc........cccc/cccccccccccccccc/cccccccccccccccc/cclcccccccccclcc/cccccccccccccccc/cccwwwwwwwwwwccc/ccwwwwwwwwwwwwcc/ccwwbbbbbbbbwwcc/cccwwwwbbwwwwccc/scccwwwwwwwwcccs/..ccwwwwwwwwcc../ssccccwwwwccccss/.cccc......cccc./sccccssssssccccs/................'],
  ['bigpig', "A big pig", 16, 16, 'Bc............cc/ccccsssssssscccc/cccccccccccccccc/cccccccccccccccc/cclcccccccccclcc/cccccccccccccccc/cccccccccccccccc/ccccppppppppcccc/ccccppppppppcccc/ccccpbpbbpbpcccc/ccccppppppppcccc/sccccccccccccccs/..cccccccccccc../ssssssssssssssss/................/ssssssssssssssss'],
  ['kingcrown', "A king's crown", 16, 16, 'B.s.s.sww.s.s.sw/ww.s.swwww.s.sww/www.swwwwww.swww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwpwwwpwwpwwwpww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/wwwwwwwwwwwwwwww/.s.s.s.s.s.s.s.s/s.s.s.s.s.s.s.s./.s.s.s.s.s.s.s.s/s.s.s.s.s.s.s.s./.s.s.s.s.s.s.s.s/s.s.s.s.s.s.s.s./.s.s.s.s.s.s.s.s'],
  ['bigclover', "A lucky clover", 16, 16, 'Bsll.s.s.s.sll.s/sllll.s.s.sllll./llllll.s.sllllll/llllllllllllllll/.lllllllllllllls/s.lllllllllllls./.s.lllllllllls.s/llllllllllllllll/llllllllllllllll/llllllllllllllll/.lllllllllllllls/s.lllllwwllllls./.s.slllwwlll.s.s/s.s.s.sww.s.s.s./.s.s.sws.w.s.s.s/s.s.sws.s.w.s.s.'],
  ['bigcarrots', "Three carrots", 16, 16, 'Bls.l.sll.sls.l./sls.l.sll.sls.l./scc.ccscc.ccscc./scc.ccscc.ccscc./scc.ccscc.ccscc./scc.ccscc.ccscc./s.c.scs.s.c.scs./s.c.scs.s.c.scs./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s./s.s.s.s.s.s.s.s.'],
  ['bigwheat', "A wheat field", 16, 16, 'Bwswswsww.w.w.w./swswswsww.w.w.w./swswswsww.w.w.w./swswswsww.w.w.w./slslslsll.l.l.l./slslslsll.l.l.l./slslslsll.l.l.l./slslslsll.l.l.l./pppppppppppppppp/pppppppppppppppp/swswswsww.w.w.w./swswswsww.w.w.w./slslslsll.l.l.l./slslslsll.l.l.l./pppppppppppppppp/pppppppppppppppp'],
  ['bigscarecrow', "A scarecrow", 16, 16, 'Bswwwwwwwwwwww.s/.s.wwwwwwwwwws.s/.s.wwwwwwwwwws.s/.s.wbwwwwwwbws.s/.s.wwwwwwwwwws.s/.s.wppppppppws.s/wwwwppppppppwwww/wwwwppppppppwwww/.s.wppppppppws.s/.s.wppppppppws.s/.s.wppppppppws.s/.s.wpspppp.pws.s/.s.wpspppp.pws.s/.s.spspppp.p.s.s/.s.spspppp.p.s.s/.s.spspppp.p.s.s'],
  ['letter-a', "The letter A", 8, 8, 'Bsccccss/sccssccs/scc..ccs/sccccccs/scc..ccs/scc..ccs/sccssccs/ssssssss'],
  ['letter-c', "The letter C", 8, 8, 'Bswwww../sww.sww./.wws..ss/.wws..ss/sww.ss../sww.sww./..wwwwss/..ss..ss'],
  ['letter-e', "The letter E", 8, 8, 'Bpppppps/.pp...../sppsssss/.ppppp../sppsssss/.pp...../spppppps/........'],
  ['letter-h', "The letter H", 8, 8, 'Bbb..bb./sbbssbbs/.bb..bb./sbbbbbbs/.bb..bb./sbbssbbs/.bb..bb./ssssssss'],
  ['letter-k', "The letter K", 8, 8, 'Bll.sll./.llsll.s/sllll.s./.lll.s.s/sllll.s./.llsll.s/sll.sll./.s.s.s.s'],
  ['letter-l', "The letter L", 8, 8, 'Bccs.s.s/scc.s.s./.ccs.s.s/scc.s.s./.ccs.s.s/scc.s.s./.ccccccs/s.s.s.s.'],
  ['letter-m', "The letter M", 8, 8, 'Bwwsswws/swwwwwws/swwwwwws/sww..wws/sww..wws/sww..wws/sww..wws/ssssssss'],
  ['letter-o', "The letter O", 8, 8, 'B.pppps./spp.spp./spp.spp./spp.spp./spp.spp./spp.spp./s.pppps./s.s.s.s.'],
  ['letter-p', "The letter P", 8, 8, 'Blllll.s/.lls.lls/.lls.lls/.lllll.s/.lls.s.s/.lls.s.s/.lls.s.s/.s.s.s.s'],
  ['letter-s', "The letter S", 8, 8, 'Bsbbbbb./sbb.ss../.bbs..ss/..bbbbss/ss..sbb./ss..sbb./.bbbbbss/..ss..ss'],
  ['letter-t', "The letter T", 8, 8, 'Bcccccc./ss.ccs../..scc.ss/..scc.ss/ss.ccs../ss.ccs../..scc.ss/..ss..ss'],
  ['letter-x', "The letter X", 8, 8, 'Bwwsswws/.ww..ww./sswwwwss/...ww.../sswwwwss/.ww..ww./swwsswws/........'],
  ['letter-z', "The letter Z", 8, 8, 'Bllllll./ssssslls/....ll../sssllsss/..ll..../sllsssss/.llllll./ssssssss'],
  ['word-ha', "The word HA", 16, 8, 'Bbb.sbb.s.bbbbs./.bbs.bbs.bbs.bbs/sbb.sbb.sbb.sbb./.bbbbbbs.bbbbbbs/sbb.sbb.sbb.sbb./.bbs.bbs.bbs.bbs/sbb.sbb.sbb.sbb./.s.s.s.s.s.s.s.s'],
  ['word-ok', "The word OK", 16, 8, 'Bsllll.s.lls.lls/sll.sll.sll.lls./.lls.lls.lllls.s/sll.sll.sllls.s./.lls.lls.lllls.s/sll.sll.sll.lls./.sllll.s.lls.lls/s.s.s.s.s.s.s.s.'],
  ['word-oh', "The word OH", 16, 8, 'Bsccccsssccssccs/scc..cc..cc..ccs/scc..cc..cc..ccs/scc..cc..ccccccs/scc..cc..cc..ccs/scc..cc..cc..ccs/s.cccc...cc..ccs/ssssssssssssssss'],
  ['word-ah', "The word AH", 16, 8, 'B.ccccs.scc.scc./scc.scc.scc.scc./scc.scc.scc.scc./scccccc.scccccc./scc.scc.scc.scc./scc.scc.scc.scc./scc.scc.scc.scc./s.s.s.s.s.s.s.s.'],
  ['word-ox', "The word OX", 16, 8, 'Bswwww.s.wws.wws/.wws.wws.wws.wws/.wws.wws.swwww.s/.wws.wws.s.wws.s/.wws.wws.swwww.s/.wws.wws.wws.wws/.swwww.s.wws.wws/.s.s.s.s.s.s.s.s'],
  ['word-eh', "The word EH", 16, 8, 'Bppppppssppsspps/sppssssssppsspps/spp......pp..pps/sppppp...pppppps/spp......pp..pps/spp......pp..pps/sppppppssppsspps/ssssssssssssssss'],
  ['word-so', "The word SO", 16, 8, 'Bsbbbbb.ssbbbb../sbb.ss..sbb.sbb./.bbs..ss.bbs.bbs/..bbbbss.bbs.bbs/ss..sbb.sbb.sbb./ss..sbb.sbb.sbb./.bbbbbss..bbbbss/..ss..ss..ss..ss'],
  ['word-to', "The word TO", 16, 8, 'Bllllllsssllllss/...ll....ll..ll./sssllssssllsslls/...ll....ll..ll./sssllssssllsslls/...ll....ll..ll./sssllsssssllllss/................'],
  ['word-pa', "The word PA", 16, 8, 'Bccccc....cccc../sccssccssccssccs/.cc..cc..cc..cc./scccccsssccccccs/.cc......cc..cc./sccssssssccssccs/.cc......cc..cc./ssssssssssssssss'],
  ['word-ma', "The word MA", 16, 8, 'Bcc.scc.s.ccccs./.ccccccs.ccs.ccs/scccccc.scc.scc./.ccs.ccs.ccccccs/scc.scc.scc.scc./.ccs.ccs.ccs.ccs/scc.scc.scc.scc./.s.s.s.s.s.s.s.s'],
  ['word-he', "The word HE", 16, 8, 'Bwws.wws.wwwwwws/sww.sww.sww.s.s./.wws.wws.wws.s.s/swwwwww.swwwwws./.wws.wws.wws.s.s/sww.sww.sww.s.s./.wws.wws.wwwwwws/s.s.s.s.s.s.s.s.'],
  ['word-me', "The word ME", 16, 8, 'Bppssppsspppppps/spppppp..pp....s/spppppp..pp....s/spp..pp..ppppp.s/spp..pp..pp....s/spp..pp..pp....s/spp..pp..pppppps/ssssssssssssssss'],
  ['heart-red', "A red heart", 8, 8, 'B.s.s.s./saa.saa./aaaaaaaa/aaaaaaaa/aaaaaaaa/saaaaaa./s.aaaas./s.saa.s.'],
  ['heart-gold', "A golden heart", 8, 8, 'Bs.s.s.s/.wws.wws/wwwwwwww/wwwwwwww/wwwwwwww/.wwwwwws/.swwww.s/.s.wws.s'],
  ['gem-red', "A ruby", 8, 8, 'Bssaasss/ssaaaass/saaaaaas/aaaaaaaa/aaaaaaaa/saaaaaas/ssaaaass/sssaasss'],
  ['gem-green', "An emerald", 8, 8, 'Bs.lls../ssllll../.lllllls/llllllll/llllllll/sllllll./..llllss/..sll.ss'],
  ['star-orange', "An orange star", 8, 8, 'Bssppsss/...pp.../pppppppp/.pppppp./ssppppss/.pppppp./sppsspps/.p....p.'],
  ['star-red', "A red star", 8, 8, 'B..aa.../sssaasss/aaaaaaaa/saaaaaas/..aaaa../saaaaaas/.aa..aa./sassssas'],
  ['mushroom-purple', "A purple mushroom", 8, 8, 'B.bbbbs./.bbbbbbs/bbwbbwbb/bbbbbbbb/s.wwwws./.swwww.s/s.wwwws./.wwwwwws'],
  ['balloon-purple', "A purple balloon", 8, 8, 'Bbbbbbbs/bbbbbbbb/bbbbbbbb/bbbbbbbb/.bbbbbbs/s.bbbbs./.s.lls.s/s.sll.s.'],
  ['balloon-gold', "A golden balloon", 8, 8, 'Bwwwwwws/wwwwwwww/wwwwwwww/wwwwwwww/swwwwwws/s.wwww.s/s..ll..s/sssllsss'],
  ['flower-purple', "A purple flower", 8, 8, 'B.bbbbs./sbwwwwb./sbwwwwb./s.bbbbs./s.sll.s./s.lllls./s.sll.s./s.sll.s.'],
  ['flower-orange', "An orange flower", 8, 8, 'Bspppp.s/.pwwwwps/.pwwwwps/.spppp.s/.s.lls.s/.sllll.s/.s.lls.s/.s.lls.s'],
  ['tulip-purple', "A purple tulip", 8, 8, 'Bssbbssb/bbbbbbbb/bbbbbbbb/sbbbbbbs/ss.ll.ss/ss.ll.ss/slllllls/sssllsss'],
  ['apple-green', "A green apple", 8, 8, 'Bs.lls../sllllll./llllllll/llllllll/llllllll/llllllll/.lllllls/..llllss'],
  ['kite-purple', "A purple kite", 8, 8, 'Bssbbsss/..bbbb../sbbbbbbs/bbbbbbbb/sbbbbbbs/..bbbb../ssswwsss/...ll...'],
  ['smiley-orange', "A sunny face", 8, 8, 'Bpppppp./pppppppp/pbppppbp/pppppppp/pppppppp/pbppppbp/.bbbbbb./ssppppss'],
  ['cat-gold', "A golden cat", 8, 8, 'Bws.s.wc/cwwwwwwc/wlwwwwlw/wwwwwwww/wwwccwww/.wwwwwws/s.wwwws./.s.s.s.s'],
  ['mouse-orange', "A ginger mouse", 8, 8, 'Bc.s.scc/cccccccc/clcccclc/cccccccc/ccppppcc/scccccc./.c.ccscs/s.s.s.s.'],
  ['bear-purple', "A plum bear", 8, 8, 'Bbssssbb/bbbbbbbb/blbbbblb/bwwwwwwb/bwppppwb/sbbbbbbs/sbbbbbbs/ssssssss'],
  ['rabbit-orange', "A carrot-coloured rabbit", 8, 8, 'Bcs.s.c./scs.s.c./scc.scc./cccccccc/clcccclc/cccccccc/scccccc./s.sbb.s.'],
  ['crown-orange', "An orange crown", 8, 8, 'Bsps.p.p/pspppp.p/pppppppp/pcpccpcp/pppppppp/pppppppp/.s.s.s.s/.s.s.s.s'],
];

export const PICTURES: readonly Picture[] = POOL.map(([id, title, w, h, rows]) => ({ id, w, h, title, cells: toCells(rows) }));

/** Bit mask of the crop ids (bit c for crop c, 1..6) a picture needs. */
export function picCrops(cells: string): number {
  let m = 0;
  for (let i = 0; i < cells.length; i++) { const c = cells.charCodeAt(i) - 48; if (c >= 2 && c <= 7) m |= 1 << (c - 1); }
  return m;
}
/** Plots a picture covers, as `[px, py]` pairs excluding the barn plot (flat), in an order where each plot touches an earlier one. */
export function picturePlots(w: number, h: number): number[] {
  const flat: number[] = [];
  for (let py = 0; py < Math.ceil(h / 8); py++) for (let px = 0; px < Math.ceil(w / 8); px++) if (px || py) flat.push(px, py);
  return flat;
}
export const pictureById = (id: string): Picture | undefined => PICTURES.find((p) => p.id === id);
const MASKS: readonly number[] = PICTURES.map((p) => picCrops(p.cells));

const GLYPH_TITLES: readonly string[] = ['A quilt square', 'A woven rug', 'A garden crest', 'A tile pattern', 'A lucky charm', 'A stained-glass window'];

/**
 * A seeded four-way symmetric glyph, so the pool never runs out. `allowed` is a mask of crop ids (bit c) the glyph may use; carrot and
 * wheat are always allowed in practice. The glyph uses grass, soil and two or three crops, none of which covers more than 40% of it
 * (grass and soil: 40% and 45%), so nothing scores well by doing little. The barn pixel is (0, 0).
 */
export function proceduralPicture(seed: number, allowed: number): Picture {
  let s = ((seed ^ 0x6C79F9A1) >>> 0) || 1;
  for (let i = 0; i < 4; i++) s = rand(s);
  const draw = (n: number): number => { s = rand(s); return (s >>> 8) % n; };
  const sz = draw(20), [w, h] = sz < 12 ? PICTURE_SIZES[0]! : sz < 17 ? PICTURE_SIZES[1]! : PICTURE_SIZES[2]!;
  const crops: number[] = [];
  for (let c = 1; c <= 6; c++) if (allowed & (1 << c)) crops.push(c + 1);
  const title = GLYPH_TITLES[draw(GLYPH_TITLES.length)]!;
  const hw = w >> 1, hh = h >> 1, total = w * h - 1;
  for (let tries = 0; tries < 60; tries++) {
    const pal: number[] = [PIC_GRASS, PIC_SOIL];
    const pool = crops.slice();
    const want = Math.min(pool.length, 2 + draw(2));
    for (let i = 0; i < want; i++) pal.push(pool.splice(draw(pool.length), 1)[0]!);
    const weights = pal.map((c) => (c <= 1 ? 2 : 3));
    const sum = weights.reduce((a, b) => a + b, 0);
    const q: number[] = [];
    for (let i = 0; i < hw * hh; i++) { let r = draw(sum), k = 0; while (r >= weights[k]!) { r -= weights[k]!; k++; } q.push(pal[k]!); }
    const cells: number[] = new Array<number>(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells[y * w + x] = q[Math.min(y, h - 1 - y) * hw + Math.min(x, w - 1 - x)]!;
    cells[0] = PIC_BARN;
    const count = new Array<number>(9).fill(0);
    for (let i = 1; i < cells.length; i++) count[cells[i]!]!++;
    const ok = count[0]! <= 0.4 * total && count[1]! <= 0.45 * total && pal.slice(2).every((c) => count[c]! <= 0.4 * total && count[c]! >= 0.08 * total);
    if (ok) return { id: `glyph-${(seed >>> 0).toString(16).padStart(6, '0')}`, w, h, title, cells: cells.join('') };
  }
  // Never reached in practice: stripes of grass, soil and the first two crops.
  const pal = [PIC_GRASS, PIC_SOIL, crops[0] ?? 2, crops[1] ?? 3];
  const cells: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push(pal[(x + y) % 4]!);
  cells[0] = PIC_BARN;
  return { id: `glyph-${(seed >>> 0).toString(16).padStart(6, '0')}`, w, h, title, cells: cells.join('') };
}

/**
 * The picture of a brief: `draw(n)` is the brief's own draw (so v3 briefs stay a pure function of the seed). `lockedCrops` is a mask (bit c)
 * of crops whose research is locked; a picture never needs one. Glyphs never use apples (the dearest crop). One draw picks hand-made or glyph, one more picks the picture.
 */
export function drawPicture(draw: (n: number) => number, lockedCrops: number): Picture {
  const glyph = draw(GLYPH_ONE_IN) === 0;
  if (glyph) return proceduralPicture(draw(1 << 24), 0b0111110 & ~lockedCrops);
  const ok: number[] = [];
  for (let i = 0; i < PICTURES.length; i++) if ((MASKS[i]! & lockedCrops) === 0) ok.push(i);
  return PICTURES[ok[draw(ok.length)]!]!;
}
