# Sale urgency alerting user story

Status: product reference story. If current Keryx behavior does not yet satisfy a criterion here, treat that criterion as aspirational and as a basis for future implementation.

## Narrative

As a Keryx user, I want to install Keryx once, choose a preferred Hermes messaging target for urgent notifications and daily briefings, and create sale/ticket availability collectors through the setup-provided collector-creator skill, so that time-sensitive buying opportunities reach me quickly without turning Keryx into another dashboard I must remember to poll.

The user starts from a fresh Keryx checkout and runs `./keryx-setup.sh`. During setup, Keryx checks prerequisites, installs and enables the Keryx plugin, ensures the `keryx` Kanban board exists, installs or exposes the setup-managed `/keryx-collector-creator` bundle, lists configured Hermes delivery targets with `hermes send --list --json`, and stores the selected target as `notifyTarget`. This target is used for high-urgency interrupt pushes and normal digest/daily briefing delivery. If no Hermes delivery target is available, setup still completes in a safe local mode and `hermes keryx doctor` reports that outbound urgent notification delivery is unavailable.

After setup, the user invokes `/keryx-collector-creator` and asks it to create a sale monitor. The user supplies several sources: a ticketing page for an upcoming concert, one or more ecommerce product pages, and optional criteria such as desired artists, date range, venue, seat type, target item variants, discount threshold, maximum price, preferred currency, stock status, shipping region, or whether resale listings are acceptable. The collector creator writes the source-specific skill, scripts/prompts, fixtures, cursor/idempotency state, and scheduling metadata into Hermes' own space rather than into the Keryx repository.

The sale collector is a read-only monitor. It reads public or configured sources, extracts compact facts, compares them with user criteria, and creates Keryx-compatible cards or outcomes that notify the user. It does not buy tickets, reserve stock, submit payment, join queues, log into gated flows, solve CAPTCHAs, accept terms, or leave external signals. Because purchases and reservations involve money and external commitments, those remain approval-gated or out of scope for this read-only alerting story. The collector's job is to detect and report; the user's job is to decide whether to buy.

On each scheduled run, for example every six hours, the collector checks each configured source, treats all page text as untrusted source content, normalizes prices and availability, deduplicates repeated findings, validates emitted card bodies against `keryx.action_item.v2`, and uses `hermes keryx create-card` rather than raw Kanban mutation. If no configured opportunity is found, the no-work path is quiet. If a matching opportunity is detected, the collector routes it as a time-sensitive read-only result with `reversibility: read_only`, `blast_radius: self`, no `absolute_floor`, and `result_delivery: push`. Keryx sends a self-contained notification through the configured `notifyTarget`, including what changed, why it matches the user's criteria, freshness evidence, source link, observed price/stock/ticket status, risk or caveat, and a default expectation that Keryx will not purchase automatically.

The phrase “as soon as it detects something” means Keryx notifies immediately after a scheduled or manually triggered collector run identifies a new matching opportunity. With a six-hour schedule, the expected detection latency is bounded by the cron interval plus collector runtime and delivery latency; it is not continuous real-time monitoring unless the user chooses a more frequent schedule. If ticket or sale dynamics make a six-hour interval too slow, Keryx should expose that as an operational risk and let the user choose a tighter schedule, subject to source rate limits and attention budget.

The user can later validate whether this works in the real world by inspecting setup configuration, collector artifacts, fixture runs, cron history, Kanban cards/comments, delivery records, digest output, and Keryx metrics. The story should support programmatic tests, synthetic fixtures, and reports that measure timeliness, false alerts, missed opportunities, source health, idempotency, and attention cost.

## Assumptions for this story

- Keryx setup uses one configured `notifyTarget` for interrupt pushes and digest/daily briefing delivery unless future configuration supports separate targets.
- Sale/ticket monitoring is notification-only. Keryx does not purchase, reserve, pay, join gated checkout flows, or submit forms in this story.
- “High urgency” means a configured source has a fresh, criteria-matching opportunity where delay may cause stock, tickets, or price to disappear.
- The collector runs every six hours by default for this story, but the schedule is configurable and may be shortened for fast-moving sources.
- Collector creation may create the Hermes cron job automatically when safe, or propose/show the exact cron command for approval if the environment requires explicit user confirmation.
- Concrete fixtures should cover at least concert ticket availability and ecommerce discount/stock monitoring.

