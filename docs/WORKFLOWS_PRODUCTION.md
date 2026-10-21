# Workflows: production capabilities

Updated 21 October 2026. The customer workflow builder now exposes every trigger, step and setting that the execution engine runs. Before this change, the builder hid most of its own options because the engine could not run them: it offered four triggers, two hard-coded conditions, no contact data, no quiet hours and no frequency cap.

## Triggers

| Kind | Builder examples | How it starts |
|---|---|---|
| Business event | Order placed, checkout abandoned, appointment booked, trial started, payment failed, course enrolled, donation made, listing matched, form submitted, any custom name | `POST /v1/workflows/events {"event","email","data"}`, optionally with event-data filters |
| List join | Contact joins a list | A contact is added to the chosen list (console or API) |
| Date | Birthday, renewal due in 30 days, trial ends in 3 days | Daily scheduler sweep over a contact date field, yearly or once, N days before or after, at a set hour |
| Email engagement | Opened, clicked, delivered, soft-bounced | Tracking events, with optional filters |
| API or manual | Started via API or manually | `POST /v1/workflows/{id}/trigger` and `/trigger/bulk` |

Business events also work mid-journey ("wait until `order_shipped`") and as goals ("exit when `order_placed`"). Event `data` is available to rules as `context.<field>` and in emails as `{{field}}`. Requests are rate-limited and accept an `Idempotency-Key`. Events are dispatched by the workflow worker.

**Who can enter:** everyone, subscribed contacts only (unsubscribed and suppressed contacts are skipped), or contacts matching rules.

**Re-entry:** once ever, again after 30 days, or every time.

## Steps

| Step | Options |
|---|---|
| Send email | Saved template; optional subject override with merge tags; From address on a verified domain; From name; Reply-to. Suppressed contacts are skipped. |
| Wait | Fixed delay (minutes to weeks); a local time of day in the contact's or workspace's zone, with an every day / weekdays / weekends choice; until an open, click or business event, with a maximum; before or after a date (for example 1 day before `context.appointment_at`), then continue or exit if the date is missing or already past |
| If/else and Filter | Rule builder: tags, subscription status, company, location, time zone, any custom contact field, engagement with this workflow's emails, any event field. Comparisons: is, contains, starts/ends with, greater/less than, one of, is set, true/false, before/after a date or `now-7d`. Match all or any rules. Quick picks fill in common checks. |
| A/B split | Any percentage from 1 to 99. Assignment is deterministic, so a contact stays on its path. |
| Update contact | Add or remove tags, set lifecycle stage, set or clear any contact field, subscribe, or unsubscribe (which also suppresses the address) |
| Notify team | Plain-text alert to up to 5 addresses, with merge tags. Not tracked. Sent from a verified domain. |
| Webhook | Signed HTTPS POST with optional extra JSON fields. SSRF-guarded, with bounded retries. |

SMS is still not available. The builder hides it, and imported or legacy SMS steps are flagged and block publishing.

## Sending rules

- **Quiet hours.** Emails that would go out between the "from" and "to" times are held until the window reopens, in each contact's time zone (falling back to the workspace zone) or in the workspace zone. DST is handled by the platform time-zone database.
- **Frequency cap.** At most N marketing emails per contact in 7 days, counted across all workflows and campaigns. Excess sends wait until the cap frees up rather than being dropped.
- **Goal.** Exit or record when the contact clicks or does a business event.
- **Compliance.** Always on: exit on unsubscribe or complaint, and skip suppressed contacts.

## Contact data

Migration 110 adds `tags`, `attributes` (JSON) and `timezone` to contacts. They can be set:
- on create or import through the contacts API,
- with `PATCH /v1/account/data/contacts/{id}/profile`,
- by Update contact steps.

Templates in workflow emails can use `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{email}}`, any contact attribute, and any event or API field.

## Reliability and accuracy

- **One shared codec.** The builder and the AI tools use the same codec (`packages/shared/src/workflow-builder.ts`). Issues are reported on the exact step ("If/else: rule 2 needs a value"), and nothing that cannot run is silently dropped.
- **Publish checks.** Publishing re-validates the definition and checks that sender domains are verified, templates exist, the trigger's list exists and webhook URLs pass the SSRF check.
- **Waiting is durable.** Quiet-hour and frequency-cap holds, waits until a date and waits until a time of day all use the engine's existing durable wake mechanism. If a queue job is lost, the scheduler sweep re-arms it.
- **Contact data is current.** Conditions re-read contact data and this run's email engagement when they execute, so tags or fields changed after enrollment are respected.
- **Date triggers enroll once a day.** Each workflow claims the day before enrolling, so concurrent schedulers cannot enroll the same contacts twice.

## AI

The workflow AI panel and the assistant use the same vocabulary. They can set industry triggers (event name, list, date field), build rule-based branches, add every step type, and set entry rules, quiet hours, frequency caps and goals. Drafts are checked by the same codec and must be published by a person.

## Verification

All of the following run against real Postgres and Redis:
- `packages/tests/workflow-builder-codec.test.ts`: every step type and every industry trigger compiles to a strictly valid definition; precise issues; legacy presets; simulation; the new comparisons.
- `packages/tests/e2e/workflows-advanced.e2e.test.ts`:
  - business events with filters, personalization, waiting on an event and goal exit;
  - tag, attribute and engagement branching with contact updates;
  - entry screening;
  - appointment reminders; time-of-day waits in Tokyo time;
  - quiet hours and frequency cap holds;
  - team alerts;
  - list-join and birthday triggers;
  - healthcare and e-commerce builder documents published and run.
- `packages/customer-ui/scripts/check-workflow-builder-browser.mjs`: in the production UI, picks an industry trigger, configures email, date-wait and rule-builder steps, checks a blocking issue then clears it, autosaves and publishes.

## Limits

- Date fields must be stored as `YYYY-MM-DD` or ISO timestamps.
- Date triggers sweep every 15 minutes, after the configured hour in the workspace time zone.
- "Wait until an event" continues down the same path when the wait times out. Add an If/else on engagement after it to send different follow-ups.
- Notify alerts count against the sending quota.
