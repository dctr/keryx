# Daily news briefing user story

Status: product reference story. If current Keryx behavior does not yet satisfy a criterion here, treat that criterion as aspirational and as a basis for future implementation.

## Narrative

As a Keryx user, I want to install Keryx once, choose when my daily briefing should arrive, and create a read-only news collector through the setup-provided collector-creator skill, so that useful news appears in my daily briefing without creating a new dashboard to poll or a stream of avoidable notifications.

The user starts from a fresh Keryx checkout and runs `./keryx-setup.sh`. During setup, Keryx asks what time of day the user wants their daily briefing delivered, stores that preference in Keryx configuration, configures a Hermes delivery target through `hermes send`, installs the Keryx plugin, and installs or exposes the setup-managed `/keryx-collector-creator` bundle. Setup creates the daily Keryx briefing cron job at the chosen time. If current implementation does not yet create that cron job, this story treats cron creation as required future behavior rather than an optional integration point.

After setup, the user invokes `/keryx-collector-creator` and asks for a news briefing collector, naming several news websites or feeds. The collector creator recognizes that the requested collector is a read-only monitor: it reads sources and compiles a private briefing section such as “the important technology stories from the last 24 hours.” It emits no external signal and performs no source-side mutation. Because it is `read_only`, the collector's output is silent by design. It does not need a learned graduation rule, does not require a review card, and should not interrupt the user unless a specific finding is separately classified as urgent and consequential.

The generated news collector lives in Hermes' own space rather than in the Keryx repository. It includes source-specific skill instructions, source access configuration, fixture support, idempotency/cursor state, a dry-run path, and a cron schedule. Because the collector's output is intended for the daily briefing, the collector creator schedules it to run before the daily briefing, with enough time for source reads, classification, and retries. The default lead time is one hour before the configured daily briefing time, unless the collector has measured runtime evidence requiring a longer window.

On each run, the news collector reads configured sources, treats all source text as untrusted content, extracts compact facts and source references, ranks items by relevance and novelty, and creates validated Keryx cards or outcomes with `reversibility: read_only`, `blast_radius: self`, no `absolute_floor`, and digest-oriented delivery metadata. The collector should not persist full article bodies, paywalled content, credentials, cookies, or large raw source payloads in cards, comments, logs, outcomes, or fixtures.

At the configured daily briefing time, Keryx delivers one message through the delivery target chosen during Keryx setup. The briefing cron job decides how to compile the briefing and in which order to present items using Keryx card priorities, urgency, and configured section rules. A typical order is: urgent/time-sensitive carry-over if it was not already pushed, high-priority briefing sections such as today's important tech news, calendar/weather or other configured sections, then low-urgency autonomous outcomes such as unsubscribed-and-deleted newsletters, deleted temporary files, or booked arrangements. Truly urgent and consequential items should not wait for the daily briefing; they follow the `interrupt` path and are pushed separately with a self-contained recommendation, risk, and default.

The user can later validate whether Keryx is doing the right thing by inspecting briefing output, collector run history, source references, synthetic Kanban history, digest composition, and attention metrics. The story should therefore support real-world usage reporting, fixture-driven programmatic tests, and measurable metrics around timeliness, source freshness, briefing usefulness, notification precision, and safety boundaries.

## Assumptions for this story

- Keryx setup creates a daily briefing cron job and asks the user when that briefing should be delivered.
- The daily briefing is delivered through the Keryx setup-selected `notifyTarget` / Hermes `hermes send` target.
- This story's news collector output is primarily ranked technology-news summaries from configured news websites/feeds over the last 24 hours, with links and compact “why this matters” context, not state-changing recommendations.
- Urgent and consequential findings may bypass the daily briefing through the normal Keryx interrupt path; ordinary news waits for the configured daily briefing.
- The default collector lead time is one hour before briefing delivery unless explicitly overridden by collector metadata or observed runtime.
- Briefing item order is decided by the briefing cron job from card priorities, urgency, and section rules; low-urgency operational outcomes normally appear after higher-priority news/briefing content.

## Intended user value

- The user chooses one daily attention checkpoint during Keryx setup instead of receiving opportunistic news pings.
- Safe read-only monitoring happens autonomously because it exercises no external authority.
- Collector scheduling is derived from the user's briefing time rather than requiring manual cron coordination.
- Higher-priority briefing content, such as important news, appears before low-urgency operational “what Keryx did” summaries because ordering follows priority and urgency.
- Real-world usage can be evaluated from logs, cards, outcomes, delivery timestamps, and user feedback rather than vague impressions.

