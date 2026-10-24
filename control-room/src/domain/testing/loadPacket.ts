// Reads the packet straight from dataset/ into the same rows the database
// holds, so the domain tests run without a network.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RecordRow } from '../types';
import { buildWorld, type World } from '../world';

const root = resolve(import.meta.dirname, '..', '..', '..', '..');

export function packetRows(): RecordRow[] {
  const dir = join(root, 'dataset', 'data');
  const rows: RecordRow[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const collection = file.replace(/\.jsonl$/, '');
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const data = JSON.parse(line) as Record<string, unknown>;
      const id = String(data.id);
      rows.push({ collection, id, order_id: collection === 'orders' ? id : (data.order_id as string | undefined) ?? null, data });
    }
  }
  rows.push({ collection: 'manifest', id: 'manifest', order_id: null, data: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) });
  const attachments = JSON.parse(readFileSync(join(root, 'attachments', 'manifest.json'), 'utf8')) as Record<string, unknown>[];
  for (const a of attachments) rows.push({ collection: 'attachments', id: String(a.id), order_id: (a.order_id as string) ?? null, data: a });
  return rows;
}

let cached: World | undefined;
export function packetWorld(): World {
  return (cached ??= buildWorld(packetRows()));
}
