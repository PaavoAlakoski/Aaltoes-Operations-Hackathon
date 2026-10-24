// Turns an agent proposal's payload into the plain steps a person approves.
// The customer rule lives here: an agent never contacts anyone who pays us.
// Anything meant for a customer becomes a draft that a person sends.
import type { OutcomeStep, Proposal, TravelOption } from './types';
import type { World } from './world';
import { formatMoney } from './evidence';
import { humanize } from './labels';

const CUSTOMER_WORDS = /\b(customer|buyer|dealer|owner)s?\b/i;

/** What an agent asks a site or driver about, per kind of proposal. */
const ASK_ABOUT: Record<string, string> = {
  'pickup.verify_identity': 'which site physically holds this car, by its VIN',
  'assignment.review_positioning': 'whether another driver can take the slot',
};

function optionText(opt: TravelOption | undefined): string {
  if (!opt) return 'the quoted option';
  const price = opt.quote_cents != null ? `, ${formatMoney(opt.quote_cents, opt.currency)}` : '';
  return `${opt.provider} ${opt.from_city} → ${opt.to_city}${price} (a quote)`;
}

const draft = (what: string): OutcomeStep => ({ text: `Draft for the customer: ${what}. You send it.`, by: 'person' });

/** The payload a person would act on: the reviewed one if it was edited, else the proposed one. */
export function effectivePayload(p: Proposal): Record<string, unknown> {
  return p.review?.final_payload ?? p.proposed_payload;
}

export function payloadSteps(p: Proposal, world: Pick<World, 'bundles'>, payload = effectivePayload(p)): OutcomeStep[] {
  const options = world.bundles.get(p.order_id)?.options ?? [];
  const opt = (id: unknown) => options.find((o) => o.id === id);
  const booking = p.command.startsWith('travel.book') || p.command === 'travel.rebook';
  const steps: OutcomeStep[] = [];
  const agent = (text: string) => steps.push({ text, by: 'agent' });

  for (const [key, value] of Object.entries(payload)) {
    switch (key) {
      case 'contact': {
        const parties = Array.isArray(value) ? (value as string[]) : [];
        const about = ASK_ABOUT[p.command] ?? 'what they know';
        for (const party of parties) {
          if (party === 'site') agent(`Asks the site ${about}.`);
          else if (party === 'driver') agent(`Asks the driver ${about}.`);
          else if (party === 'customer') steps.push(draft(`ask them ${about}`));
          else steps.push({ text: `Contact the ${party}: a person does this.`, by: 'person' });
        }
        break;
      }
      case 'hold_collection': if (value) agent('Keeps collection on hold.'); break;
      case 'do_not_mark_picked_up': if (value) agent('Does not mark the car as collected.'); break;
      case 'check_replacement_capacity': if (value) agent('Looks for a replacement driver for the same slot.'); break;
      case 'keep_current_assignment_until_decision': if (value) agent('Keeps the current driver booked until you decide.'); break;
      case 'request_customer_approval_if_window_changes':
        if (value) steps.push(draft('if the slot has to move, ask them to agree'));
        break;
      case 'do_not_change_delivery_promise': if (value) agent('Leaves the delivery promise as it is.'); break;
      case 'change_promise': agent(value ? 'Changes the delivery promise.' : 'Leaves the delivery promise as it is.'); break;
      case 'refresh_next_day_capacity':
      case 'refresh_capacity': if (value) agent('Re-checks space on the crossing.'); break;
      case 'verify_provider_reference': if (value) agent('Asks the ferry line whether the timed-out booking went through.'); break;
      case 'do_not_assign_liability': if (value) agent('Does not blame anyone for the mark yet.'); break;
      case 'request_signed_handover': if (value) steps.push(draft('ask for the signed handover record')); break;
      case 'review_pickup_and_delivery_photos': if (value) agent('Compares the pickup and delivery photos.'); break;
      case 'option_id':
      case 'travel_option_id':
        agent(booking ? `Books ${optionText(opt(value))}.` : `Looks again at ${optionText(opt(value))}.`);
        break;
      case 'vehicle_space_required': if (value) agent('Only with space for the car.'); break;
      case 'verify_driver_rest': if (value) agent('Checks the driver’s rest time.'); break;
      case 'replace_reservation_id': agent('Replaces the ferry booking the gate refused.'); break;
      case 'use_first_available': agent(value ? 'Takes the first crossing with space.' : 'Does not just take the first crossing listed.'); break;
      case 'require_fresh_capacity_check': if (value) agent('Books only after a fresh space check.'); break;
      case 'alert_id': if (p.command === 'alert.resolve') agent('Closes the alert.'); break;
      case 'mark_boarding_confirmed': agent(value ? 'Marks boarding as confirmed.' : 'Keeps boarding unconfirmed.'); break;
      case 'attribution': agent(`Records the mark as ${String(value) === 'DRIVER_CAUSED' ? 'caused by the driver' : humanize(String(value)).toLowerCase()}.`); break;
      case 'cancel_current': agent(value ? 'Cancels the current driver.' : 'Keeps the current driver booked.'); break;
      case 'look_for_backup': if (value) agent('Looks for a backup driver.'); break;
      case 'buy_ticket': agent(value ? 'Buys the ticket.' : 'Buys nothing.'); break;
      case 'check_invoice_record': if (value) agent('Asks billing to compare the reference with the invoice record.'); break;
      case 'tell_customer_issued':
        if (value) steps.push(draft('tell them the invoice was issued'));
        else agent('Says nothing about an invoice until the record is found.');
        break;
      case 'authorize_restart': agent(value ? 'Tells the driver they may restart the car.' : 'Gives the driver no restart advice.'); break;
      case 'message': agent(`Sends the driver: “${String(value)}”`); break;
      // Ids that only point at evidence or at the job itself say nothing new.
      case 'resolution_evidence_id':
      case 'source_message_id':
      case 'passenger_assignment_id':
        break;
      default:
        agent(`${humanize(key)}${typeof value === 'boolean' ? (value ? '' : ': no') : `: ${String(value)}`}.`);
    }
  }
  return enforceCustomerRule(steps);
}