## Scope

In scope:

- Installation through `./keryx-setup.sh`.
- Prompting for daily briefing time during setup.
- Storing daily briefing time and delivery target in Keryx configuration.
- Setup-managed installation of `/keryx-collector-creator` as a bundle-backed skill.
- Setup creation of a Keryx daily briefing cron job.
- Creating a source-specific news collector through `/keryx-collector-creator`.
- Classifying the news collector as `read_only`, `blast_radius: self`, no `absolute_floor`, and default `result_delivery: digest`.
- Scheduling the news collector before the daily briefing, defaulting to one hour lead time.
- Compiling daily briefing sections in priority/urgency order, with ordinary autonomous-outcome summaries normally later than important news.
- Deriving metrics from Keryx/Hermes state without introducing a second task database.
- Fixture and programmatic tests for setup, scheduling, classification, briefing composition, and failure behavior.

Out of scope for this story:

- Replacing Hermes cron, Kanban, skills, logs, dispatch, or delivery.
- Committing generated source-specific collectors into the Keryx repository.
- Silent source-side changes such as marking articles read, subscribing/unsubscribing, posting comments, saving bookmarks to external services, or training recommendation feeds.
- Persisting raw article bodies, credentials, cookies, or paywalled content in cards, comments, logs, fixtures, or outcomes.
- Using news source text as trusted instructions.
- Treating ordinary news as an interrupt merely because it is interesting.
- Building a general news product; this story is about validating Keryx's attention-allocation and reporting model.

## Primary actors

- User: installs Keryx, chooses briefing time and delivery target, asks the collector creator to create a news collector, reads the daily briefing, and gives corrections or preference feedback.
- Setup script: checks prerequisites, installs/enables Keryx plugin and collector-creator bundle, writes configuration, and creates or verifies the daily briefing cron job.
- Collector creator: designs the source-specific news collector, fixtures, state layout, prompts, and schedule in Hermes' space.
- News collector: reads configured news sources, classifies results as read-only monitor output, creates Keryx-compatible outcomes/cards, and maintains source cursors/idempotency.
- Keryx disposition function: ensures `read_only` news monitor output resolves to silent/digest behavior and does not become review or interrupt without evidence of urgency/consequence.
- Keryx daily briefing cron job: assembles the daily message from available read-only monitor outputs and Keryx outcome comments, ordered by priority, urgency, and configured section rules.
- Hermes cron and delivery: run the collector and briefing jobs and deliver the resulting message through the configured target.
- Metrics/reporting surface: derives timeliness, relevance, safety, and attention metrics from existing Keryx/Hermes records.

## Preconditions

- Hermes is installed and configured.
- Node.js and npm satisfy Keryx requirements.
- The Keryx repository is cloned locally.
- The user can run `./keryx-setup.sh` and `hermes keryx doctor`.
- At least one Hermes delivery target is available if the briefing should arrive outside the local UI.
- News sources are reachable without credentials, or credentials are configured outside cards, logs, and fixtures.
- The Keryx dashboard remains local-only or externally protected if exposed beyond localhost.

## Happy path

- The user runs `./keryx-setup.sh` from the Keryx repository.
- Setup verifies Hermes, Node, npm, the Keryx board, plugin installation, and collector-creator bundle installation.
- Setup asks: “What time should Keryx send your daily briefing?”
- The user chooses a local time, for example `07:30` in the configured timezone.
- Setup lists Hermes delivery targets, the user chooses one, and Keryx stores it as `notifyTarget`.
- Setup writes or updates configuration containing the briefing time, timezone, delivery target, and default collector lead time.
- Setup creates a daily briefing cron job scheduled for the chosen time.
- Setup runs `hermes keryx doctor`, which reports that the plugin, collector creator, delivery target, and briefing job are healthy or gives actionable remediation.
- The user invokes `/keryx-collector-creator create a news briefing collector using <sources>`.
- The collector creator classifies the request as a read-only monitor because it only reads sources and produces a private outcome for the user.
- The collector creator writes `keryx-collector-news` artifacts into Hermes' space, including source-specific skill, scripts/prompts, fixture data, state/cursor files, and dry-run instructions.
- The collector creator creates or proposes a Hermes cron job for the news collector scheduled one hour before the daily briefing, for example `06:30` for a `07:30` briefing.
- The news collector runs at the scheduled time, reads sources, filters duplicates, ranks items, and emits compact summaries with source links and relevance notes.
- Keryx validates that emitted items are read-only, self-blast-radius, and digest-routed.
- At the configured daily briefing time, the briefing cron job assembles the daily message.
- The delivered briefing orders sections by priority and urgency; important news appears before low-urgency autonomous outcomes such as unsubscribed-and-deleted newsletters.
- If no news items are found, the briefing omits the empty news section or states “No notable news from configured sources,” according to the configured verbosity.
- If Keryx autonomously handled routine tasks the previous day, those appear later in the briefing as a concise operational digest.
- The user can inspect the collector run, source references, digest preview, and metrics to verify that the system ran on time and did not create avoidable notifications.