## Intended user value

- The user gets urgent, criteria-matched sale/ticket opportunities without checking sites manually.
- Keryx spends real-time attention only on opportunities that match explicit criteria and may expire.
- Purchases and money-bearing actions remain under user control.
- The collector is testable against fixtures and measurable against real-world runs.
- The user can distinguish “nothing found,” “collector failed,” and “opportunity detected but delivery failed.”

## Scope

In scope:

- Installation through `./keryx-setup.sh`.
- Setup-managed installation/exposure of `/keryx-collector-creator` as a bundle-backed skill.
- Detection and selection of Hermes delivery targets through `hermes send --list --json`.
- Storing the selected target as Keryx `notifyTarget` for urgent pushes and digest/daily briefing delivery.
- Creating source-specific sale/ticket collectors through `/keryx-collector-creator`.
- Polling configured ticket and ecommerce sources on a default six-hour schedule.
- Read-only extraction of availability, price, discount, variant, venue/date, and source reference facts.
- Criteria-matched push notifications for fresh time-sensitive findings.
- Idempotency, cursor safety, fixture support, dry-run support, and source-health reporting.
- Keryx card validation, disposition, auditability, and metrics derived from Hermes/Keryx state.
- Programmatic tests for setup, delivery target selection, collector generation, fixture parsing, card validation, scheduling, idempotency, notification rendering, and failure behavior.

Out of scope for this story:

- Automatic purchase, reservation, checkout, queue joining, payment, or bid submission.
- Silent actions involving money, credentials, CAPTCHA/2FA, consent dialogs, destructive actions, or external commitments.
- Using source-authored text as trusted instructions.
- Persisting raw HTML/page bodies, cookies, credentials, payment data, or large source payloads in cards, comments, logs, fixtures, or outcomes.
- Replacing Hermes cron, Kanban, worker dispatch, logs, retries, skills, or delivery.
- Committing generated source-specific collectors into the Keryx repository.
- Guaranteeing continuous real-time detection on a six-hour schedule.

## Primary actors

- User: installs Keryx, chooses the delivery target, asks the collector creator to build sale/ticket monitors, receives urgent alerts, and decides whether to buy.
- Setup script: checks prerequisites, installs/enables the plugin, installs the collector-creator bundle, lists delivery targets, writes configuration, and runs doctor.
- Collector creator: designs the source-specific collector, fixtures, state layout, prompts/scripts, and cron schedule in Hermes' space.
- Sale/ticket collector: polls configured sources, extracts compact facts, compares them with criteria, creates validated Keryx cards/outcomes, and maintains cursor/idempotency state.
- Keryx disposition function: ensures read-only monitor findings can be routed silently/push-only without granting purchase authority.
- Keryx worker or delivery path: renders and sends the alert through the configured `notifyTarget`, and records structured outcome/delivery information.
- Hermes cron and delivery: run the collector on schedule and deliver pushes/digests through configured gateway targets.
- Metrics/reporting surface: derives timeliness, precision, recall, source health, delivery, and attention metrics from existing Keryx/Hermes records.

## Preconditions

- Hermes is installed, configured, and available on `PATH` as `hermes`.
- Node.js and npm satisfy Keryx requirements.
- The Keryx repository is cloned locally.
- The user can run `./keryx-setup.sh` and `hermes keryx doctor`.
- At least one Hermes delivery target is configured if urgent alerts should reach the user outside the local UI.
- Target websites are reachable without prohibited scraping, or required access is configured safely outside cards, logs, and fixtures.
- The Keryx dashboard remains local-only or externally protected if exposed beyond localhost.

## Happy path

