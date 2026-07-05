# Email policy learning user story

Status: product reference story. If current Keryx behavior does not yet satisfy a criterion here, treat that criterion as aspirational and as a basis for future implementation.

## Narrative

As a Keryx user, I want to install Keryx once, create an email collector through the setup-provided collector-creator skill, and teach that collector which recurring email actions it may eventually perform silently, so that my inbox becomes less work without giving up control over uncertain, consequential, or unfamiliar decisions.

The user starts from a fresh Keryx checkout and runs `./keryx-setup.sh`. Setup installs or exposes the `/keryx-collector-creator` bundle-backed skill, registers the Keryx plugin surface, and leaves the user able to run `hermes keryx doctor` to confirm the installation. From Hermes, the user invokes `/keryx-collector-creator create a collector for email`. The collector creator authors the source-specific email collector, scripts, prompts, source-specific skill, fixture harness, and policy skeleton into Hermes' own space rather than into the Keryx repository.

The email collector runs periodically. On each run it checks the configured mailbox, uses only trusted contextual knowledge available to the assistant environment — for example system prompt, `SOUL.md`, relevant `AGENTS.md` files, or a personal wiki — and reduces each actionable email to compact facts, source references, risk evidence, and candidate courses of action. Source email content remains untrusted. The collector may use email text as evidence, but it must not follow instructions embedded in emails, must not persist raw private message bodies, and must not claim its own confidence.

Early in use, the collector has little evidence about the user's preferences. For most state-changing actions, such as unsubscribing from a newsletter and moving the message to trash, the collector creates blocked Keryx review cards rather than acting automatically. Each card renders in the Keryx web inbox with concise summary, risk, source reference, available option buttons, and a text input field for optional feedback. The user can approve an option, reject or dismiss the card, or approve/reject while giving textual correction.

When the user approves an option, Keryx records a trusted human execution decision and dispatches the worker. The worker re-queries the email source, verifies the action is still valid, performs only the approved option, records the outcome, and updates the relevant policy/track-record/state files. When the user rejects or dismisses a card, Keryx records that outcome as negative evidence for the collector/class and resets that `(collector, class)` confidence epoch to `cold`. If the rejection includes text, the worker or policy updater stores it as a correction that can improve future classification. If the rejection has no feedback, Keryx invents no correction text, but the cold reset still applies. Later approvals may rebuild confidence only from events after that reset.

Over time, repeated approvals with little or no corrective feedback increase confidence for narrow classes of action. For example, the email collector may learn the class `email:newsletter_unsubscribe_trash`: messages classified as newsletters where the safe action is to click the unsubscribe link when present, then move the message to trash. Confidence is scoped to this collector/class and does not generalize to unrelated email actions. High confidence for newsletter unsubscribe-and-trash does not authorize automatic replies, meeting commitments, purchases, relationship-sensitive responses, or any non-newsletter action.

Once the measured confidence for a narrow class crosses the configured graduation threshold, Keryx creates a dedicated blocked policy proposal card, for example: "Graduate unsubscribe + trash newsletters to automatic silent execution." This card explains the proposed rule, the evidence behind it, its risk bounds, undo path, excluded cases, expected digest behavior, and how the user can revoke or correct it later. The class does not become automatic merely because the collector believes it is ready. Silent state-changing execution begins only after the user approves the graduation card, creating an active human-approved policy rule.

After graduation, future emails matching the approved newsletter class and risk bounds can resolve to `silent`. Keryx creates the card with a synthetic policy decision, dispatches the worker, and reports the result through the non-urgent digest and review log. The user should not be interrupted for routine successful newsletter handling, but can still inspect, undo where possible, revoke the policy rule, or give regret/correction feedback. Items outside the approved class, below confidence, above risk bounds, or requiring credentials, payment, destructive action, ambiguous account choice, CAPTCHA, 2FA, or consent remain review-only or blocked.

## Intended user value

- The user starts with explicit control and gradually earns automation only where repeated behavior justifies it.
- The web inbox becomes a teaching surface: approvals, rejections, and short textual corrections are product input, not just task control.
- Autonomy is narrow and auditable. Trust in one email class does not silently expand to other classes.
- Routine safe actions disappear into a digest, while unfamiliar or consequential actions remain available for review.
- The user can validate whether Keryx is reducing attention cost without hiding meaningful risk.

