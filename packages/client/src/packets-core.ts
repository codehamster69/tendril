/** Seed packet rules of presentation. Pure: no DOM, so node tests can run it. The server enforces the same fair-play rule. */
export type PacketMode = 'live' | 'sandbox' | 'campaign' | 'daily';

export const PACKET_TAGS = ['starter', 'tiny', 'fast', 'wealth', 'orchard', 'bees', 'market', 'silo', 'multi-bot', 'tricks'] as const;

/** Why planting is refused in this mode, or null when it is allowed (Endless and sandbox only). */
export function plantRefusal(mode: PacketMode): string | null {
  if (mode === 'live' || mode === 'sandbox') return null;
  if (mode === 'campaign') return 'Campaign lessons give you their own code. Open Endless or Sandbox to plant a packet.';
  return 'Planting is off while a daily or season is open, so everyone solves it on their own. Open Endless or Sandbox to plant this packet.';
}

/** Why sharing is refused in this mode, or null. A program used on a daily can be shared from Sandbox once that daily closes. */
export function shareRefusal(mode: PacketMode): string | null {
  if (mode === 'live' || mode === 'sandbox') return null;
  return 'Share from Endless or Sandbox. A program you used on a daily can be shared from Sandbox once that daily has closed.';
}

const KEY = 'tendril.packetParent';
export interface Parent { id: string; name: string }
/** The packet whose code is in the editor, so a changed version can be shared as its remix. */
export function rememberParent(p: Parent | null, store: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  try { if (p) store.setItem(KEY, JSON.stringify(p)); else store.removeItem(KEY); } catch { /* private mode */ }
}
export function recallParent(store: Pick<Storage, 'getItem'> = localStorage): Parent | null {
  try {
    const v = JSON.parse(store.getItem(KEY) ?? 'null') as Partial<Parent> | null;
    return v && typeof v.id === 'string' && /^[A-Za-z0-9_-]{8,16}$/.test(v.id) && typeof v.name === 'string' ? { id: v.id, name: v.name.slice(0, 40) } : null;
  } catch { return null; }
}

/** A packet id from `?plant=`: the 11-character id, or a pasted site link ending in one. */
export function parsePacketId(text: string | null): string | null {
  const m = /(?:^|\/)([A-Za-z0-9_-]{8,16})\/?(?:[?#].*)?$/.exec((text ?? '').trim());
  return m ? m[1]! : null;
}

export const isBlank = (source: string): boolean => source.trim() === '';
