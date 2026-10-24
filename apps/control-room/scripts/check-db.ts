// Checks the write rules against the live project with the browser's key:
// anon can read but not write tables directly, decide() refuses a second
// decision and a missing note, and undo_decision() restores the item.
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL!;
const anon = process.env.VITE_SUPABASE_ANON_KEY!;
const db = createClient(url, anon, { auth: { persistSession: false } });

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const read = await db.from('records').select('id', { count: 'exact', head: true });
check(!read.error && (read.count ?? 0) > 4000, 'anon can read the snapshot');

const ins = await db.from('decisions').insert({ order_id: 'ord-00593', target_type: 'x', target_id: 'x', action: 'done', decided_by: 'x' });
check(!!ins.error, 'anon cannot insert decisions directly');
const upd = await db.from('records').update({ data: {} }).eq('id', 'ord-00593');
const after = await db.from('records').select('data').eq('collection', 'orders').eq('id', 'ord-00593').single();
check(!!upd.error || (after.data?.data as { reference?: string })?.reference === 'CD-420593', 'anon cannot change the snapshot');
const aut = await db.from('autonomy').update({ level: 'on_its_own' }).eq('action_kind', 'book_travel');
const autAfter = await db.from('autonomy').select('level').eq('action_kind', 'book_travel').single();
check(!!aut.error || autAfter.data?.level !== 'on_its_own', 'anon cannot change autonomy directly');

const target = 'work-x2174da059fcd89e8'; // CD-420516 key holder check
// Start clean: undo anything an earlier, interrupted run left live on the test item.
const leftovers = await db.from('decisions').select('id').eq('target_id', target).is('undone_at', null);
for (const d of leftovers.data ?? []) await db.rpc('undo_decision', { p_id: d.id });
const noNote = await db.rpc('decide', { p_order_id: 'ord-00516', p_target_id: target, p_action: 'done', p_note: '' });
check(!!noNote.error && /note/i.test(noNote.error.message), 'decide refuses "Mark handled" without a note');

const first = await db.rpc('decide', { p_order_id: 'ord-00516', p_target_id: target, p_action: 'take' });
check(!first.error, 'decide records a decision');
const second = await db.rpc('decide', { p_order_id: 'ord-00516', p_target_id: target, p_action: 'take' });
check(!!second.error && /already decided/i.test(second.error.message), `a second decision is refused (${second.error?.message ?? 'accepted!'})`);

const settled = await db.rpc('decide', { p_order_id: 'ord-00194', p_target_id: 'agent-x3151927d69c76a10', p_action: 'approve' });
check(!!settled.error, 'an executed proposal cannot be approved again');

const locked = await db.rpc('set_autonomy', { p_kind: 'customer_message', p_level: 'on_its_own' });
check(!!locked.error, 'the customer-message rule is locked');

if (first.data) {
  const undo = await db.rpc('undo_decision', { p_id: (first.data as { id: string }).id });
  check(!undo.error, 'undo restores the item');
  const again = await db.rpc('undo_decision', { p_id: (first.data as { id: string }).id });
  check(!!again.error, 'undo twice is refused');
}

if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All database rules hold.');
