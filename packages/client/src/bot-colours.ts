/**
 * One stable colour per bot, shared by the drone ring, the minimap, the editor's running-line marks, the debugger and the console.
 * The eight colours are the Okabe-Ito colour-blind-safe set, with the blue and the black lifted so they stay readable on the dark
 * HUD. Bot ids repeat the palette after eight, so very large crews share colours but never change them between runs.
 */
export const BOT_PALETTE = ['#E69F00', '#56B4E9', '#2FBF94', '#F0E442', '#4A9BE0', '#E8683A', '#E48AC0', '#E8E4DC'] as const;

const wrap = (id: number): number => ((Math.trunc(id) % BOT_PALETTE.length) + BOT_PALETTE.length) % BOT_PALETTE.length;

/** CSS colour for a bot id. Non-finite ids give the first colour. */
export const botColour = (id: number): string => BOT_PALETTE[Number.isFinite(id) ? wrap(id) : 0]!;

/** The same colour as a 0xRRGGBB number for three.js. */
export const botColourHex = (id: number): number => parseInt(botColour(id).slice(1), 16);
