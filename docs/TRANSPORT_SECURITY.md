# Sensitive-message transport policy

**Control:** BASE-08 (compliance implementation plan)
**Reviewed:** 2026-07-25

BASE-08 requires one of three positions for PHI or equivalent sensitive data:
enforce secure downstream transport with fail/defer behaviour and documented
recipient exceptions; add message-level encryption or secure-portal delivery;
or prohibit the content class.

**The platform takes the third position, strengthened by a partial version of
the first.** Sensitive regulated content remains prohibited
(`DATA_USE_RESTRICTIONS.md`), and tenants who opt into `tls_required` now get
fail-closed behaviour rather than after-the-fact logging.

## The problem this addresses

`customers.tls_required` (migration 069) originally expressed *intent*. Haraka
tagged the message with `X-MP-Require-TLS`, recorded per-delivery
`tls_secured` evidence, and logged an error when a require-TLS message went
out unencrypted. Every part of that is **detective**: by the time anything
noticed, the message had already been delivered in the clear.

## What is enforced now

1. Every delivery records whether the hop was TLS-secured, per recipient
   domain (`recipient_domain_tls`, migration 080).
2. For a tenant with `tls_required`, the send worker checks that record before
   handing the message to the MTA. A domain observed accepting mail **without**
   TLS is refused with a permanent `tls_required_domain_unsafe` failure —
   retrying changes nothing until the receiving domain fixes its configuration.
3. A domain recovers automatically once it delivers over TLS again. Blocking a
   correspondent forever after one bad hop would be an outage with no security
   benefit.
4. Observations age out after `TLS_UNSAFE_WINDOW_DAYS` (default 30).

Enforcement is per **domain**, not per mailbox, because TLS is negotiated on
the connection to the domain's MX.

Code: `packages/shared/src/transport-security.ts`,
`packages/worker/src/send-worker.ts`.
Tests: `transport-security.e2e.test.ts`, `transport-security-worker.e2e.test.ts`.

## The residual risk, stated plainly

**The first delivery to an unseen domain cannot be protected.** The evidence
that a domain accepts plaintext only exists after a hop to it has completed.
This control bounds exposure to at most one message per domain per window; it
is not guaranteed encrypted delivery.

It is also **hop-by-hop, not end-to-end**. TLS to the recipient's MX says
nothing about what happens after that MX accepts the message — onward
relaying, mailbox storage, or backup all sit outside our control.

These two limits are precisely why PHI and equivalent data stay prohibited.
Opportunistic transport encryption, however well enforced at our edge, is not
a substitute for message-level protection.

## What would change the decision

To accept PHI, at least one of the following is required, plus completion of
the HIPAA workstream and signed BAAs:

- **Message-level encryption** (S/MIME or PGP) so confidentiality does not
  depend on the transport, or
- **Secure-portal delivery**, where the email carries only a notification and
  the content is retrieved over an authenticated session, or
- **Enforced MTA-STS / DANE validation with a pre-send policy lookup**, which
  would close the first-delivery gap by checking the domain's published policy
  before sending rather than inferring capability from history.

None of these are implemented. Adding any of them is a scope change requiring
approval per §16 of the compliance implementation plan.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `customers.tls_required` | false | Per-tenant opt-in to the gate |
| `TLS_UNSAFE_WINDOW_DAYS` | 30 | How long a plaintext observation blocks a domain |

## Recipient exceptions

There is **no per-recipient exception mechanism**, deliberately: an exception
list for a control that exists to protect sensitive content is a way to
quietly disable it. A tenant that needs to reach a domain which cannot do TLS
must either clear `tls_required` (an explicit, auditable decision about their
whole account) or stop sending sensitive content to that correspondent.

## Operations

List domains currently blocked:

```ts
import { listTlsUnsafeDomains } from '@platform/shared';
await listTlsUnsafeDomains();
```

Alert on growth in that list — it usually means a receiving domain regressed,
not that the platform changed. Investigate the receiver's MX TLS configuration
before touching the tenant setting.

## Related

- `docs/DATA_USE_RESTRICTIONS.md` — why PHI remains prohibited (BASE-15)
- `docs/COMPLIANCE_POSTURE.md` — control status
- `docs/COMPLIANCE_IMPLEMENTATION_PLAN.md` — BASE-08, HIPAA-08