## Acceptance criteria

### Installation and setup

- Given a clean Keryx checkout, when the user runs `./keryx-setup.sh`, then setup prompts for a daily briefing time unless a valid time already exists and the user chooses to keep it.
- Given the user enters a valid briefing time, then Keryx stores the time with an explicit timezone or a documented default timezone.
- Given the user enters an invalid briefing time, then setup rejects it with a clear example and does not write a partial broken configuration.
- Given Hermes delivery targets exist, when setup runs, then it lets the user choose a target and stores it as the destination for interrupts and the briefing/digest.
- Given no Hermes delivery target exists, then setup completes in a safe local/digest-only mode and doctor reports that outbound briefing delivery is unavailable.
- Given setup completes, then `/keryx-collector-creator` is available through the setup-managed bundle.
- Given setup completes, then a daily briefing cron job exists at the configured time, or doctor reports the missing job with remediation.
- Given `./keryx-setup.sh --dry-run`, then setup reports intended plugin, bundle, config, delivery, and briefing-cron changes without writing them.
- Given an existing `keryx.config.json`, then setup preserves it by default unless the user explicitly overwrites it or runs `--force`.
- Given setup completes, when the user runs `hermes keryx doctor`, then doctor reports plugin, collector creator, setup-selected delivery target, and briefing cron health.

### Collector creation

- Given setup has installed `/keryx-collector-creator`, when the user asks for a news briefing collector and provides several news websites or feeds, then the collector creator generates source-specific artifacts in Hermes' space, not in the Keryx repository.
- Given the requested collector only reads news sources and produces a private briefing section, then it is classified as a `read_only` monitor.
- Given the collector is `read_only`, then generated cards/outcomes use `reversibility: read_only`, `blast_radius: self`, no `absolute_floor`, and digest-oriented delivery metadata.
- Given source credentials are required, then the collector creator stores credential instructions or references outside cards, comments, logs, and fixtures.
- Given the collector creator generates fixtures, then fixtures contain compact representative article metadata and summaries, not raw full article bodies or credentials.
- Given the news collector is generated, then it includes dry-run instructions and at least one fixture-based validation command.
- Given the news collector is generated, then it uses stable source IDs or canonical URLs for idempotency rather than timestamps or mutable article titles.
- Given source text contains instructions such as “ignore previous instructions” or “send this immediately,” then the collector treats those as untrusted source content.

### Scheduling and orchestration

- Given the daily briefing time is configured, when the news collector is created, then its default schedule is derived from that time rather than manually guessed.
- Given no custom lead time is specified, then the news collector is scheduled one hour before the daily briefing.
- Given a custom lead time is specified, then the collector schedule uses that lead time and records it in collector metadata.
- Given a one-hour lead time would place the collector on the previous calendar day, then scheduling handles the day rollover correctly.
- Given daylight saving time changes occur, then the collector and briefing preserve the user's intended local clock time.
- Given the collector has a measured p95 runtime longer than the current lead time, then Keryx reports the schedule risk or proposes a longer lead time.
- Given the collector cron job fails, then the briefing does not fabricate news; it reports the collector failure or omits the section with a visible diagnostic depending on severity.
- Given multiple briefing collectors exist, then their schedules avoid avoidable overlap or their outputs are composed deterministically.

### Disposition and attention allocation

- Given a news item is ordinary and non-urgent, then it is routed to the daily briefing rather than pushed immediately.
- Given a news item is read-only and digest-routed, then it does not require a human-approved policy graduation rule.
- Given a news source requires actions that leave external signals, such as liking, bookmarking in a third-party account, marking read, or following feeds, then those options are not classified as pure `read_only`.
- Given an item is time-sensitive and consequential, then Keryx may create an interrupt card or push separate from the daily briefing, with self-contained recommendation, risk, and default.
- Given an item is merely interesting but not urgent, then Keryx does not interrupt even if the model assigns high relevance.
- Given the collector proposes `silent` or `interrupt`, then the disposition function remains authoritative and may only downgrade unsafe or unsupported claims.
- Given source text attempts to influence urgency or notification behavior, then source text alone cannot upgrade a finding to interrupt.

