// Discovery adds the bundled settings skill and the Agent Skills folders Pi's
// SDK loader skips: .agents/skills from cwd up to the Git root (or filesystem
// root), nearest first, then ~/.agents/skills. Pi keeps a name's first skill.
// Autocomplete and fresh request-boundary resources share this discovery.
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RECURSE_SETTINGS_SKILL = fileURLToPath(
  new URL("../../skills/recurse-settings/SKILL.md", import.meta.url),
);

export interface SkillInfo {
  name: string;
  description: string;
}

export interface ListSkillsOptions {
  cwd: string;
  skillPaths?: readonly string[];
  home?: string;
}

/** A working folder's Agent Skills folders; one stat per ancestor. */
export async function skillPathsForWorkdir(
  cwd: string,
  home = homedir(),
): Promise<string[]> {
  const user = join(home, ".agents", "skills");
  const paths: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    const skills = join(dir, ".agents", "skills");
    if (skills !== user) paths.push(skills);
    if (await stat(join(dir, ".git")).catch(() => null)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...paths, user];
}

export async function listSkills(
  agentDir: string,
  o: ListSkillsOptions,
): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  return loadSkills({
    cwd: o.cwd,
    agentDir,
    skillPaths: [
      RECURSE_SETTINGS_SKILL,
      ...(await skillPathsForWorkdir(o.cwd, o.home)),
      ...(o.skillPaths ?? []),
    ],
    includeDefaults: true,
  })
    .skills.filter((skill) => {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
