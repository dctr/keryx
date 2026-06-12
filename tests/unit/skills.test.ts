import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const categoryRoot = join(process.cwd(), 'skills', 'keryx');
const skillNames = ['keryx-worker', 'keryx-collector', 'keryx-collector-creator'] as const;

const requiredCriticalPhrases = [
  'untrusted source content',
  'keryx.action_item.v1',
  'trusted execution decision',
  'blocked card creation',
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

  it('documents feedback-driven automation suggestions in the worker skill', () => {
    const workerSkillText = readFileSync(join(categoryRoot, 'keryx-worker', 'SKILL.md'), 'utf8');

    expect(workerSkillText).toContain('generic or can be generalised');
    expect(workerSkillText).toContain('`keryx-collector-$SOURCE`');
    expect(workerSkillText).toContain('keryx:automation-suggestion:<source>:<stable-slug>');
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

    // The creator skill itself stays qualified when self-referenced; created skills do not.
    expect(workerText).toContain('`keryx:keryx-collector-creator`');
    expect(workerText).toContain('`keryx-collector-$SOURCE`');
    expect(workerText).not.toContain('`keryx:keryx-collector-$SOURCE`');
    expect(workerText).not.toContain('inspect `keryx-collector-creator`');
  });

  it('documents the creator bundle as the operator-facing slash command', () => {
    const descriptionText = readFileSync(join(categoryRoot, 'DESCRIPTION.md'), 'utf8');
    const collectorCreatorText = readFileSync(join(categoryRoot, 'keryx-collector-creator', 'SKILL.md'), 'utf8');
    const workerText = readFileSync(join(categoryRoot, 'keryx-worker', 'SKILL.md'), 'utf8');

    for (const skillText of [descriptionText, collectorCreatorText, workerText]) {
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
    expect(workerText).toContain('hermes keryx schema action-item');
    expect(workerText).toContain('hermes keryx schema execution-decision');
    expect(workerText).toContain('./bin/opsctl');
    expect(workerText).toContain('/tmp');

    // The old in-repo TypeScript validators must no longer be referenced.
    expect(workerText).not.toContain('validateActionItem');
    expect(workerText).not.toContain('validateExecutionDecision');
    expect(workerText).not.toContain('src/schemas/actionItem.ts');
    expect(workerText).not.toContain('src/schemas/executionDecision.ts');

    // The schema const checks remain part of the contract.
    expect(workerText).toContain('keryx.action_item.v1');
    expect(workerText).toContain('keryx.execution_decision.v1');
  });

  it('points collectors to canonical hermes keryx card commands instead of embedded templates', () => {
    const collectorText = readFileSync(join(categoryRoot, 'keryx-collector', 'SKILL.md'), 'utf8');
    const bundledSkillText = skillNames.map((skillName) => readFileSync(join(categoryRoot, skillName, 'SKILL.md'), 'utf8')).join('\n');

    expect(collectorText).toContain('hermes keryx template-card');
    expect(collectorText).toContain('hermes keryx validate-card');
    expect(collectorText).toContain('hermes keryx create-card');
    expect(collectorText).toContain('raw `hermes kanban create`');
    expect(collectorText).toContain('operator');

    expect(bundledSkillText).not.toContain('"schema": "keryx.action_item.v1"');
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