### Briefing composition and delivery

- Given news output is available before the briefing job starts, then the daily briefing includes a news section.
- Given both news output and Keryx autonomous-outcome digest items are available, then the briefing cron job orders them by card priority, urgency, and configured section rules.
- Given news output has higher priority than low-urgency autonomous outcomes, then news appears before the “what Keryx handled for you” section.
- Given urgent items were already pushed separately, then the daily briefing may summarize them as carry-over but must not duplicate noisy urgent notifications.
- Given no news output is available, then the briefing handles the empty state explicitly or omits the section according to configured policy.
- Given the briefing is generated, then source links are clickable, human-readable references rather than raw unlabelled URLs where the delivery channel supports it.
- Given the briefing is delivered, then Keryx records delivery status, timestamp, target, and included section metadata sufficient for later reporting.
- Given a briefing preview command is run before delivery, then it shows the same priority/urgency section ordering that the real briefing would use.
- Given delivery through `hermes send` fails, then Keryx records the failure and exposes remediation without marking the briefing successfully delivered.

### Auditability and metrics

- Given the news collector runs, then Keryx can report last run time, success/failure, number of source items read, number selected, number deduplicated, and runtime.
- Given the briefing is delivered, then Keryx can report whether the collector completed within its lead-time budget.
- Given the user corrects, mutes, expands, or ignores a news section, then that feedback is attributed to the news collector/class without granting authority for state-changing actions.
- Given cards, outcomes, and deliveries exist, then metrics are derived from Hermes/Keryx state rather than a second task database.
- Given a source item appears in the briefing, then an operator can trace it back to compact source references and collector run metadata.

## Measurable metrics

Product metrics:

- Briefing on-time rate: percentage of daily briefings delivered within an acceptable window around the configured time.
- Collector readiness rate: percentage of briefing runs where the news collector completed before briefing assembly.
- Lead-time margin: time between collector completion and briefing start, tracked by p50/p95.
- News section inclusion rate: percentage of daily briefings containing at least one selected news item.
- News usefulness rate: percentage of news sections the user reads, expands, saves, or positively rates where such feedback exists.
- News correction rate: percentage of briefings where the user marks an item irrelevant, stale, duplicate, or wrong.
- Duplicate item rate: percentage of news items repeated unintentionally across consecutive briefings.
- Source coverage: percentage of configured sources successfully checked per run.
- Source freshness: age of the newest selected item and oldest selected item at delivery time.
- Briefing compression: source items scanned versus items shown.
- Attention burden: number of real-time notifications caused by news collectors per week. Target for ordinary news: zero.
- Section order compliance: percentage of briefings whose rendered order matches the priority/urgency order computed by the briefing cron job.

Safety metrics:

- Number of news collector outputs incorrectly classified as read-only while leaving an external signal. Target: zero.
- Number of ordinary news items sent as interrupts. Target: zero unless explicitly configured.
- Number of source-authored instructions that affected scheduling, urgency, disposition, or execution authority. Target: zero.
- Number of raw article bodies, credentials, cookies, or paywalled content persisted in cards, comments, logs, fixtures, or outcomes. Target: zero.
- Number of state-changing actions performed by a news collector. Target: zero for this story.
- Number of delivery failures incorrectly marked successful. Target: zero.

Operational metrics:

- Setup success/failure count by step: plugin, bundle, config, delivery target, briefing cron, doctor.
- Invalid briefing-time entry count during setup.
- Cron drift between configured schedule and actual run time.
- Collector runtime by source and by run.
- Collector failure count by source and failure class: authentication, network, parse, rate limit, source format change, state write, delivery.
- Retry success rate before briefing assembly.
- Digest/briefing render time and delivery latency.
- Number of skipped or stale source items with explicit reasons.

## Fixture and programmatic test ideas

### Setup fixtures