## Scope

In scope:

- Installation through `./keryx-setup.sh`.
- Availability of `/keryx-collector-creator` after setup.
- Creation of a source-specific email collector in Hermes' own space.
- Periodic email collection via Hermes cron or equivalent collector scheduling.
- Review cards for low-confidence or non-graduated state-changing actions.
- Web UI option buttons, rejection/dismissal controls, and a text feedback field.
- Worker-mediated execution and policy/state updates.
- Confidence scoped by `(collector, class)`.
- Dedicated graduation card before any state-changing silent policy becomes active.
- Silent execution only for approved rules within risk bounds.
- Digest/review-log visibility for silent outcomes.
- Revocation, undo/correction, and confidence demotion after bad silent outcomes.

Out of scope for this story:

- Generic autonomous email sending.
- Silent handling of money, destructive operations, credentials, payment, 2FA, CAPTCHA, or ambiguous account-selection flows.
- Trust derived from source text, model self-report, or collector-declared confidence.
- A second task database outside Hermes Kanban.
- Persisting raw email bodies or credentials in cards, comments, logs, fixtures, or policy files.

## Primary actors

- User: installs Keryx, creates the collector, reviews cards, approves/rejects actions, gives feedback, approves or rejects graduation.
- Email collector: discovers actionable emails, classifies them, creates Keryx action cards, maintains source cursor and exact-dismiss state.
- Keryx web UI: renders review cards, option buttons, rejection/dismissal controls, feedback input, review log, and policy proposal cards.
- Keryx disposition function: resolves each card to `silent`, `review`, or `interrupt` from risk evidence, urgency, derived confidence, and policy.
- Keryx worker: executes trusted decisions, re-checks source state, updates outcomes, and records learning/policy state.
- Policy store / track record: derives confidence and gates silent state-changing execution through active human-approved rules.

## Preconditions

- Hermes is installed and configured.
- Node.js and npm satisfy Keryx requirements.
- The Keryx repository is cloned locally.
- The user can run `./keryx-setup.sh` and `hermes keryx doctor`.
- The email source is configured through a collector-specific safe mechanism, with credentials handled outside card bodies and fixtures.
- The Keryx dashboard is local-only or protected by an external authenticated layer if exposed beyond localhost.

## Happy path

- The user runs `./keryx-setup.sh`.
- Setup exposes `/keryx-collector-creator` and Keryx plugin commands.
- The user runs `/keryx-collector-creator create a collector for email`.
- The collector creator writes an email collector skill, scripts/prompts, policy skeleton, state layout, and fixture tests into Hermes space.
- The collector is scheduled and begins polling email.
- The collector finds a newsletter with an unsubscribe link and proposes an option: unsubscribe, then trash.
- Because confidence for `email:newsletter_unsubscribe_trash` is low or no active policy rule exists, Keryx creates a blocked review card.
- The web UI renders the card with an option button and feedback input.
- The user approves the option, optionally with feedback such as “yes, always remove newsletters like this.”
- Keryx records `keryx.execution_decision.v1`, dispatches the worker, and the worker re-queries the email source before acting.
- The worker unsubscribes, trashes the message, records `keryx.outcome.v1`, updates track record/state, and makes the outcome visible in the review log.
- After repeated consistent approvals and low correction rate, Keryx creates a blocked policy proposal card: “Graduate unsubscribe + trash newsletters to automatic silent execution.”
- The user approves the graduation card.
- Keryx stores an active policy rule scoped to the email collector, newsletter class, and approved risk bounds.
- Future matching newsletters resolve to `silent`, are executed by the worker, and appear in the digest/review log rather than the review inbox.
- Non-newsletter emails, edge cases, and actions outside the rule continue to create review cards.

## Acceptance criteria

### Installation and collector creation

