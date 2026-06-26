# Human attention as the bottleneck for AI personal assistants

## Executive summary

- The central constraint for high-value AI personal assistants is no longer only task execution. It is **selective escalation**: knowing when to act, when to wait, when to summarize, when to ask, and how to ask without making the human the integration layer.
- Software engineering makes this visible because tests and CI can absorb much of the verification burden. Personal life lacks a single objective test suite. The analogue is not “all actions must be approved”; it is a layered policy of reversibility, consequence, social/financial/legal risk, user preference uncertainty, and attention cost.
- The best current research framing is **Value of Information**: ask only when the expected improvement in the downstream decision exceeds the cognitive/interruption cost imposed on the user. This formalizes the intuitive rule “interrupt me only when necessary.”
- Existing agent benchmarks have historically rewarded confident autonomy on complete instructions. Newer work on human-in-the-loop benchmarks shows a “judgment gap”: agents often have the mechanism to ask but fail to ask at the right time, ask too broadly, or proceed despite uncertainty.
- Practical user reports converge on the same pattern: narrow, integrated, end-to-end agents are useful; fully autonomous agents that send emails, spend money, or make commitments without approval are fragile; dashboard/polling workflows recreate the attention bottleneck.
- A personal assistant should be designed as an **attention allocation system**, not a chatbot. Its core product quality is interruption precision: high recall for genuinely consequential moments, low false-positive burden, and strong ability to complete safe/reversible work silently.

## 1. Core thesis

An AI personal assistant becomes valuable when it can absorb work **without becoming another thing to manage**. The bottleneck is not simply whether the assistant can do more tasks. It is whether it can correctly allocate scarce human attention across ambiguous, changing, socially embedded real-world situations.