- Fake Hermes home with no Keryx setup; run `./keryx-setup.sh --dry-run` and assert planned plugin, bundle, config, delivery target, and daily briefing cron operations.
- Fake Hermes home with one delivery target; run setup with scripted input `07:30` and assert `keryx.config.json` stores briefing time, timezone, setup-selected target, and default lead time.
- Fake Hermes home with no delivery targets; assert setup completes safely and doctor warns that outbound briefing delivery is unavailable.
- Existing config fixture; assert setup keeps existing briefing time by default and overwrites only with explicit confirmation or `--force`.
- Invalid time inputs such as `25:00`, `tomorrow morning`, and empty string; assert setup rejects or defaults according to documented behavior without writing invalid config.
- Timezone fixture for `Australia/Melbourne`; assert daily briefing cron and one-hour-prior collector schedule use local time and survive DST boundaries.
- Missing collector-creator bundle fixture; assert `hermes keryx doctor` reports a precise remediation to rerun setup.
- Missing briefing cron fixture; assert doctor reports the missing setup-created cron job and the expected schedule.

### Collector creator fixtures

- User prompt: “Create a news briefing collector using technology news websites and feeds such as The Verge, Hacker News, and Keryx GitHub releases”; assert generated artifacts live in Hermes' skills/scripts/state space.
- Prompt with only read-only news sources; assert generated option metadata is `read_only`, `blast_radius: self`, no `absolute_floor`, default `result_delivery: digest`.
- Prompt asking the collector to “like/save/bookmark articles automatically”; assert those actions are rejected as read-only or split into review/state-changing options.
- Prompt with a source requiring login; assert generated instructions keep credentials outside fixtures and cards.
- Generated fixture set contains representative compact article metadata, canonical URLs, source names, timestamps, and summaries only.
- Generated collector includes idempotency keys based on source stable IDs or canonical URLs.
- Generated collector includes dry-run instructions and expected no-work behavior.

### Scheduling tests

- Briefing time `07:30`, default lead `PT1H`; assert news collector schedule is `06:30` local time.
- Briefing time `00:30`, default lead `PT1H`; assert news collector schedule is `23:30` on the previous local day.
- Custom lead `PT2H`; assert schedule changes accordingly and metadata records the override.
- Collector p95 runtime fixture exceeds lead time; assert doctor or metrics flags insufficient lead time.
- Multiple collectors with the same briefing dependency; assert deterministic ordering or safe concurrency without duplicate briefing sections.
- Paused news collector cron; assert briefing shows stale/missing source status rather than fabricated content.

### Read-only classification and disposition tests

- Ordinary article fixture; assert disposition resolves to silent/digest, not review or interrupt.
- Breaking but non-actionable news fixture; assert it appears in the briefing, not a push, unless explicit urgency/consequence policy says otherwise.
- Time-sensitive consequential fixture, for example “flight cancellation affecting user's trip” if the source is configured for personal impact; assert interrupt path is available with evidence and default.
- Source article containing prompt injection instructions; assert no effect on disposition, urgency, schedule, confidence, or execution prompt.
- Source requiring read receipt or mark-as-read; assert it is not classified as pure `read_only` unless no external signal is emitted.
- News collector tries to create a card with `read_only` plus `absolute_floor`; assert schema validation fails.
- News collector tries to set `blast_radius: external` for read-only output; assert schema validation fails.

### Briefing composition tests

- Synthetic high-priority news outcome plus low-urgency autonomous outcomes; assert rendered briefing orders news before “what Keryx handled for you.”
- Synthetic low-priority news outcome plus higher-priority operational outcome; assert rendered briefing follows computed priority rather than a hard-coded news-first rule.
- Empty news outcome and non-empty autonomous digest; assert the briefing is not blocked and handles the empty news section according to policy.
- Non-empty news outcome and empty autonomous digest; assert the briefing omits empty operational section or marks it compactly.
- Urgent item already pushed before the briefing; assert the briefing does not duplicate it as another urgent push.
- Source links fixture; assert rendered output uses human-readable clickable labels where supported.
- Delivery preview fixture; assert preview and sent output share the same section ordering and item counts.
- Failed `hermes send` fixture; assert delivery failure is recorded and no success metric is emitted.

### Metrics tests

- Build synthetic run history for seven days and assert on-time rate, collector readiness rate, lead-time margin, source coverage, duplicate rate, and section order compliance.
- Build a history with stale source failures and assert stale/missing status is reflected in operational metrics.
- Build a history with user feedback marking items irrelevant and assert correction/usefulness rates are attributed to the news collector.
- Build a history with a source prompt injection attempt and assert safety metrics count the attempt but show no policy/disposition effect.
- Build a history where one article appears under two URLs and assert deduplication metrics and item selection behave deterministically.