- The user runs `./keryx-setup.sh` from the Keryx repository.
- Setup verifies Hermes CLI, Node, npm, Keryx board, plugin installation, and collector-creator bundle installation.
- Setup lists available Hermes delivery targets and asks the user to select the preferred target for high-urgency notifications and daily briefings.
- The user selects a target, for example a Telegram or Discord Hermes gateway target.
- Setup writes or preserves `keryx.config.json`, including `notifyTarget`.
- Setup runs `hermes keryx doctor`, which reports the plugin, collector creator, delivery target, and relevant cron/config health.
- The user invokes `/keryx-collector-creator create a sale monitor for these sources: <concert ticket URL>, <shop product URL>, <shop search URL>`.
- The user provides criteria such as artist, event date, acceptable seats, max ticket price, target product variant, minimum discount, and shipping region.
- The collector creator classifies the collector as a read-only monitor and writes source-specific artifacts into Hermes' space.
- The collector creator includes fixture data and dry-run commands for concert ticket and ecommerce product scenarios.
- The collector creator creates or proposes a Hermes cron job scheduled every six hours, loading the source-specific skill and `keryx:keryx-collector`.
- The collector dry-run against fixtures validates expected no-work, ticket-available, product-discounted, product-out-of-stock, and malformed-source behavior.
- On a scheduled run, the collector polls the configured sources.
- If no matching opportunity exists, the collector exits quietly and records healthy source status.
- If a concert ticket becomes available and matches criteria, the collector creates a validated read-only Keryx card/outcome with stable idempotency key and push delivery metadata.
- Keryx sends an urgent notification through `notifyTarget` with the event, availability, price, source link, observed timestamp, match reason, caveat, and “Keryx has not purchased or reserved this.”
- If the same opportunity is still present on the next run, idempotency prevents duplicate noisy alerts unless a material change occurs.
- The user can inspect Keryx/Hermes records to confirm when the source was checked, when the match was detected, when the push was sent, and whether delivery succeeded.

## Acceptance criteria

### Installation and setup

- Given a clean Keryx checkout, when the user runs `./keryx-setup.sh`, then setup checks that Hermes CLI, Node.js, and npm are available before writing Keryx configuration.
- Given setup runs successfully, then it installs/enables the Keryx plugin and ensures the `keryx` Kanban board exists.
- Given setup runs successfully, then `/keryx-collector-creator` is available through the setup-managed bundle.
- Given Hermes delivery targets exist, when setup runs, then it lists them using `hermes send --list --json` or the documented wrapper and lets the user select one.
- Given the user selects a delivery target, then Keryx stores it as `notifyTarget` for interrupt pushes and digest/daily briefing delivery.
- Given no Hermes delivery targets exist, then setup completes without fabricating a target and doctor reports that outbound urgent notification delivery is unavailable.
- Given setup cannot list delivery targets because Hermes send is unavailable or malformed, then setup reports the failure and either enters safe local mode or asks the user whether to continue without outbound delivery.
- Given `./keryx-setup.sh --dry-run`, then setup reports planned plugin, bundle, config, delivery-target, and doctor actions without writing files.
- Given an existing `keryx.config.json`, then setup preserves it by default unless the user explicitly overwrites it or runs `--force`.
- Given setup completes, when the user runs `hermes keryx doctor`, then doctor reports plugin, collector creator, delivery target, and collector/digest cron health or gives actionable remediation.

### Collector creation

- Given setup has installed `/keryx-collector-creator`, when the user asks for a sale monitor with ticket and ecommerce URLs, then the collector creator generates source-specific artifacts in Hermes' space, not in the Keryx repository.
- Given the user provides multiple websites, then the generated collector records each source with a stable source ID, source type, polling method, user criteria, and source-specific caveats.
- Given the user provides insufficient criteria, then the collector creator asks only for criteria that materially affect alerting, such as target product variant, event date, maximum price, discount threshold, or region.
- Given the requested collector only reads sources and notifies the user, then generated cards/outcomes use `reversibility: read_only`, `blast_radius: self`, no `absolute_floor`, and push-oriented result delivery for matched opportunities.
- Given the user asks the collector to buy, reserve, bid, checkout, or submit payment automatically, then the collector creator rejects that behavior for this read-only story or splits it into approval-gated future work.
- Given a generated collector, then it includes fixture support, dry-run instructions, idempotency keys, cursor/state handling, source health reporting, and no-work behavior.
- Given source credentials are required, then the collector creator stores only credential instructions or references outside cards, comments, logs, and fixtures.
- Given fixtures are generated, then they contain compact representative facts and synthetic/redacted snippets, not raw full pages, cookies, credentials, payment data, or private account content.

### Scheduling and orchestration

