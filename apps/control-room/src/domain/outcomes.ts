// Before anything is saved, every action says what will happen, as a numbered
// list. Steps that stay with a person are marked by: 'person'.
import type { ActionKind, OutcomeStep } from './types';
import type { AttentionItem } from './attention';
import type { World } from './world';
import { payloadSteps, rechecksBeforeActing } from './proposals';
import { recordedEffects } from './evidence';

const LEAVES = 'It leaves the queue. You can undo it on the order page.';

export function outcomeSteps(item: AttentionItem, action: ActionKind, note: string, world: World): OutcomeStep[] {
  const steps: OutcomeStep[] = [];
  const say = (text: string, by: OutcomeStep['by'] = 'system') => steps.push({ text, by });
  const p = item.proposal;
  const quoted = note.trim() ? `: “${note.trim()}”` : '';

  switch (action) {
    case 'approve': {
      if (!p) break;
      if (rechecksBeforeActing(p)) say('The agent re-checks the order before acting, and stops if anything changed.', 'agent');
      steps.push(...payloadSteps(p, world));
      say('Nothing on the order counts as changed until the agent’s change is recorded.');
      break;
    }
    case 'change':
      say(`The agent gets your change and does not act on the proposal as written${quoted}.`, 'agent');
      say('It comes back to you with a revised proposal before doing anything.', 'agent');
      break;
    case 'reject':
      say(`The proposal is closed as rejected, with your note${quoted}.`);
      say('None of its steps happen.');
      if (p?.alert_id) say('The alert behind it stays open on the order.');
      break;
    case 'retry': {
      if (!p) break;
      if (rechecksBeforeActing(p)) say('The agent re-checks the order before acting, and stops if anything changed.', 'agent');
      if (p.command.startsWith('travel.book')) say('It first asks the provider whether the earlier attempt went through, so nothing is booked twice.', 'agent');
      steps.push(...payloadSteps(p, world));
      say('If it fails again, it comes back to you.', 'agent');
      break;
    }
    case 'take': {
      if (p && p.status === 'FAILED') {
        say('The agent stops working on this.', 'agent');
        say(`You handle it yourself: ${p.summary.replace(/\.$/, '').toLowerCase()}.`, 'person');
        if (recordedEffects(p, world).length === 0) say('Nothing was booked by the failed attempt: no change is recorded.');
        break;
      }
      say('You become the owner for this shift.');
      say(item.next.text, 'person');
      break;
    }
    case 'already_sorted':
      say(`Marked as sorted outside this screen, with your note${quoted}.`);
      say('The agent stops working on this.', 'agent');
      say('Check the records show what was done: nothing here changes them.', 'person');
      break;
    case 'done':
      say(`Marked handled, with your note${quoted}.`);
      say('The underlying record stays as it was; your note is what shows it was handled.');
      break;
    case 'link': {
      const t = item.thread;
      const ref = world.bundles.get(item.orderId)?.order.reference ?? item.orderId;
      say(`The message is linked to ${ref}.`);
      const others = (t?.candidate_order_ids ?? []).filter((id) => id !== item.orderId).map((id) => world.bundles.get(id)?.order.reference ?? id);
      if (others.length) say(`${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} ruled out.`);
      say(t?.counterparty_type === 'customer' ? 'Reply to the sender. A customer only hears from a person.' : 'Reply to the sender with the answer for this order.', 'person');
      break;
    }
    case 'not_this': {
      const ref = world.bundles.get(item.orderId)?.order.reference ?? item.orderId;
      say(`${ref} is ruled out for this message.`);
      say('The message stays unmatched until someone links the right order.');
      break;
    }
  }
  say(LEAVES);
  return steps;
}

/** Actions that need a note before they can be saved. */
export const NEEDS_NOTE: ReadonlySet<ActionKind> = new Set(['change', 'reject', 'done', 'already_sorted']);