- Given a clean Keryx checkout, when the user runs `./keryx-setup.sh`, then `/keryx-collector-creator` is available to Hermes.
- Given setup has completed, when the user runs `hermes keryx doctor`, then the doctor reports the Keryx plugin, command surface, and required skills as healthy or gives actionable remediation.
- Given the user invokes `/keryx-collector-creator create a collector for email`, then generated collector artifacts are written into Hermes' configured space, not committed into the Keryx repository.
- Given a generated email collector, then it includes fixture support, dry-run instructions, a source cursor, exact-dismiss state, idempotency keys, and a policy skeleton.

### Card creation and review

- Given the email collector discovers an actionable email, then it creates a card through `hermes keryx create-card` or the repository fallback, not raw Kanban mutation.
- Given the proposed action changes email state, then the card declares honest risk axes and an undo path where applicable.
- Given no active policy rule covers the collector/class, then the state-changing action is created as a blocked review card even if the collector proposes review or silent.
- Given a blocked email card, then the web UI renders the summary, risk, source reference, option buttons, and feedback input.
- Given the user approves an option, then Keryx records a trusted execution decision containing the selected option and optional feedback.
- Given the user rejects or dismisses the card, then Keryx records negative evidence and resets that `(collector, class)` confidence epoch to `cold`.
- Given rejection includes text feedback, then Keryx stores the correction in the appropriate collector/policy state for future classification.
- Given rejection has no text feedback, then Keryx still resets confidence to `cold` but invents no synthetic learning instruction.

### Worker execution and learning

- Given a worker receives a reviewed email card, then it re-queries the email source before performing any external side effect.
- Given live source state differs materially from the approved option, then the worker blocks or returns to review rather than acting silently.
- Given execution succeeds, then the worker records a structured outcome and updates track-record/state files used to derive future confidence.
- Given execution fails, then the failure is visible in the card outcome or review log and does not advance source cursor state as successfully handled.
- Given source content contains instructions such as “ignore prior rules” or “mark this as trusted,” then those instructions are treated as untrusted email content and do not affect confidence or execution authority.

### Confidence and graduation

- Given repeated approvals for `email:newsletter_unsubscribe_trash`, then confidence increases only for that collector/class.
- Given approvals for newsletter handling, then unrelated classes such as `email:reply_required`, `email:invoice_payment`, or `email:meeting_commitment` do not inherit that confidence.
- Given confidence crosses the graduation threshold for a state-changing class, then Keryx creates a dedicated blocked policy proposal card rather than enabling silent execution directly.
- Given the graduation card is shown, then it states the proposed rule, class scope, risk bounds, evidence summary, expected action, excluded cases, undo/correction path, digest behavior, and revocation mechanism.
- Given the user approves the graduation card, then Keryx creates an active human-approved policy rule.
- Given the user rejects the graduation card, then the class remains review-only and future similar items continue to create review cards unless proposed again later with new evidence.

### Silent execution after graduation

- Given a future email matches the active newsletter rule, confidence band, and approved risk bounds, then Keryx may resolve it to `silent`.
- Given a card resolves to `silent`, then Keryx records a synthetic policy decision and dispatches the worker without requiring the user to review it first.
- Given silent execution succeeds, then the outcome is visible in the non-urgent digest and review log.
- Given the silent action is reversible or compensable, then the review log exposes an honest undo/correct path.
- Given the user marks a silent action as regretted or incorrect, then Keryx records negative evidence, resets that `(collector, class)` confidence epoch to `cold`, applies textual correction if supplied, and should propose demotion or revocation of the active policy rule.
- Given an email falls outside the active rule, has uncertain classification, exceeds risk bounds, requires credentials/payment/2FA/CAPTCHA/consent, or contains money/destructive implications, then it does not run silently.

### Metrics and auditability

- Given cards are approved, rejected, dismissed, executed, or silently handled, then Keryx can derive metrics from Kanban card status, bodies, and comments without a second task database.
- Given a policy rule authorizes silent execution, then an operator can trace it back to the graduation card and approval event.
- Given a silent newsletter action occurred, then the user can inspect the original compact source reference, selected option, policy reason, worker outcome, and any undo/correction trail.

## Measurable metrics

Product metrics:

- Review burden: number of email review cards per week by collector/class.
- Silent coverage: percentage of matching newsletter items handled silently after graduation.
- False-silent rate: percentage of silent executions later corrected, undone, regretted, or manually restored.
- False-review rate: percentage of review cards approved without feedback for a class that is not yet graduated.
- Feedback rate: percentage of reviewed cards with non-empty textual feedback.
- Correction rate: percentage of approved cards where feedback modifies the proposed action.
- Rejection-with-feedback rate versus rejection-without-feedback rate.
- Graduation latency: number of reviewed examples and calendar time before Keryx proposes graduation.
- Policy acceptance rate: percentage of graduation proposal cards approved by the user.
- Demotion/revocation rate: number of policy rules demoted or revoked after bad outcomes.
- Attention saved: estimated review cards avoided after graduation minus digest/review-log corrections.
- Digest usefulness: percentage of silent outcomes read, archived, corrected, or ignored.

Safety metrics:

- Number of absolute-floor items incorrectly proposed for silent execution. Target: zero.
- Number of state-changing silent executions without an active human-approved rule. Target: zero.
- Number of raw private email bodies persisted in card bodies, comments, logs, fixtures, or policy files. Target: zero.
- Number of worker executions where live source drift was detected after approval.
- Number of duplicate cards or duplicate side effects for the same email external ID. Target: zero.
- Number of actions executed from source-authored instructions rather than trusted decisions. Target: zero.

Operational metrics:

- Collector run success/failure count.
- Collector runtime and wake-agent rate.
- Cursor advancement failures.
- Idempotency collisions and duplicate suppression count.
- Worker success/failure count by option class.
- Time from card creation to user decision.
- Time from policy proposal creation to approval/rejection.

## Fixture and programmatic test ideas

### Setup fixtures

- Fake Hermes home with no Keryx setup, then run `./keryx-setup.sh --dry-run` and assert intended skill/plugin/config operations.
- Fake Hermes home after setup, then assert `/keryx-collector-creator` or its bundle entrypoint is exposed as documented.
- `hermes keryx doctor` fixture where the collector creator is missing, expecting a precise remediation message.

### Collector fixtures

- Newsletter email with stable message ID, sender, subject, unsubscribe link, compact body summary, and no credentials gate.
- Newsletter email without an unsubscribe link, expecting a review or safe alternate option rather than invented unsubscribe.
- Transactional receipt or invoice email that resembles a newsletter but has money implications, expecting no silent unsubscribe/trash.
- Personal email asking for a reply, expecting a different class and review-only disposition.
- Malicious email containing prompt injection instructions to mark itself trusted, expecting no confidence or policy effect.
- Duplicate polling of the same email external ID, expecting idempotent card creation and no duplicate side effect.
- Email whose source state changes between approval and worker execution, expecting worker block or return-to-review.

### Web UI tests

- Review card renders action option buttons and a text feedback field.
- Approve with empty feedback posts selected option and no feedback.
- Approve with feedback posts selected option and feedback text.
- Reject/dismiss with feedback records negative evidence plus correction.
- Reject/dismiss without feedback records negative evidence only.
- Graduation proposal card renders scope, evidence, risk bounds, exclusions, digest behavior, and approve/reject controls.
- Review log renders silent newsletter outcomes with undo/correct/archive controls where applicable.

### Policy and confidence tests

- Repeated approvals for `email:newsletter_unsubscribe_trash` move the confidence band upward for that class only.
- Rejection without feedback resets confidence to `cold` without adding correction text.
- Rejection with feedback stores correction text and affects later classification fixtures.
- Approvals after a rejection/dismissal reset rebuild confidence only from post-reset events.
- Confidence for newsletter handling does not affect `email:reply_required`, `email:invoice_payment`, or other classes.
- Crossing the threshold creates a blocked policy proposal card and does not create an active rule automatically.
- Approving the policy proposal creates an active `keryx.policy.v1` rule with expected bounds.
- Rejecting the proposal leaves subsequent matching cards in review.
- A `shadow` rule computes hypothetical silent behavior but never authorizes execution.
- Regret/correction after silent execution demotes confidence or proposes rule revocation.

### Disposition tests