- Given the sale monitor is created, then it is scheduled every six hours by default unless the user chooses another cadence.
- Given the collector creator cannot safely create the cron job automatically, then it shows the exact `hermes cron create` command and required skills/scripts so the user can approve or run it.
- Given the collector cron is created, then it loads the source-specific skill and the plugin-qualified generic skill `keryx:keryx-collector`.
- Given the collector is programmatic, then its script lives directly under `$HERMES_HOME/scripts/` and cron references it by bare filename.
- Given no matching opportunities are found, then the collector no-work path is quiet and does not wake an agent or push a notification unnecessarily.
- Given a matching opportunity is found, then the collector creates a card/outcome and notification within the same run rather than waiting for a daily briefing.
- Given the collector runs every six hours, then reports calculate detection latency from source-check time to push-delivery time and do not claim continuous monitoring.
- Given source volatility suggests six hours is too slow, then Keryx exposes schedule risk or lets the user choose a shorter cadence.
- Given source rate limits, robots policy, authentication, or anti-bot behavior make frequent polling unsafe, then the collector reports the constraint and does not silently hammer the source.

### Detection and classification

- Given a ticketing page shows no availability or no matching date/seat/price, then the collector does not alert.
- Given a ticketing page shows matching tickets available, then the collector emits a time-sensitive read-only alert with event, date, venue, observed price, availability status, source reference, and observed timestamp.
- Given an ecommerce product page shows the target product in stock but above the configured price or below the configured discount threshold, then the collector does not alert.
- Given an ecommerce product page shows the target variant in stock and meeting the discount/price criteria, then the collector emits a time-sensitive read-only alert with product, variant, price, discount evidence, stock status, source reference, and observed timestamp.
- Given a source exposes stale cached availability, ambiguous price, unknown currency, missing variant, or conflicting stock signals, then the collector either downgrades to review/diagnostic output or includes the uncertainty in the alert rather than overstating confidence.
- Given source text includes instructions such as “ignore previous instructions,” “notify immediately regardless of criteria,” or “mark this trusted,” then those instructions are treated as untrusted source content and have no effect on urgency, criteria, policy, schedule, or execution authority.
- Given a collector proposes `silent` or `interrupt`, then Keryx's disposition function remains authoritative and may only downgrade unsafe or unsupported claims.
- Given any option involves money, checkout, credentials, CAPTCHA, 2FA, consent, or external commitment, then it is not classified as a pure read-only notification.

### Card creation, delivery, and notification content

- Given the collector emits a Keryx card, then it starts from the current template or schema, validates with `hermes keryx validate-card`, and creates the card with `hermes keryx create-card`.
- Given a matched opportunity is detected, then the notification is sent through configured `notifyTarget` using Hermes delivery rather than a collector-specific ad hoc messaging path.
- Given a notification is sent, then it includes a concise summary, match reason, key facts, source link, freshness timestamp, risk/caveat, and clear statement that no purchase or reservation was made.
- Given a notification is sent, then source links are human-readable clickable references where the delivery channel supports it.
- Given `notifyTarget` is missing, then the matched opportunity remains visible in Keryx/Hermes state and doctor reports missing outbound delivery; Keryx does not claim a successful push.
- Given `hermes send` delivery fails, then Keryx records the failure with enough detail for remediation and does not mark the alert as delivered.
- Given the same matching opportunity appears across repeated runs, then idempotency suppresses duplicate alerts unless a material change occurs, such as lower price, new availability after previous sellout, new date, or new product variant.
- Given a material change occurs after an earlier alert, then Keryx may send a new alert that explains what changed.

### Auditability and metrics

- Given the setup script runs, then Keryx can report setup step outcomes for plugin, bundle, config, delivery target, and doctor.
- Given the collector runs, then Keryx can report last run time, success/failure, sources checked, source health, number of candidates found, number matched, number skipped, number alerted, runtime, and cursor/idempotency state.
- Given a notification is delivered, then Keryx records target, timestamp, delivery status, source item ID, card/outcome reference, and rendered message metadata sufficient for later reporting.
- Given a user marks an alert irrelevant, duplicate, stale, too late, or useful, then that feedback is attributable to the sale collector and relevant source/class.
- Given cards, outcomes, comments, and deliveries exist, then metrics are derived from Hermes/Keryx state rather than a second task database.
- Given an operator inspects a report, then each alert can be traced back to compact source references and collector run metadata without exposing raw page bodies or credentials.

