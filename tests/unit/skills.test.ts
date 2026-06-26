import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const categoryRoot = join(process.cwd(), 'skills', 'keryx');
const skillNames = ['keryx-worker', 'keryx-collector', 'keryx-collector-creator'] as const;

// v005 vocabulary: the bundled skills speak the action_item.v2 schema, the three-disposition
// model, and the silent/outcome/policy-proposal contract. These phrases must survive across
// the bundle as the load-bearing safety contracts.
const requiredCriticalPhrases = [
  'untrusted source content',
  'keryx.action_item.v2',
  'keryx.policy_decision.v1',
  'keryx.outcome.v1',
  'absolute_floor',
  'cursor safety',
];

describe('bundled Keryx skills', () => {
  it('ships the category description and three skill files only inside the repository', () => {
    expect(existsSync(join(categoryRoot, 'DESCRIPTION.md'))).toBe(true);

    for (const skillName of skillNames) {
      expect(existsSync(join(categoryRoot, skillName, 'SKILL.md'))).toBe(true);
    }
  });

  it('uses concise frontmatter with only name and description for individual skills', () => {
    for (const skillName of skillNames) {
      const { frontmatter } = parseSkill(join(categoryRoot, skillName, 'SKILL.md'));

      expect(Object.keys(frontmatter).sort()).toEqual(['description', 'name']);
      expect(frontmatter.name).toBe(skillName);
      expect(frontmatter.description).toContain('Use when');
      expect(frontmatter.description.length).toBeGreaterThan(80);
      expect(frontmatter.description.length).toBeLessThan(500);
    }
  });

  it('does not include extraneous documentation files in individual skill directories', () => {
    const forbiddenFileNames = new Set(['README.md', 'CHANGELOG.md', 'QUICK_REFERENCE.md', 'INSTALLATION_GUIDE.md']);

    for (const skillName of skillNames) {
      const entries = readdirSync(join(categoryRoot, skillName));
      const forbiddenEntries = entries.filter((entry) => forbiddenFileNames.has(entry));

      expect(forbiddenEntries).toEqual([]);
    }
  });

  it('preserves critical PRD safety contracts across the bundled skill text', () => {
    const bundledSkillText = [
      readFileSync(join(categoryRoot, 'DESCRIPTION.md'), 'utf8'),
      ...skillNames.map((skillName) => readFileSync(join(categoryRoot, skillName, 'SKILL.md'), 'utf8')),
    ].join('\n');

    for (const phrase of requiredCriticalPhrases) {
      expect(bundledSkillText).toContain(phrase);
    }
  });

  it('documents the silent path: a policy decision authorizes execution and an outcome is recorded', () => {
    const workerSkillText = readFileSync(join(categoryRoot, 'keryx-worker', 'SKILL.md'), 'utf8');

    // Task 5.x: the worker accepts a synthetic policy decision on the silent path, distinct
    // from a human execution decision on the review path.
    expect(workerSkillText).toContain('keryx.policy_decision.v1');
    expect(workerSkillText).toContain('keryx.execution_decision.v1');

    // The absolute floor never silences, and the worker re-checks it at execution time.
    expect(workerSkillText).toContain('absolute_floor');
    expect(workerSkillText).toContain('re-check the absolute floor');

    // read_only options are silent by design — they mutate nothing and emit no external signal.
    expect(workerSkillText).toContain('read_only');
    expect(workerSkillText).toContain('no state mutation and emits no external signal');

    // Silent execution must end in a structured outcome comment routed to the digest.
    expect(workerSkillText).toContain('keryx.outcome.v1');
    expect(workerSkillText).toContain('result_delivery');
    expect(workerSkillText).toContain('review log');
  });

  it('extends the worker silent path to graduated state-changing classes', () => {
    const workerSkillText = readFileSync(join(categoryRoot, 'keryx-worker', 'SKILL.md'), 'utf8');

    // Task 5.1: the worker accepts a policy_decision for non-floor state-changing
    // options whose axes match an `active` rule, beyond the read_only case.
    expect(workerSkillText).toContain('graduated state-changing option');

    // The state-changing branch is reversible/compensable only, never irreversible.
    expect(workerSkillText).toContain('never `irreversible`');

    // Execution-time re-checks: re-query source, re-check the floor, and confirm the
    // option's axes still fall within the active rule's gate bounds.
    expect(workerSkillText).toContain('gate bounds');
    expect(workerSkillText).toContain('min_reversibility');
    expect(workerSkillText).toContain('max_blast_radius');

    // The planned action must not escalate beyond the declared axes, and the option
    // must stay honestly reversible via an undo_prompt.
    expect(workerSkillText).toContain('does not escalate');
    expect(workerSkillText).toContain('undo_prompt');
  });

  it('captures generalised learning as structured policy proposals, not prose skill edits', () => {
    const workerSkillText = readFileSync(join(categoryRoot, 'keryx-worker', 'SKILL.md'), 'utf8');

    // v005 replaces the old "edit the collector SKILL.md" feedback loop with structured
    // keryx.policy.v1 rule proposals that land as blocked human-approval cards.
    expect(workerSkillText).toContain('generic or can be generalised');
    expect(workerSkillText).toContain('keryx.policy.v1');
    expect(workerSkillText).toContain('hermes keryx policy propose');
    expect(workerSkillText).toContain('blocked human-approval suggestion card');
    expect(workerSkillText).toContain('keryx:policy-proposal:<source>:<class>:<target-state>');

    // Proposals are scoped narrowly and start in shadow before any active silent authority.
    expect(workerSkillText).toContain('state: shadow');
    expect(workerSkillText).toContain('min_confidence');

    // The worker proposes promotion/demotion but never self-grants it.
    expect(workerSkillText).toContain('proposed by the worker, never self-taken');
  });

  it('qualifies the three shipped plugin skills and leaves created collector skills unqualified', () => {
    const descriptionText = readFileSync(join(categoryRoot, 'DESCRIPTION.md'), 'utf8');
    const collectorText = readFileSync(join(categoryRoot, 'keryx-collector', 'SKILL.md'), 'utf8');
    const collectorCreatorText = readFileSync(join(categoryRoot, 'keryx-collector-creator', 'SKILL.md'), 'utf8');
    const workerText = readFileSync(join(categoryRoot, 'keryx-worker', 'SKILL.md'), 'utf8');

    // The three repo-shipped plugin skills always keep the `keryx:` prefix.
    expect(descriptionText).toContain('`keryx:keryx-worker`');
    expect(descriptionText).toContain('`keryx:keryx-collector`');
    expect(descriptionText).toContain('`keryx:keryx-collector-creator`');

    for (const skillText of [collectorText, collectorCreatorText, workerText]) {
      expect(skillText).not.toContain('skill: keryx-worker');
      expect(skillText).not.toContain('attach `keryx-worker`');
      expect(skillText).not.toContain('Attach `keryx-worker`');
    }

    // Created source-specific skills live in Hermes' space and are referenced UNQUALIFIED.
    // Only the generic, repo-shipped collector skill keeps the `keryx:` prefix.
    expect(collectorCreatorText).toContain('$HERMES_HOME/skills/keryx-collector-$NAME/SKILL.md');
    expect(collectorCreatorText).toContain('`keryx-collector-$NAME`');
    expect(collectorCreatorText).not.toContain('`keryx:keryx-collector-$NAME`');
    expect(collectorCreatorText).toContain('`keryx:keryx-collector`');
    // Cron attachment order: created (unqualified) first, then the qualified generic skill.
    expect(collectorCreatorText).toContain('then `keryx:keryx-collector`');

    // The worker text must never qualify a created, source-specific collector skill: those
    // live in Hermes' space and stay unqualified. (The unqualified-name convention itself is
    // enforced corpus-wide by the templates-and-docs convention scan.)
    expect(workerText).not.toContain('`keryx:keryx-collector-$SOURCE`');
  });

  it('documents the creator bundle as the operator-facing slash command', () => {
    const descriptionText = readFileSync(join(categoryRoot, 'DESCRIPTION.md'), 'utf8');
    const collectorCreatorText = readFileSync(join(categoryRoot, 'keryx-collector-creator', 'SKILL.md'), 'utf8');

    for (const skillText of [descriptionText, collectorCreatorText]) {
      expect(skillText).toContain('/keryx-collector-creator');
      expect(skillText).not.toContain('/keryx:keryx-collector-creator');
      expect(skillText).not.toContain('/keryx:*');
    }
  });

  it('validates cards and decisions through the keryx CLI surface, not in-repo TS imports', () => {
    const workerText = readFileSync(join(categoryRoot, 'keryx-worker', 'SKILL.md'), 'utf8');

    // A Kanban-dispatched worker runs outside the repo's TS runtime, so it must validate via the CLI.
    expect(workerText).toContain('hermes keryx validate-card');
    expect(workerText).toContain('hermes keryx validate-decision');
    expect(workerText).toContain('hermes keryx validate-policy-decision');
    expect(workerText).toContain('hermes keryx validate-outcome');
    expect(workerText).toContain('hermes keryx schema action-item');
    expect(workerText).toContain('hermes keryx schema execution-decision');
    expect(workerText).toContain('hermes keryx schema policy-decision');
    expect(workerText).toContain('./bin/opsctl');
    expect(workerText).toContain('/tmp');

    // The old in-repo TypeScript validators must no longer be referenced.
    expect(workerText).not.toContain('validateActionItem');
    expect(workerText).not.toContain('validateExecutionDecision');
    expect(workerText).not.toContain('src/schemas/actionItem.ts');
    expect(workerText).not.toContain('src/schemas/executionDecision.ts');

    // The schema const checks remain part of the contract (v2 cards, v1 decisions/outcomes).
    expect(workerText).toContain('keryx.action_item.v2');
    expect(workerText).toContain('keryx.execution_decision.v1');
    expect(workerText).toContain('keryx.policy_decision.v1');
    expect(workerText).toContain('keryx.outcome.v1');
  });

  it('points collectors to canonical hermes keryx card commands instead of embedded templates', () => {
    const collectorText = readFileSync(join(categoryRoot, 'keryx-collector', 'SKILL.md'), 'utf8');
    const bundledSkillText = skillNames.map((skillName) => readFileSync(join(categoryRoot, skillName, 'SKILL.md'), 'utf8')).join('\n');

    expect(collectorText).toContain('hermes keryx template-card');
    expect(collectorText).toContain('hermes keryx validate-card');
    expect(collectorText).toContain('hermes keryx create-card');
    expect(collectorText).toContain('raw `hermes kanban create`');
    expect(collectorText).toContain('operator');

    expect(bundledSkillText).not.toContain('"schema": "keryx.action_item.v2"');
    expect(bundledSkillText).not.toContain('"schema": "keryx.execution_decision.v1"');
    expect(bundledSkillText).not.toContain('"properties"');
    expect(bundledSkillText).not.toContain('"required"');
  });
});

function parseSkill(path: string): { frontmatter: Record<string, string>; body: string } {
  const content = readFileSync(path, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(match, `${basename(path)} should have YAML frontmatter`).not.toBeNull();

  const frontmatter = Object.fromEntries(
    match![1]
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf(':');
        expect(separatorIndex, `frontmatter line should be key: value: ${line}`).toBeGreaterThan(0);
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1).trim().replace(/^"|"$/g, '')];
      }),
  );

  return { frontmatter, body: match![2] };
}
