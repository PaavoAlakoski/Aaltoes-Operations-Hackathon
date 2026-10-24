// Each agent's track record: what it proposed and what people did with it,
// from the recorded reviews plus the decisions made in this app.
import type { Decision } from './types';
import type { World } from './world';

export interface AgentRecord {
  id: string;
  title: string;
  scope: string;
  proposed: number;
  approved: number;
  changed: number;
  rejected: number;
  failed: number;
  waiting: number;
}

export function agentRecords(world: World, decisions: Decision[]): AgentRecord[] {
  const live = new Map(decisions.filter((d) => !d.undone_at).map((d) => [d.target_id, d]));
  return [...world.agents.values()].map((a) => {
    const r: AgentRecord = { id: a.id, title: a.title, scope: a.scope, proposed: 0, approved: 0, changed: 0, rejected: 0, failed: 0, waiting: 0 };
    for (const p of world.proposals.filter((x) => x.proposed_by_agent_id === a.id)) {
      r.proposed++;
      const d = live.get(p.id);
      if (p.review?.decision === 'APPROVED' || d?.action === 'approve') r.approved++;
      else if (p.review?.decision === 'EDITED' || d?.action === 'change') r.changed++;
      else if (p.review?.decision === 'REJECTED' || d?.action === 'reject') r.rejected++;
      if (p.execution?.status === 'FAILED') r.failed++;
      const open = p.status === 'PENDING_REVIEW' || p.status === 'APPROVED_AWAITING_EXECUTION';
      if (open && !d) r.waiting++;
    }
    return r;
  });
}

export const SCOPE_TEXT: Record<string, string> = {
  publish_reviewed_market_offers: 'Publishes offers to drivers once a person has reviewed them.',
  case_research_and_draft_actions: 'Researches cases and drafts the next action for a person.',
  quotes_and_booking_proposals: 'Finds travel quotes and proposes bookings.',
  risk_detection_and_follow_up_proposals: 'Watches moving cars and proposes follow-ups when something looks off.',
};
