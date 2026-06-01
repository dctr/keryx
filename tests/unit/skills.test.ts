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