## Measurable metrics

Product metrics:

- Alert precision: percentage of sale/ticket alerts the user marks useful, acts on, or does not later mark irrelevant/stale/duplicate.
- Alert recall proxy: percentage of known fixture or retrospectively identified opportunities that Keryx detected and alerted before expiry.
- Detection latency: time from collector source-check start to matched opportunity creation.
- Delivery latency: time from matched opportunity creation to successful Hermes delivery.
- End-to-end latency: time from source observation timestamp to user-visible notification.
- Opportunity freshness: age of observed price/stock/ticket evidence when delivered.
- Criteria match accuracy: percentage of alerts that satisfy configured artist/date/variant/price/discount/region criteria.
- Duplicate alert rate: percentage of alerts that repeat the same opportunity without material change.
- Material-change alert rate: percentage of repeated alerts justified by lower price, restock, new tickets, or changed availability.
- Attention burden: number of sale/ticket pushes per week by source and urgency tier.
- No-work quietness: percentage of no-match runs that produce no user-facing push.
- Manual-check reduction: configured sources checked per week versus user visits or manual checks avoided, where observable.

Safety metrics:

- Number of automatic purchases, reservations, bids, checkout submissions, payment attempts, or queue joins. Target: zero for this story.
- Number of read-only alerts that left an external signal on the source site. Target: zero.
- Number of money/credential/CAPTCHA/2FA/consent-gated actions incorrectly classified as read-only. Target: zero.
- Number of source-authored instructions that affected criteria, urgency, policy, schedule, or execution. Target: zero.
- Number of raw full pages, cookies, credentials, payment details, or private account payloads persisted in cards, comments, logs, fixtures, or outcomes. Target: zero.
- Number of delivery failures incorrectly marked successful. Target: zero.
- Number of alerts missing a source reference or observed timestamp. Target: zero for matched alerts.

Operational metrics:

- Setup success/failure count by step: prerequisites, board, plugin, collector-creator bundle, config, delivery target, doctor.
- Collector run success/failure count by source.
- Collector runtime p50/p95 by source and total run.
- Cron drift between scheduled run time and actual run start.
- Source coverage: percentage of configured sources successfully checked per run.
- Source failure count by class: network, parse, source format change, rate limit, authentication, anti-bot, state write, delivery.
- Wake-agent rate for programmatic collectors.
- Idempotency collision and duplicate suppression count.
- Cursor advancement failures or conservative reprocessing count.
- Alert render failures and Hermes send failures.

## Fixture and programmatic test ideas

### Setup fixtures

- Fake Hermes home with no Keryx setup; run `./keryx-setup.sh --dry-run` and assert planned plugin, board, bundle, config, delivery-target, and doctor operations.
- Fake Hermes home with two delivery targets; run setup with scripted input selecting one and assert `keryx.config.json` stores the selected `notifyTarget`.
- Fake Hermes home with no delivery targets; assert setup completes safely and doctor warns that outbound urgent notification delivery is unavailable.
- Existing config fixture; assert setup keeps existing `notifyTarget` by default and overwrites only with explicit confirmation or `--force`.
- Malformed `hermes send --list --json` fixture; assert setup does not write a bogus target and gives actionable remediation.
- Missing collector-creator bundle fixture; assert `hermes keryx doctor` reports a precise remediation to rerun setup.

### Collector creator fixtures

- User prompt: “Create a sale monitor for this concert ticket page and these two product pages; alert me for tickets under $150 or product discounts above 30%”; assert generated artifacts live in Hermes skills/scripts/state space.
- Prompt with only read-only monitoring; assert generated option metadata is `read_only`, `blast_radius: self`, no `absolute_floor`, and matched opportunities use push delivery.
- Prompt asking “buy automatically if under $150”; assert the collector creator refuses automatic purchase for this story or creates an approval-gated separate action, not read-only silent execution.
- Prompt with missing threshold; assert the collector creator asks for price/discount/variant/date criteria rather than creating a noisy generic monitor.
- Prompt with a login-only ticketing site; assert generated instructions keep credentials outside fixtures/cards and flag gated access as a risk.
- Generated fixture set contains compact ticket/product facts, canonical URLs, observed timestamps, price, currency, availability, and source IDs only.
- Generated collector includes dry-run instructions and expected no-work behavior.