The software-development talk that motivated this document makes the pattern explicit: coding agents can run in parallel, loop until verification criteria are met, and use tools to check their own work, but the human still supplies judgment, taste, prioritization, and final confidence that the work satisfies real human or business needs. The speaker summarizes the shift as: “the agents are not the bottleneck now … but we are,” because “our attention … still degrades under load” ([S1](#sources)).

For personal assistants, the same phenomenon is more acute because the real world rarely supplies crisp tests. An email, invitation, bill, family plan, health reminder, purchase decision, or awkward social message may not have a provably correct action. The assistant must operate under incomplete information and social risk. The question becomes:

> How should an assistant minimize unnecessary interruptions while still preserving human agency, safety, relationships, and judgment?

That question is old in human-computer interaction and new again in LLM agents. Older terms include **mixed-initiative interaction**, **adjustable autonomy**, **supervisory control**, and **attention-aware interfaces**. Newer terms include **selective escalation**, **human-in-the-loop agents**, **permission design**, and **Value of Information**.

## 2. Why personal assistants are harder than software agents

Software agents benefit from explicit artifacts:

- issue descriptions;
- code diffs;
- tests;
- linters;
- build logs;
- CI status;
- reproducible environments;
- relatively clear rollback paths.

These do not eliminate ambiguity, but they give agents external checks. The video example uses this pattern: the agent fixed a bug, used Slack and Linear context, triggered the product workflow, and verified the outcome before returning control ([S1](#sources)).

Personal-life tasks are messier:

- The “right” response to an email may depend on unstated relationship history.
- The cost of an error may be social rather than technical.
- Preferences are often latent, unstable, or context-dependent.
- Some actions are reversible technically but not socially: sending a message can be followed up, but not unsent in the human sense.
- Some tasks are low-stakes individually but corrosive in aggregate if they interrupt too often.
- Success may mean “David never had to think about it,” which is hard to observe directly.

This means a personal assistant needs more than task competence. It needs a calibrated model of:

1. **Ambiguity** — what is unknown, and whether it can be inferred or retrieved.
2. **Consequence** — what happens if the assistant is wrong.
3. **Reversibility** — whether a mistaken action can be undone cheaply.
4. **Externality** — whether the action affects another person, account, system, or public record.
5. **Attention cost** — what interruption burden the question imposes.
6. **Timing** — whether asking now is useful, harmful, or unnecessary.
7. **Legibility** — whether the human can understand what the assistant did and why.

## 3. The research frame: ask only when information is worth the attention

The strongest current formal framing is **Value of Information**. Dong et al. define the dilemma directly: real-world user requests are underspecified, but agents must choose between acting on incomplete information and interrupting for clarification. Their framework asks whether the expected utility gain from asking exceeds the communication cost. They identify three key factors: query ambiguity, task risk, and cognitive load ([S2](#sources)).

This maps well to personal assistants:

```text
Ask if:
  expected benefit of the answer
  > cost of interrupting the user
  + cost of delaying the task

Do not ask if:
  the agent can safely infer, retrieve, defer, draft, batch, or take a reversible action.
```

A personal assistant should therefore treat user attention as a limited budget. The assistant’s job is not to avoid all interruptions. It is to spend interruptions where they have positive expected value.

### Practical rule

An interruption is justified when all three conditions hold:

1. **The decision cannot be resolved by available context, policy, or safe default.**
2. **A wrong action has meaningful cost: social, financial, legal, health, privacy, opportunity, or future attention cost.**
3. **The user’s answer will materially change the assistant’s next action.**

If the answer will not change the next action, the question is not clarification; it is anxiety transfer.

## 4. Older foundations: mixed initiative and adjustable autonomy

The core problem predates LLMs. Horvitz’s mixed-initiative computing work argues that systems need to decide when to engage users, when to contribute, when to return control, and when to query for more information. It explicitly includes both expected benefit and the cost of distracting the user, and stresses that user attention is part of the decision ([S3](#sources)).

Parasuraman, Sheridan, and Wickens provide a useful taxonomy: automation can support four stages — information acquisition, information analysis, decision/action selection, and action implementation — at different levels of autonomy. They warn that automation does not merely replace human work; it changes human activity and imposes new coordination demands ([S4](#sources)).

Adjustable-autonomy research reached similar conclusions in deployed personal-assistant-like systems. The Electric Elves / Friday agents could reschedule meetings, select presenters, track locations, and organize meals. The key issue was when to consult the human and when to act autonomously; more autonomy saved time, but uncertainty about user state and preferences could produce costly mistakes ([S5](#sources)). Scerri et al. formalized this as “transfer-of-control strategies”: conditional sequences for moving decision authority between agent and human while accounting for the cost of delay and miscoordination ([S6](#sources)).

The lesson for modern AI personal assistants: autonomy should not be a binary permission. It should be a dynamic transfer-of-control policy.

## 5. The current agent evidence: models do not yet ask well

Newer agent benchmarks show that “having an ask tool” is not enough.

HiL-Bench argues that the bottleneck is judgment: knowing when to act autonomously and when to ask for help. In its setup, agents receive tasks with hidden blockers — missing, ambiguous, or contradictory information that surfaces through exploration. The benchmark measures **Ask-F1**, balancing blocker recall against question precision so agents cannot win by asking too many questions. The authors report that agents perform well with complete information but collapse when they must decide whether to ask; failure modes include confident wrong beliefs, recognizing uncertainty but proceeding anyway, and broad/imprecise escalation ([S7](#sources)).

“Ask or Assume?” studies underspecified coding tasks and finds that uncertainty-aware scaffolds can improve performance. A multi-agent scaffold separating intent monitoring from execution achieved a 69.40% resolve rate and better-calibrated information-seeking than standard autonomous execution ([S8](#sources)). This suggests that asking well is partly an architecture/scaffold problem, not just a model-size problem.

A CHI 2026 paper on multi-step agent confirmation finds that confirm-at-end workflows are brittle because early errors cascade, while confirm-every-step is tedious. Its intermediate confirmation strategy was preferred by 81% of participants and reduced task completion time by 13.54% versus confirm-at-end in the study ([S9](#sources)).

For personal assistants, this implies:

- End-of-day summaries are useful but insufficient for actions where early correction matters.
- Step-by-step approval is safe but often worse than doing it manually.
- The design target is **strategic checkpoints**.

## 6. Human attention is costly, even when tasks still get done

Interruption research supports treating attention as a scarce resource. Mark, Gudith, and Klocke found that interrupted workers sometimes completed tasks faster without quality loss, but at the cost of higher stress, frustration, time pressure, and effort ([S10](#sources)). This matters because assistants can accidentally optimize visible throughput while degrading the user’s day.

The video’s “burnout turbo” warning is the same phenomenon in agent form: if agents increase the number of parallel threads requiring human supervision, they may increase output while exhausting the supervisor ([S1](#sources)). A personal assistant that asks frequent small questions may look helpful in logs while silently damaging focus.

Therefore, assistant performance should include subjective and cognitive-load metrics, not only task completion.

## 7. Practitioner and user-report patterns

Anecdotal reports are weaker evidence than papers, but they are useful for product pattern discovery.

Recurring pattern: **narrow, integrated, end-to-end beats general, chatty, or dashboard-based**.

Examples from user/practitioner reports:

- Email triage builders report that reactive assistants leave the user as the bottleneck; proactive inbox monitors that classify, label, archive low-priority items, and send compact summaries reduce direct inbox checking. But they often avoid autonomous replies because “that’s how you send something stupid” ([S11](#sources)).
- A personal-assistant builder using n8n emphasizes that human-in-the-loop approval is critical: the system surfaces information and creates todos, but does not send or take consequential actions without approval ([S12](#sources)).
- Reddit discussions repeatedly converge on permission design: no approval for summarizing/searching/drafting/classifying; approval before state changes; strict approval for external sends, purchases, payments, deletion, deployments, permission changes, or customer contact. These are anecdotal but consistent with formal HITL guidance ([S13](#sources)).
- A practitioner account of long-running agents argues for “stop polling the agent; make it interrupt me” — i.e. the assistant should initiate contact only when blocked or finished, rather than forcing the human to monitor dashboards ([S14](#sources)).

These reports suggest that personal-assistant UX should be built around:

- background monitoring;
- silent safe action;
- precise escalation;
- batch review;
- one-click approval;
- auditability;
- avoidance of polling dashboards.

## 8. Permission design: necessary interruption is not just uncertainty

Sometimes the assistant should ask even when it is confident. The reason is not ambiguity; it is authority.

OpenAI’s Operator safety design includes takeover mode for sensitive inputs, user confirmations before significant actions such as submitting an order or sending an email, task limitations for sensitive/high-stakes decisions, and watch mode on email or financial sites ([S15](#sources)). Anthropic’s computer-use documentation similarly emphasizes sandboxing, user consent, and confirmation when prompt-injection classifiers detect risk; external summaries of Anthropic guidance also stress minimal privileges and human confirmation for meaningful real-world consequences ([S16](#sources)).

For a personal assistant, approval gates should be triggered by at least these factors:

| Factor | Why it matters | Example |
|---|---|---|
| Irreversibility | Cannot be cheaply undone | deleting data, sending email, cancelling service |
| External commitment | Affects another person or institution | agreeing to attend, making promise, contacting vendor |
| Money | Financial loss or fraud risk | purchase, transfer, subscription change |
| Legal/medical/tax/regulated domain | Professional judgment required | health advice, tax filing, legal response |
| Privacy/security | Sensitive data exposure | forwarding document, logging into account |
| Identity/taste/values | Preserves user agency | dating/social reply, gift choice, apology |
| High blast radius | One error affects many downstream systems | mass email, shared calendar change, bulk archive |
| Novelty | No known policy/default | first-time sender, unusual request |
| Low confidence + high consequence | Classic clarification case | ambiguous invitation, vague invoice |

The user should not need to approve every action. The user should approve authority transfers.

## 9. A working model: the assistant as an attention allocation system

A personal assistant should maintain four queues, not one inbox:

1. **Do silently** — safe, reversible, policy-covered tasks.
2. **Prepare for review** — draft, gather evidence, propose options, but do not commit.
3. **Batch later** — low urgency, low consequence, user preference useful but not urgent.
4. **Interrupt now** — urgent and consequential, or blocked in a way where delay/wrong action is costly.

### 9.1 The clarify-or-commit loop

For every candidate action:

```text
1. Define the next action precisely.
2. Classify action type:
   observe / summarize / draft / modify / commit / spend / disclose / contact.
3. Estimate consequence if wrong.
4. Estimate reversibility.
5. Estimate confidence and source quality.
6. Estimate urgency and cost of delay.
7. Estimate user attention cost now vs later.
8. Choose one:
   - act silently;
   - act reversibly and log;
   - draft and queue;
   - ask one precise question;
   - interrupt now with recommendation;
   - refuse/defer to professional/human judgment.
```

### 9.2 Interruption format

A good interruption is not “What should I do?” It is:

```text
Recommended action: X.
Why: Y.
Risk if wrong: Z.
Default if you do not reply by [time]: D.
Reply options: approve / change / hold.
```

This reduces the user’s cognitive burden. It preserves agency while preventing the assistant from outsourcing all judgment back to the user.

### 9.3 Default behaviors by action class

| Action class | Default autonomy | Human involvement |
|---|---:|---|
| Read, search, summarize | High | No interruption unless findings are urgent/consequential |
| Classify/label/prioritize | High | Periodic audit; user can correct policy |
| Draft message/document | High | Queue for review if external or identity-bearing |
| Create private reminder/task | Medium-high | Silent if policy-covered; batch if ambiguous |
| Modify private notes/files | Medium | Ask if persistent, destructive, or user-authored content changes meaning |
| Calendar changes | Medium | Silent for holds; ask for commitments/invites/cancellations unless policy exists |
| Send external message | Low | Approval unless trivial and explicitly delegated by policy |
| Purchases/payments | Low | Approval above explicit thresholds; stronger gates for new vendors |
| Legal/medical/tax/financial advice | Low | Research/summarize only; human/professional judgment required |
| Social/relationship judgment | Low-medium | Draft/options/critique; avoid impersonating values or intimacy |

## 10. Design patterns for low-interruption assistants

### 10.1 Shadow mode before autonomy

Run the assistant in observe/propose mode first. Compare its proposed actions to human actions. Promote only stable categories to silent execution.

### 10.2 Reversible-first action

Prefer reversible progress over interruption:

- save a draft instead of sending;
- put a tentative hold instead of confirming attendance;
- label instead of archive/delete;
- collect options instead of purchasing;
- prepare an evidence pack instead of asking open-endedly.

### 10.3 Evidence packs

When asking for approval, include the evidence needed to decide in seconds: sender, context, prior thread, calendar conflict, deadline, money amount, default policy, and likely consequence.

### 10.4 Batching

Batch low-urgency decisions into digest form. Do not use the user’s real-time attention for decisions that can wait.

### 10.5 Escalation ladders

Use tiers:

1. Log only.
2. Daily/weekly summary.
3. Async review queue.
4. Push notification.
5. Immediate interrupt.
6. Stop and wait.

### 10.6 Expiring defaults

For time-sensitive decisions, specify what happens if the user does not respond. This prevents “assistant stuck for 119 minutes awaiting 15 seconds of input” ([S14](#sources)).

### 10.7 Policy learning from corrections

Every correction should update a policy candidate:

- “Always do this silently.”
- “Never do this without asking.”
- “Ask only above threshold.”
- “Batch these weekly.”
- “This sender/topic is high priority.”

But learned policies should remain inspectable and revocable.

### 10.8 Separate judgment from execution

Use one component to execute and another to monitor ambiguity/risk. “Ask or Assume?” suggests that separating intent monitoring from code execution improves clarification behavior in software agents ([S8](#sources)). The same architecture likely transfers to personal assistants: one agent does the work; another asks, “Should this be escalated?”

## 11. Metrics for improving an AI personal assistant

Traditional productivity metrics are insufficient. A personal assistant should be evaluated on attention economics.

| Metric | Definition | Why it matters |
|---|---|---|
| Autonomous safe completion rate | % tasks completed without interruption and without correction | Measures real offload |
| Interruption precision | % interruptions the user agrees were necessary | Penalizes false alarms |
| Interruption recall | % consequential situations surfaced in time | Penalizes missed risks |
| Ask-F1 | Harmonic mean of question precision and blocker recall | Borrowed from HiL-Bench logic; balances over-asking and under-asking |
| Approval latency | Time from assistant request to user decision | Measures friction and timing quality |
| Escalation regret | Cases where the assistant asked but should have acted, or acted but should have asked | Direct policy-improvement signal |
| Recovery cost | User effort to fix assistant mistake | Better than binary success/failure |
| Attention burden | Interruptions per day/week by urgency tier | Prevents notification creep |
| Batch compression | Number of raw items converted into one useful review | Measures inbox/noise reduction |
| Policy coverage | % recurring decisions covered by explicit/default policy | Tracks maturity |
| User override rate | Frequency of changed recommendations | Detects miscalibration |
| Silent failure count | Important things missed without surfacing | Highest-severity failure mode |
| Trust calibration | User neither over-trusts nor underuses assistant | Prevents automation misuse/disuse |

## 12. Failure modes

### 12.1 Silent confident wrongness

The assistant infers missing context and acts. This is the failure HiL-Bench highlights: agents may fill gaps rather than detect that the gap requires human context ([S7](#sources)).

### 12.2 Question spam

The assistant preserves safety by asking too much. This collapses into manual work and trains the user to ignore it.

### 12.3 Broad escalation

“Do you want me to handle this?” is often worse than a proposed action. Good escalation is targeted and decision-relevant.

### 12.4 Confirm-at-end brittleness

For long tasks, late review may discover an early wrong assumption after the cost has compounded. Intermediate checkpoints can outperform both confirm-every-step and confirm-at-end ([S9](#sources)).

### 12.5 Over-gating

If every persistent action needs approval, the assistant becomes a clerk that still requires management.

### 12.6 Under-gating

If external, irreversible, or identity-bearing actions proceed silently, the assistant becomes a liability.

### 12.7 Dashboard/polling burden

If the user must remember to check agent status, the assistant has not removed the bottleneck; it has hidden it.

### 12.8 Out-of-the-loop supervision

High automation can reduce routine workload but degrade situation awareness and failure handling. Automation literature has long warned that automation changes the human role and can impose coordination demands ([S4](#sources)).

### 12.9 Preference overfitting

The assistant mistakes past behavior for stable preference. Personal-life preferences are contextual and can be aspirational, not just historical.

### 12.10 Agency erosion

The assistant may remove productive friction: learning, taste formation, relationship judgment, and self-understanding. For these domains, the assistant should more often tutor, draft, critique, or surface options rather than decide.

## 13. What “only interrupt when necessary” should mean

A useful operational definition:

> Interrupt when the expected cost of not interrupting exceeds the expected cost of interrupting, after accounting for reversibility, urgency, confidence, policy coverage, and the user’s current attention state.

This definition avoids two traps:

- **Safety absolutism**: asking for everything.
- **Automation maximalism**: acting whenever technically possible.

“Necessary” does not mean “the assistant is uncertain.” It means the user’s attention has positive expected value.

## 14. Generic roadmap for building toward this

### Phase 1 — Observe and classify

- Monitor channels.
- Summarize and label.
- Do no external actions.
- Capture what would have been escalated.
- Measure false positives/false negatives.

### Phase 2 — Draft and queue

- Draft replies, calendar proposals, task updates, and purchase options.
- Provide evidence packs.
- Require approval for all external commitments.
- Learn from edits.

### Phase 3 — Silent reversible actions

- Archive/label low-value items where reversible.
- Create private reminders/tasks under policy.
- Place tentative holds.
- Batch non-urgent decisions.

### Phase 4 — Policy-based autonomy

- Promote repeated patterns to explicit policies.
- Add thresholds and exception lists.
- Keep audit logs.
- Use periodic policy review.

### Phase 5 — Strategic interruption

- Model urgency, consequence, and attention cost.
- Interrupt only with precise recommendation and default.
- Escalate via tiers.
- Track interruption precision/recall.

### Phase 6 — Self-improving assistant harness

- Analyze corrections and escalations.
- Identify missing tools, policies, memories, or workflows.
- Propose improvements.
- Keep persistence-layer changes human-approved.

## 15. Open research questions

1. **How should assistants estimate the subjective cost of interruption?** Time of day, user state, task context, sleep, stress, and device all matter.
2. **How can assistants know when a preference is stable enough for autonomy?** Frequency alone is insufficient.
3. **What is the right equivalent of tests for personal life?** Audit logs, user regret, correction rate, social outcomes, and delayed feedback may need to substitute.
4. **How can assistants detect social consequence?** A technically reversible action may be socially irreversible.
5. **How should multiple assistants coordinate?** Without coordination, each agent may make locally reasonable interruptions that globally overload the user.
6. **What is the right UI for permission policy?** Users need legibility without being forced to configure a rules engine.
7. **How should assistants handle user silence?** Silence may mean consent, unavailability, overload, or avoidance; defaulting incorrectly is dangerous.
8. **Can selective escalation be trained generically?** HiL-Bench suggests judgment is trainable and may transfer across domains ([S7](#sources)), but personal-life domains are less benchmarked.
9. **How should assistant systems preserve human agency?** Particularly in taste, identity, learning, relationships, health, money, and values.

## 16. Baseline design doctrine

A generic AI personal assistant should follow these principles:

1. **Attention is the scarce resource.** Treat every interruption as a cost.
2. **Autonomy is granular.** Separate reading, analysis, recommendation, modification, external commitment, and spending.
3. **Ask only decision-changing questions.** If the answer will not alter the next action, do not ask.
4. **Prefer reversible progress.** Draft, queue, hold, label, gather, and summarize before interrupting.
5. **Escalate authority, not anxiety.** Ask when the assistant lacks authority or necessary context, not whenever it feels uncertain.
6. **Make interruptions self-contained.** Recommendation, evidence, risk, default, and compact response options.
7. **Batch by default.** Real-time attention is for urgency and consequence.
8. **Use external verification where possible.** Tests in software; audit trails, source evidence, confirmations, and reversible staging in life.
9. **Keep policy legible.** The user should know what the assistant may do silently, what requires approval, and what is logged.
10. **Learn from corrections.** Every avoidable future interruption should become a policy/tool/context improvement candidate.
11. **Preserve agency in human domains.** Do not silently outsource values, relationships, identity, taste, or learning.
12. **Measure interruption quality.** Optimize for interruption precision/recall, not just task count.

## Sources

### Primary / research sources

- **S1. YouTube video provided by user** — `https://www.youtube.com/watch?v=so9l_MwS2yg&t=1s`. Transcript fetched during this research. Key claims: agents scale; human attention degrades under load; signal layers, verification gates, remote control, and self-improving workflows reduce context switching; default path without intention is “burnout turbo.”
- **S2. Dong et al. (2026), “Value of Information: A Framework for Human–Agent Communication,” ACL 2026.** `https://aclanthology.org/2026.acl-long.1987/`. Decision-theoretic clarify-or-commit framing using ambiguity, task risk, and cognitive load.
- **S3. Eric Horvitz, “Uncertainty, Action, and Interaction: In Pursuit of Mixed-Initiative Computing.”** `http://erichorvitz.com/ftp/mixedin.pdf`. Expected-utility approach to when systems should act, ask, or defer, including user attention costs.
- **S4. Parasuraman, Sheridan & Wickens (2000), “A model for types and levels of human interaction with automation.”** PubMed abstract: `https://pubmed.ncbi.nlm.nih.gov/11760769/`. Four-stage automation taxonomy and warning that automation changes human activity and coordination demands.
- **S5. Electric Elves / Friday deployed assistant-agent reports.** Example: `https://people.ict.usc.edu/~pynadath/Papers/aimag02.pdf`; AAAI abstract: `https://aaai.org/papers/007-iaai01-007-iaai01/`. Real deployed office assistant agents; adjustable autonomy around meetings, presenters, locations, meals.
- **S6. Scerri, Pynadath & Tambe (2002), “Towards Adjustable Autonomy for the Real World,” JAIR.** `https://jair.org/index.php/jair/article/view/10312`. Transfer-of-control strategies, costs of delay/miscoordination, MDP-based adjustable autonomy.
- **S7. Elfeki et al. (2026), “HiL-Bench: Do Agents Know When to Ask for Help?”** `https://arxiv.org/html/2604.09408v2`; Scale summary: `https://scale.com/blog/hil`. Selective escalation, Ask-F1, hidden blockers, judgment gap.
- **S8. Edwards & Schuster (2026), “Ask or Assume? Uncertainty-Aware Clarification-Seeking in Coding Agents.”** `https://arxiv.org/html/2603.26233v2`. Underspecified SWE-bench variant; uncertainty-aware scaffolds; multi-agent monitor/executor separation.
- **S9. Zhou et al. (2026), “When Should Users Check? Modeling Confirmation Frequency in Multi-Step Agentic AI Tasks.”** `https://arxiv.org/html/2510.05307v3`. Intermediate confirmation scheduling; 81% participant preference; 13.54% completion-time reduction.
- **S10. Mark, Gudith & Klocke (2008), “The Cost of Interrupted Work: More Speed and Stress,” CHI 2008.** `https://interruptions.net/literature/Mark-CHI08.pdf`. Interrupted work may be completed faster but with higher stress/frustration/time pressure/effort.

### Product / safety sources

- **S11. Wyndo (2026), “Email Triage AI Agent: How I Automated Inbox Zero Without Losing Control.”** `https://aimaker.substack.com/p/build-ai-email-triage-agent-automation-make-tutorial`. Practitioner account: proactive inbox triage, summaries, no auto-replies without approval.
- **S12. Max Mitcham (2025), “How I Built an AI Personal Assistant That Actually Works.”** `https://maxmitcham.substack.com/p/how-i-built-an-ai-personal-assistant`. Practitioner account: inbox/scheduling assistant; human-in-the-loop critical for actions.
- **S13. Reddit / community reports on AI-agent permission design.** Example search result: `https://www.reddit.com/r/AI_Agents/top`; approval-action thread: `https://www.reddit.com/r/AI_Agents/comments/1u0qolu/how_are_you_actually_deciding_which_agent_actions`. Anecdotal evidence only; useful for recurring UX concerns.
- **S14. Tyler Folkman (2026), “Your AI Assistant Should Interrupt You.”** `https://tylerfolkman.substack.com/p/your-ai-assistant-should-interrupt`. Practitioner account: polling long-running agents creates hidden context-switching tax; agent should notify only when blocked/finished.
- **S15. OpenAI (2025), “Introducing Operator.”** `https://openai.com/index/introducing-operator`. Operator safety design: takeover mode, confirmations, task limitations, watch mode, prompt-injection monitoring.
- **S16. Anthropic Claude computer-use documentation.** `https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool`. Sandboxed computer-use tool, prompt-injection confirmation behavior, user consent. Secondary summary of safety guidance: `https://lapu.ai/computer-use-ai`.

## Confidence and limits

- **High confidence** in the broad thesis: attention/judgment/selective escalation is a central bottleneck for useful personal assistants. This is supported by old HCI theory, new agent benchmarks, safety/product designs, and practitioner reports.
- **Medium confidence** in specific design heuristics such as the action-class autonomy table. They are synthesized from evidence and product patterns, not validated in a single personal-assistant benchmark.
- **Low confidence** in quantitative transfer from software-agent studies to personal-life assistants. The research base is strongest for coding, web tasks, and controlled HCI studies; personal-life domains remain under-benchmarked.
- User reports from Reddit/Substack are treated as anecdotal pattern evidence, not proof.
