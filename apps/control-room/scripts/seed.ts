// Loads the packet into Supabase: every JSONL row into `records`, and every
// attachment into the public `packet` bucket after checking its SHA-256.
// Safe to run again: rows are upserted and files overwritten in place.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = resolve(import.meta.dirname, '..', '..', '..');
const dataDir = join(root, 'dataset', 'data');
const attachmentsDir = join(root, 'attachments');

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in apps/control-room/.env (see .env.example).');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

type Row = { collection: string; id: string; order_id: string | null; data: Record<string, unknown> };

function fail(message: string): never {
  console.error(`Seed stopped: ${message}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as {
  snapshot_at: string;
  tables: Record<string, number>;
};

// 1. Read every collection and check it against the manifest before writing anything.
const rows: Row[] = [];
const files = readdirSync(dataDir).filter((f) => f.endsWith('.jsonl')).sort();
for (const file of files) {
  const collection = file.replace(/\.jsonl$/, '');
  const lines = readFileSync(join(dataDir, file), 'utf8').split('\n').filter((l) => l.trim() !== '');
  const expected = manifest.tables[collection];
  if (expected === undefined) fail(`${file} is not listed in manifest.json`);
  if (lines.length !== expected) fail(`${file} has ${lines.length} rows, manifest says ${expected}`);
  for (const line of lines) {
    const data = JSON.parse(line) as Record<string, unknown>;
    const id = data.id;
    if (typeof id !== 'string') fail(`a row in ${file} has no id`);
    const orderId = collection === 'orders' ? id : typeof data.order_id === 'string' ? data.order_id : null;
    rows.push({ collection, id, order_id: orderId, data });
  }
}
const missing = Object.keys(manifest.tables).filter((t) => !files.includes(`${t}.jsonl`));
if (missing.length) fail(`manifest lists tables with no file: ${missing.join(', ')}`);

// The manifest itself is a record too, so the app knows the snapshot time.
rows.push({ collection: 'manifest', id: 'manifest', order_id: null, data: manifest });

// 2. Check every attachment's hash before uploading any.
type Attachment = { id: string; file_name: string; content_type: string; sha256: string };
const attachments = JSON.parse(readFileSync(join(attachmentsDir, 'manifest.json'), 'utf8')) as Attachment[];
const bytes = new Map<string, Buffer>();
for (const a of attachments) {
  const buf = readFileSync(join(attachmentsDir, a.file_name));
  const hash = createHash('sha256').update(buf).digest('hex');
  if (hash !== a.sha256) {
    fail(`${a.file_name} does not match its manifest hash. Was it line-ending converted? See .gitattributes.`);
  }
  bytes.set(a.id, buf);
}
for (const a of attachments) {
  rows.push({ collection: 'attachments', id: a.id, order_id: (a as { order_id?: string }).order_id ?? null, data: a });
}

// 3. Upsert rows in batches.
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await db.from('records').upsert(rows.slice(i, i + 500), { onConflict: 'collection,id' });
  if (error) fail(`upsert failed: ${error.message}`);
}

// 4. Upload attachments.
for (const a of attachments) {
  const { error } = await db.storage
    .from('packet')
    .upload(a.file_name, bytes.get(a.id)!, { contentType: a.content_type, upsert: true });
  if (error) fail(`upload of ${a.file_name} failed: ${error.message}`);
}

// 5. Read the counts back from the database.
for (const [collection, expected] of Object.entries(manifest.tables)) {
  const { count, error } = await db.from('records').select('id', { count: 'exact', head: true }).eq('collection', collection);
  if (error) fail(error.message);
  if (count !== expected) fail(`${collection}: database has ${count} rows, manifest says ${expected}`);
}

const total = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
console.log(
  `Seeded ${total} rows in ${files.length} collections and ${attachments.length} attachments (hashes checked), snapshot ${manifest.snapshot_at}.`,
);