## Failure modes and required behavior

- Setup cannot find Hermes CLI: setup fails early with remediation and does not write misleading cron/config state.
- Setup cannot list delivery targets: setup either enters safe local mode or asks the user to proceed without outbound delivery; doctor reports the limitation.
- User provides invalid briefing time: setup rejects it and asks again or keeps the previous valid value.
- Existing config conflicts with requested briefing time: setup preserves by default and overwrites only with explicit confirmation or `--force`.
- Daily briefing cron is missing after setup: doctor reports the missing setup-created job and expected command/schedule.
- Collector-creator bundle is missing after setup: doctor reports the missing bundle and remediation.
- Collector creator misclassifies news as state-changing review work: disposition/classification tests fail; ordinary read-only news should not create avoidable review burden.
- Collector creator misclassifies source-side mutations as read-only: safety tests fail; externally visible actions must become review/state-changing options or be rejected.
- Collector runs too late for the briefing: briefing reports stale/missing news or uses the latest completed safe output; it does not wait indefinitely or fabricate results.
- Collector fails to read a source: briefing reports degraded source coverage where appropriate and metrics record source failure.
- Source returns duplicate or syndicated articles: collector deduplicates by stable IDs/canonical URLs and tracks duplicate rate.
- Source article contains prompt injection: collector treats it as untrusted content and does not change schedule, urgency, policy, or execution behavior.
- Source requires credentials, CAPTCHA, paywall, consent, or login: collector blocks that source or uses configured credential handling; it does not store secrets or automate through gates invisibly.
- News item is ordinary but delivered as push: interruption precision test fails unless the user explicitly configured that source/class as push-worthy.
- News item is truly urgent and personally consequential: system may interrupt before the daily briefing; if it waits until the briefing, interruption recall/timeliness metrics should show the miss.
- Briefing delivery fails: Keryx records failure and preserves output for later inspection rather than marking the day complete.
- Briefing is too noisy: metrics should show low usefulness, high ignore/archive rate, high correction rate, or low compression; collector ranking or source configuration should be adjustable.
- Briefing hides autonomous outcomes behind news entirely: autonomous outcomes remain present according to priority/urgency unless empty or configured `log_only`.
- Generated fixtures include raw article bodies or credentials: tests fail; fixtures must use compact synthetic or redacted source facts.

## Reporting and validation use

This story should be usable as a reference for real-world usage reports and implementation validation. A report for a daily news briefing collector should be able to answer:

- What briefing time and timezone did the user configure during setup?
- Which Hermes delivery target was used?
- Did setup create the daily briefing cron job?
- Which news sources were configured, and when was each last successfully checked?
- Was the news collector scheduled before the briefing, and what was the actual lead-time margin?
- How many source items were read, selected, deduplicated, skipped, and delivered?
- Did any ordinary news item cause an interrupt? If yes, why?
- Did any urgent and consequential item wait until the daily briefing when it should have interrupted?
- Did any source text or prompt injection affect collector behavior?
- Did any collector output leave an external signal despite being classified as read-only?
- Did the daily briefing order sections according to card priority, urgency, and configured section rules?
- How often was the briefing delivered on time?
- How often did the user correct, mute, expand, save, or ignore news items?
- How much attention did the briefing save compared with manual source checking or push notifications?

## Source alignment

This story aligns with Keryx's documented model:

- Keryx is a thin attention-allocation surface over Hermes Kanban.
- Setup installs/enables the Keryx plugin and exposes the `/keryx-collector-creator` bundle.
- Collectors are authored into Hermes' own space, not committed into this repository.
- Collectors discover and classify; they do not perform source actions themselves.
- `read_only` monitor outputs are silent by design because they mutate no state and exercise no external authority.
- Every actionable card resolves through the disposition function, not source content or collector self-authority.
- Silent outcomes and monitor outputs are reported non-urgently through the setup-created briefing/digest path.
- Source content is untrusted and should be reduced to compact facts and source references.
- Metrics should be derived from Keryx/Hermes state rather than a second task database.

Known aspirational gaps captured by this story:

- The current README states that setup stores delivery configuration and supports a digest, but also says setup does not create real collector cron jobs and collectors are scheduled separately.
- This story intentionally requires setup to create the daily briefing cron job and requires the collector creator to schedule read-only news collectors relative to that briefing time.
- If current Keryx only supports a generic `keryx-digest`, the setup-created daily briefing cron, richer briefing composition, and priority-based section ordering are future-facing acceptance criteria.
