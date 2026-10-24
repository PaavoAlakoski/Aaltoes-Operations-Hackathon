// The customer rule and next-step sourcing.
import { describe, expect, it } from 'vitest';
import { packetWorld } from './testing/loadPacket';
import { agentStepMentionsCustomer, enforceCustomerRule, payloadSteps, autonomyKinds } from './proposals';
import { orderItems } from './attention';
import { outcomeSteps, NEEDS_NOTE } from './outcomes';
import { chooseNextStep, PLAYBOOK } from './nextStep';
import { triage } from './triage';
import type { ActionKind } from './types';

const world = packetWorld();
const ref = (r: string) => world.byReference.get(r)!;

describe('an agent never contacts a customer', () => {
  it('splits contact: ["site", "customer"] into an agent ask and a person-sent draft', () => {
    const p = world.proposals.find((x) => x.id === 'agent-x6ad46f8e74398f5e')!;
    const steps = payloadSteps(p, world);
    expect(steps).toContainEqual(expect.objectContaining({ by: 'agent', text: expect.stringMatching(/^Asks the site/) }));
    const draft = steps.find((s) => /customer/i.test(s.text))!;
    expect(draft.by).toBe('person');
    expect(draft.text).toMatch(/^Draft for the customer: .*You send it\.$/);
  });

  it('no agent step for any proposal, in any action, mentions a customer', () => {
    const actions: ActionKind[] = ['approve', 'change', 'reject', 'retry', 'take', 'already_sorted', 'done'];
    for (const p of world.proposals) {
      for (const s of payloadSteps(p, world)) expect(agentStepMentionsCustomer(s), `${p.id}: ${s.text}`).toBe(false);
      const item = orderItems(world.bundles.get(p.order_id)!, world).find((i) => i.id === p.id);
      if (!item) continue;
      for (const a of actions) {
        for (const s of outcomeSteps(item, a, 'note', world)) expect(agentStepMentionsCustomer(s), `${p.id} ${a}: ${s.text}`).toBe(false);
      }
    }
  });

  it('catches wording that slips through', () => {
    const [s] = enforceCustomerRule([{ by: 'agent', text: 'Emails the customer the new time.' }]);
    expect(s!.by).toBe('person');
  });

  it('a message sent to a driver that mentions the owner stays with the agent', () => {
    const p = world.proposals.find((x) => x.command === 'driver.request_safe_stop_details')!;
    const msg = payloadSteps(p, world).find((s) => s.text.startsWith('Sends the driver'))!;
    expect(msg.by).toBe('agent');
  });

  it('a customer contact puts the proposal under the locked customer-message rule', () => {
    expect(autonomyKinds(world.proposals.find((x) => x.id === 'agent-x6ad46f8e74398f5e')!)).toContain('customer_message');
  });
});

describe('before saving, every action shows a numbered outcome', () => {
  it('approving the empty-pickup proposal re-checks first and leaves the draft on the person', () => {
    const item = orderItems(ref('CD-420593'), world).find((i) => i.kind === 'proposal')!;
    const steps = outcomeSteps(item, 'approve', '', world);
    expect(steps[0]!.text).toMatch(/re-checks the order before acting/);
    expect(steps.some((s) => s.by === 'person')).toBe(true);
    expect(steps.at(-1)!.text).toMatch(/Decided this shift/);
  });
  it('change, reject, done and already sorted need a note', () => {
    expect([...NEEDS_NOTE].sort()).toEqual(['already_sorted', 'change', 'done', 'reject']);
  });
  it('linking an inbox candidate names the order it rules out', () => {
    const item = orderItems(ref('CD-420089'), world).find((i) => i.kind === 'inbox_candidate')!;
    expect(outcomeSteps(item, 'link', '', world).map((s) => s.text).join(' ')).toMatch(/CD-420719 is ruled out/);
  });
});

describe('next-step sourcing: record, then agent, then playbook', () => {
  it('prefers the record, then the agent, then the playbook', () => {
    expect(chooseNextStep('Do X.', 'Agent Y.', 'alert:EMPTY_PICKUP')).toEqual({ text: 'Do X.', source: 'record' });
    expect(chooseNextStep(null, 'Agent Y.', 'alert:EMPTY_PICKUP')).toEqual({ text: 'Agent Y.', source: 'agent' });
    expect(chooseNextStep(null, null, 'alert:EMPTY_PICKUP')).toEqual({ text: PLAYBOOK['alert:EMPTY_PICKUP'], source: 'playbook' });
    expect(chooseNextStep('  ', null, 'alert:NEW_SIGNAL').source).toBe('playbook');
  });

  it('a step marked record is the record’s own words, never ours', () => {
    for (const b of world.bundles.values()) {
      for (const i of orderItems(b, world).filter((x) => x.next.source === 'record')) {
        const own = [...b.alerts, ...b.workItems, ...b.custody].find((r) => r.id === i.id)?.next_action;
        if (own) expect(i.next.text).toBe(own.trim());
        else expect(['conversation', 'inbox']).toContain(i.kind); // a recorded wait, rendered from waiting_on
      }
    }
  });

  it('a playbook step is never presented as a record', () => {
    const playbookTexts = new Set(Object.values(PLAYBOOK));
    for (const b of world.bundles.values()) {
      for (const i of orderItems(b, world)) if (playbookTexts.has(i.next.text)) expect(i.next.source).toBe('playbook');
    }
  });

  it('the queue row for the breakdown uses the recorded recovery step, not a playbook line', () => {
    const row = triage(world, []).rows.find((r) => r.reference === 'CD-420322')!;
    expect(row.next.source).toBe('record');
    expect(row.next.text).toMatch(/owner's service decision/);
  });
});

describe('agent records', () => {
  it('counts each proposal once per outcome, and waiting means waiting on a person', async () => {
    const { agentRecords } = await import('./agents');
    const copilot = agentRecords(world, []).find((a) => a.id === 'ops-copilot')!;
    expect(copilot.proposed).toBe(6);
    expect(copilot.waiting).toBe(3);
    expect(copilot.approved + copilot.changed + copilot.rejected + copilot.waiting).toBeLessThanOrEqual(copilot.proposed);
    const decided = agentRecords(world, [{
      id: 'd', order_id: 'ord-00593', target_type: 'proposal', target_id: 'agent-x6ad46f8e74398f5e', action: 'approve',
      note: null, decided_by: 'x', decided_at: '2026-10-21T09:00:00Z', effects: [], undone_at: null,
    }]).find((a) => a.id === 'ops-copilot')!;
    expect(decided.waiting).toBe(2);
    expect(decided.approved).toBe(copilot.approved + 1);
  });
});