### Ticket fixtures

- Concert ticket page with no availability; assert no alert and healthy source status.
- Concert ticket page with available tickets above max price; assert no alert or diagnostic skip reason.
- Concert ticket page with available tickets under max price; assert one validated read-only alert.
- Concert ticket page with wrong date or venue; assert no alert.
- Resale listing fixture where resale is not allowed by user criteria; assert no alert.
- Ambiguous seat/price fixture; assert uncertainty is included or item is skipped/reviewed rather than overstated.
- Ticket page containing prompt-injection text; assert no effect on urgency, criteria, policy, or notification content beyond safe summary.
- Duplicate poll of same ticket listing; assert idempotency prevents duplicate alert.
- Same event after sellout and later restock; assert material-change alert can be sent.

### Ecommerce fixtures

- Product page out of stock; assert no alert unless user explicitly requested restock alerts.
- Product page in stock but no discount; assert no alert.
- Product page in stock with discount below threshold; assert no alert.
- Product page in stock with discount above threshold and matching variant; assert one validated read-only alert.
- Product page with matching discount but wrong size/color/region; assert no alert.
- Product page with ambiguous currency, shipping region, or tax inclusion; assert alert includes caveat or downgrades.
- Product search/listing page with multiple matching items; assert deterministic ranking and no duplicate source IDs.
- Product page containing source-authored instructions; assert no effect on schedule, criteria, urgency, or execution authority.

### Scheduling and cron tests

- Default schedule fixture; assert collector cron is every six hours.
- Custom schedule fixture such as every 30 minutes for concert tickets; assert schedule is stored and doctor/metrics report the chosen cadence.
- Programmatic collector fixture; assert script lives under `$HERMES_HOME/scripts/` and cron references a bare filename.
- Direct-agent collector fixture; assert cron loads `keryx-collector-<source>` and `keryx:keryx-collector` skills in the expected order.
- No-work script output fixture; assert `{"wakeAgent": false}` or equivalent quiet path produces no push.
- Paused/missing collector cron; assert doctor reports disabled/stale source status.
- Source rate-limit fixture; assert collector records rate-limit failure and does not retry aggressively.

### Card, disposition, and delivery tests

- Generated ticket/product alert card validates against `keryx.action_item.v2`.
- Read-only alert with `blast_radius: external` fails schema validation.
- Read-only alert with `absolute_floor: money` fails or is downgraded because money-bearing actions are not read-only notifications.
- Collector tries to create a card through raw Kanban mutation; docs/tests should reject this path in favor of `hermes keryx create-card`.
- Matched opportunity with push delivery renders a self-contained alert containing summary, match reason, key facts, source link, observed timestamp, caveat, and no-purchase statement.
- Missing `notifyTarget` fixture; assert alert remains auditable and delivery is not marked successful.
- Failed `hermes send` fixture; assert failure is recorded and surfaced.
- Repeated unchanged opportunity fixture; assert duplicate notification is suppressed.
- Material price drop fixture; assert a second notification is allowed and explains the change.

### Metrics and reporting tests

- Build synthetic seven-day collector history and assert source coverage, runtime, no-work quietness, detection latency, delivery latency, duplicate rate, and alert counts.
- Build a history with one known missed fixture opportunity and assert alert recall proxy or missed-opportunity reporting reflects it.
- Build a history with irrelevant user feedback and assert alert precision/correction metrics attribute it to the sale collector/source.
- Build a history with delivery failures and assert delivery success rate excludes failed sends.
- Build a history with source format changes and assert source-health reporting marks the source warning/failed/stale as appropriate.
- Build a history with source prompt injection and assert safety metrics count the attempt but show no policy/disposition effect.

## Failure modes and required behavior