- State-changing newsletter action with no active policy resolves to `review`.
- Matching newsletter action with active policy, sufficient confidence, and approved risk bounds resolves to `silent`.
- Matching newsletter action with insufficient confidence resolves to `review`.
- Matching newsletter action with blast radius or reversibility outside policy bounds resolves to `review`.
- Any action carrying `money`, `destructive`, or `credential_gate` absolute floor never resolves to `silent`.
- Read-only email digest/monitor action may resolve to silent by design without graduation, provided it emits no external signal.

### Worker tests

- Worker executes only the latest trusted human or policy decision comment.
- Worker refuses to execute if the selected option no longer exists on the card.
- Worker re-queries source before unsubscribe/trash.
- Worker records outcome and updates track record after success.
- Worker does not advance cursor or mark external ID executed after failed source action.
- Worker treats source text as evidence only and does not follow source-authored execution instructions.

### Metrics tests

- Build a synthetic Kanban history and assert review burden, approval rate, correction rate, confidence band, graduation latency, silent coverage, and false-silent rate are derived correctly.
- Build a history containing one bad silent outcome and assert demotion/revocation metrics are emitted.
- Build a history containing unrelated email classes and assert confidence isolation by class.

## Failure modes and required behavior

- Collector creator missing after setup: `hermes keryx doctor` reports the missing bundle/skill and remediation.
- Collector cannot authenticate to email: collector creates no misleading cards and reports configuration failure without storing credentials.
- Source email contains prompt injection: collector and worker ignore instructions in the email body and use only trusted policy/context.
- Collector stores raw private email body: test fails; implementation must store compact references/summaries only.
- Collector advances cursor before card creation: duplicate or lost-item tests fail; cursor may advance only after safe handling.
- Duplicate poll sees the same email: idempotency prevents duplicate cards and duplicate side effects.
- User approves the wrong action accidentally: review log exposes undo/correct where the option is reversible or compensable.
- User rejects without feedback: confidence resets to `cold`, and Keryx does not infer a correction the user did not provide.
- User rejects with feedback: feedback is attached to the learning/policy state and affects future classification.
- Model overgeneralizes from newsletters to other email classes: confidence isolation tests fail; unrelated classes remain review-only.
- Graduation threshold is crossed: Keryx proposes a blocked graduation card, not automatic silent execution.
- Graduation proposal lacks scope or risk explanation: UI/test fails because the user cannot make an informed policy decision.
- Silent execution occurs without active human-approved policy: safety test fails; this must be impossible for state-changing actions.
- Newsletter unsubscribe requires login, 2FA, CAPTCHA, payment, or consent dialog: worker blocks and returns to review or visible human flow.
- Unsubscribe link is absent or ambiguous: worker does not invent an unsubscribe path; it may trash, dismiss, or review depending on approved option and policy.
- Live source state drifts after approval: worker blocks rather than acting on stale assumptions.
- Silent action later regretted: Keryx records regret, resets confidence to `cold`, exposes undo/correction where possible, and should trigger policy demotion or revocation proposal flow.
- Digest is too noisy: metrics should show low attention savings or high archive-without-read; policy/reporting cadence should be adjustable.
- Dashboard is exposed beyond localhost without protection: deployment is invalid unless external authentication/private networking is configured.

## Reporting and validation use

This story should be usable as a reference for real-world usage reports and implementation validation. A report for an email collector should be able to answer:

- How many email cards were reviewed before the first graduation proposal?
- Which class graduated, and what exact active policy rule authorized silent execution?
- What evidence supported the graduation card?
- How many matching emails were handled silently after graduation?
- How many silent outcomes were corrected, undone, or regretted?
- Which classes remained review-only despite newsletter graduation?
- Were any absolute-floor or credential-gated actions proposed for silent execution?
- Did any source prompt injection affect classification, policy, or execution?
- How much review attention was avoided without increasing user corrections?

## Source alignment

This story aligns with Keryx's documented model:

- Keryx is a thin attention-allocation surface over Hermes Kanban.
- Collectors discover actionable items and create structured cards; they do not perform source actions themselves.
- Every actionable card resolves to `silent`, `review`, or `interrupt`.
- Confidence is derived from the user's own decision history for `(collector, class)`, not declared by the collector or by source content.
- State-changing silent execution requires an active human-approved policy rule.
- The web inbox is the user's review and teaching surface.
- Silent outcomes remain auditable through digest and review log.
