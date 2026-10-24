// Where an item's next step comes from, in order of preference:
//   1. record   – the item's own recorded next_action (or its recorded wait)
//   2. agent    – a proposal waiting on the order
//   3. playbook – a short default per signal that we wrote ourselves
// A playbook line is always labelled as such, so nobody takes it for a record.

export type NextSource = 'record' | 'agent' | 'playbook';

export interface NextStep {
  text: string;
  source: NextSource;
}

export const PLAYBOOK: Record<string, string> = {
  'alert:TRACKING_GAP': 'Ask the driver for a position before changing any promise.',
  'alert:RELEASE_DOCUMENT_UNCLEAR': 'Get the signed release before anyone travels.',
  'alert:SITE_ACCESS_UNCONFIRMED': 'Get a named key holder from the site before dispatch.',
  'alert:DRIVER_AVAILABILITY_RISK': 'Get a clear yes or no from the driver; line up a backup.',
  'alert:FERRY_CONNECTION_RISK': 'Compare the check-in cutoff with the driver’s arrival.',
  'alert:DELIVERY_ACCESS_RISK': 'Confirm who receives the car, and when.',
  'alert:PROOF_REVIEW': 'Open the document itself before calling it signed.',
  'alert:CONDITION_CLAIM_REVIEW': 'Compare pickup and delivery photos before replying.',
  'alert:CONDITION_CLAIM': 'Compare pickup and delivery photos before replying.',
  'alert:INVOICE_REFERENCE_QUERY': 'Check the invoice record before answering.',
  'alert:EMPTY_PICKUP': 'Find which site holds the car before another attempt.',
  'alert:FERRY_SOLD_OUT': 'Find a crossing with space; the promise stands until one is booked.',
  'alert:SAFETY_STOP': 'Make sure the driver is safe; the owner decides on recovery.',
  'alert:SITE_ACCESS_CONFLICT': 'Get stock control to say where the car and keys are.',
  'alert:FR_IMPORT_TRAVEL_DECISION': 'Check rest, road time and space before booking.',
  'alert:POSITIONING_AT_RISK': 'Look for another driver for the same slot.',
  'alert:PICKUP_PROOF_REJECTED': 'Get new photos, labelled with when they were taken.',
  'alert:DELIVERY_PROMISE_UNACHIEVABLE': 'Agree a new delivery time with the customer before telling the driver.',
  'alert:*': 'Look at the evidence behind the signal before acting.',
  'incident:EMPTY_PICKUP': 'Find which site holds the car before another attempt.',
  'incident:TRAVEL_CAPACITY': 'Find a crossing with space for the car.',
  'incident:VEHICLE_WARNING': 'The owner decides between their own assistance and a tow.',
  'incident:POST_DELIVERY_CONDITION_CLAIM': 'Compare pickup and delivery photos before replying.',
  'incident:*': 'Read the incident and choose the next step.',
  conversation: 'Read the latest message, then reply or close the thread.',
  claim: 'Check the claim against the order before relying on it.',
  custody: 'Confirm who holds it before anyone collects.',
  inbox: 'Read the message and decide which order it is about.',
  'inbox:linked': 'Answer the sender once the thing they asked for is ready.',
  pickup_check: 'Call the site to confirm the contact and access before the driver travels.',
  silent_driver: 'Ask the driver for a position.',
  work_item: 'Read the follow-up and choose the next step.',
};

export function playbook(key: string): NextStep {
  const fallback = key.includes(':') ? `${key.split(':')[0]}:*` : 'work_item';
  return { text: PLAYBOOK[key] ?? PLAYBOOK[fallback] ?? PLAYBOOK.work_item!, source: 'playbook' };
}

/** Pick the best available next step: record, then agent, then playbook. */
export function chooseNextStep(record: string | null | undefined, agent: string | null | undefined, playbookKey: string): NextStep {
  if (record && record.trim()) return { text: record.trim(), source: 'record' };
  if (agent && agent.trim()) return { text: agent.trim(), source: 'agent' };
  return playbook(playbookKey);
}