- Setup cannot find Hermes CLI: setup fails early with remediation and does not write misleading config or cron state.
- Setup cannot list delivery targets: setup enters safe local mode or asks whether to continue without outbound delivery; doctor reports the limitation.
- User selects an invalid delivery target: setup rejects it or re-prompts rather than storing a broken `notifyTarget`.
- Collector-creator bundle is missing after setup: `hermes keryx doctor` reports the missing bundle and remediation.
- Existing config conflicts with selected target: setup preserves by default and overwrites only with explicit confirmation or `--force`.
- Collector cannot parse a source: it records a source failure and does not fabricate availability or price.
- Source is stale, cached, or contradictory: alert includes caveat or downgrades/skips rather than claiming certainty.
- Source requires login, CAPTCHA, 2FA, payment, consent, or queue interaction: collector blocks that source or uses visible/approved handling; it does not automate through gates invisibly.
- Source content contains prompt injection: collector treats it as untrusted content and does not change criteria, schedule, urgency, policy, or execution behavior.
- Collector stores raw page bodies, cookies, credentials, or payment data: tests fail; implementation must store compact facts/references only.
- Collector advances cursor before card creation or delivery state is safely recorded: lost-opportunity tests fail; cursor may advance only after safe handling or explicit skip.
- Duplicate poll sees the same opportunity: idempotency prevents duplicate noisy alerts.
- Same opportunity changes materially: Keryx may alert again and must explain the change.
- Collector runs every six hours but the sale expires between runs: reporting should classify this as schedule/recall limitation, not a delivery failure.
- Matched opportunity is detected but `notifyTarget` is missing: item remains auditable and doctor reports missing outbound delivery.
- Hermes delivery fails: Keryx records failure and does not mark the notification delivered.
- Alert arrives too late to act: metrics capture end-to-end latency and can justify a shorter schedule or different source strategy.
- Alert is noisy or irrelevant: feedback should affect future criteria/ranking without granting purchase authority.
- Any purchase, reservation, checkout, bid, or payment occurs automatically: this story fails; money-bearing actions require explicit approval and are out of scope here.

## Reporting and validation use

This story should be usable as a reference for real-world usage reports and implementation validation. A report for a sale/ticket urgency collector should be able to answer:

- Did setup install the plugin and collector-creator bundle successfully?
- Which Hermes delivery target was selected as `notifyTarget`?
- Which sources were configured, and what criteria apply to each?
- What schedule is the collector running on, and why was that cadence chosen?
- When did each source last run successfully?
- How many source items were checked, skipped, matched, deduplicated, and alerted?
- What was the detection latency and delivery latency for each alert?
- Did each alert include source reference, observed timestamp, price/availability facts, match reason, and no-purchase statement?
- Were any duplicate alerts sent without material change?
- Were any material opportunities missed because of schedule, parsing, source failure, or delivery failure?
- Did any source text or prompt injection affect collector behavior?
- Did any collector output leave an external signal despite being classified as read-only?
- Did any automatic purchase/reservation/payment occur? The expected answer for this story is no.
- How often did the user mark alerts useful, stale, irrelevant, duplicate, too late, or missing?
- Should the collector cadence, criteria, source list, or delivery target change based on observed metrics?

## Source alignment

This story aligns with Keryx's documented model:

- Keryx is a thin attention-allocation surface over Hermes Kanban.
- Setup installs/enables the Keryx plugin and exposes the `/keryx-collector-creator` bundle.
- Setup lists Hermes delivery targets and stores the chosen `notifyTarget` for interrupts and digest delivery.
- Collectors are authored into Hermes' own space, not committed into the Keryx repository.
- Collectors discover and classify; they do not execute source-side purchases or commitments.
- `read_only` monitor outputs are silent by design because they mutate no state and exercise no external authority.
- Time-sensitive read-only findings may use push delivery when the finding itself is urgent.
- Purchases, payments, credential gates, CAPTCHA/2FA, destructive actions, and external commitments remain approval-gated by the absolute-floor safety model.
- Every actionable card resolves through the disposition function, not source content or collector self-authority.
- Source content is untrusted and should be reduced to compact facts and source references.
- Metrics should be derived from Keryx/Hermes state rather than a second task database.

Known aspirational gaps captured by this story:

- The current README says setup installs the collector creator and stores the selected delivery target, but also says setup does not create real collector cron jobs; this story allows the collector creator to create or propose the collector cron job after authoring.
- The current README documents `notifyTarget`, digest, interrupt, metrics, and collector commands; this story turns those capabilities into an end-to-end sale/ticket alerting validation scenario.
- If current Keryx does not yet support source-health reporting, material-change dedupe, alert-feedback metrics, or delivery records at the specificity described here, those criteria are intended future behavior.