/**
 * The fixed rule, applied last so no wording slips through: an agent step that
 * reaches a customer is handed to a person as a draft.
 */
export function enforceCustomerRule(steps: OutcomeStep[]): OutcomeStep[] {
  return steps.map((s) =>
    agentStepMentionsCustomer(s) && /\b(ask|tell|send|contact|message|call|email)/i.test(unquoted(s.text))
      ? { text: `Draft for the customer: ${s.text.replace(/\.$/, '')}. You send it.`, by: 'person' }
      : s,
  );
}

/** Quoted text is what the agent says to a driver; who it addresses is outside the quotes. */
const unquoted = (t: string) => t.replace(/“[^”]*”/g, '');

export function agentStepMentionsCustomer(s: OutcomeStep): boolean {
  return s.by === 'agent' && CUSTOMER_WORDS.test(unquoted(s.text));
}

/** Which kinds of action on the autonomy page this proposal falls under. */
export function autonomyKinds(p: Proposal): string[] {
  const kinds = new Set<string>();
  const c = p.command;
  if (c.startsWith('travel.book') || c === 'travel.rebook') kinds.add('book_travel');
  else if (c.startsWith('assignment.')) kinds.add('change_assignment');
  else if (c === 'alert.resolve' || c === 'condition.record_attribution') kinds.add('resolve_alert');
  else kinds.add('read_and_ask');
  const payload = effectivePayload(p);
  if (payload.change_promise === true) kinds.add('change_date');
  const contact = payload.contact;
  if ((Array.isArray(contact) && contact.includes('customer')) || payload.request_customer_approval_if_window_changes || payload.request_signed_handover) {
    kinds.add('customer_message');
  }
  return [...kinds];
}

export const rechecksBeforeActing = (p: Proposal) => p.dependency?.execution_policy === 'RECHECK_CURRENT_STATE_BEFORE_WRITE';
