import type { LogEntry } from '@tendril/sim/src/index.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function readJson(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new HttpError(400, 'Invalid content length');
  if (length !== null && Number(length) > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(400, 'Expected application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Invalid JSON');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      // Do not cancel the stream: tearing down the transport here would reset the connection before the
      // 413 is written. The caller flushes the response and then closes the connection.
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
      parts.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON');
  } finally { reader.releaseLock(); }
}

export function objectWithKeys(value: unknown, keys: string[], status = 400): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(status, 'Invalid request');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new HttpError(status, 'Invalid request fields');
  return value as Record<string, unknown>;
}

export function displayName(value: unknown): string {
  if (typeof value !== 'string' || [...value].length < 2 || [...value].length > 32 || !value.trim() || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) throw new HttpError(400, 'Invalid display name');
  return value;
}

export function isInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export interface ChunkInput {
  fromTick: number; toTick: number; actions: LogEntry[]; rulesVersion: number; checkpointHash: string;
}

/** Shape-checks an action log whose entries must fall in [fromTick, toTick). Throws 413/422. */
export function validateActions(actions: unknown, fromTick: number, toTick: number): LogEntry[] {
  if (!Array.isArray(actions)) throw new HttpError(422, 'Invalid actions');
  if (actions.length > 20000) throw new HttpError(413, 'Chunk too large');
  for (const action of actions) {
    if (!Array.isArray(action) || !isInteger(action[0]) || action[0] < fromTick || action[0] >= toTick || !isInteger(action[1], -1) || !isInteger(action[2], 0, 10)) throw new HttpError(422, 'Invalid action');
    const op = action[2];
    const length = op === 8 || op === 9 ? 5 : [0, 2, 6, 7].includes(op) ? 4 : 3;
    if (action.length !== length || action.some((n) => !isInteger(n, -Number.MAX_SAFE_INTEGER))) throw new HttpError(422, 'Invalid action shape');
    if ((op >= 9 && action[1] !== -1) || (op < 9 && action[1] < 0)) throw new HttpError(422, 'Invalid bot');
    const a = action[3], b = action[4];
    if ((op === 0 && !isInteger(a, 0, 3)) || (op === 2 && !isInteger(a, 1, 4)) || (op === 6 && !isInteger(a, 1)) || (op === 7 && !isInteger(a, 1, 1000)) || (op === 8 && (!isInteger(a, 1, 4) || !isInteger(b, 1))) || (op === 9 && (!isInteger(a, -1000000000, 1000000000) || !isInteger(b, -1000000000, 1000000000)))) throw new HttpError(422, 'Invalid action argument');
  }
  return actions as LogEntry[];
}

export function chunkInput(value: unknown): ChunkInput {
  const body = objectWithKeys(value, ['fromTick', 'toTick', 'actions', 'rulesVersion', 'checkpointHash'], 422);
  const { fromTick, toTick, actions, rulesVersion, checkpointHash } = body;
  if (!isInteger(fromTick) || !isInteger(toTick) || toTick <= fromTick) throw new HttpError(422, 'Invalid tick range');
  if (toTick - fromTick > 20000 || (Array.isArray(actions) && actions.length > 20000)) throw new HttpError(413, 'Chunk too large');
  if (!isInteger(rulesVersion, 1) || typeof checkpointHash !== 'string' || !/^[0-9a-f]{8}$/.test(checkpointHash) || !Array.isArray(actions)) throw new HttpError(422, 'Invalid chunk');
  return { fromTick, toTick, actions: validateActions(actions, fromTick, toTick), rulesVersion, checkpointHash };
}

export function rejectQuery(url: URL, allowed: string[] = []): void {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) throw new HttpError(400, 'Invalid query');
    seen.add(key);
  }
}

export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, 'Invalid farm id');
  return value;
}
