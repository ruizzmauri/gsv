import { SkillSummary } from "../skills";
import { AgentWorkspace } from "./loader";

/**
 * Build a system prompt from workspace files
 *
 * Order (when BOOTSTRAP.md exists - first run):
 * 1. BOOTSTRAP.md - Commissioning ceremony (takes over)
 *
 * Order (normal operation):
 * 1. Base system prompt (from config)
 * 2. SOUL.md - Who you are
 * 3. USER.md - Who you're helping
 * 4. AGENTS.md - How to operate
 * 5. MEMORY.md - Long-term memory (main session only)
 * 6. Daily memory - Recent context
 * 7. TOOLS.md - Tool notes
 */
export function buildSystemPromptFromWorkspace(
  basePrompt: string | undefined,
  workspace: AgentWorkspace,
): string {
  const sections: string[] = [];

  // BOOTSTRAP.md - First run commissioning ceremony
  // When present, this takes priority - the agent needs to establish identity first
  if (workspace.bootstrap?.exists) {
    sections.push(
      `## COMMISSIONING CEREMONY (First Run)\n\n**IMPORTANT: BOOTSTRAP.md exists. This is your first activation. Follow the commissioning ceremony below before doing anything else.**\n\n${workspace.bootstrap.content}`,
    );

    // Still include SOUL.md if it exists (might have defaults)
    if (workspace.soul?.exists) {
      sections.push(
        `## Current Soul (update during commissioning)\n\n${workspace.soul.content}`,
      );
    }

    // Include IDENTITY.md template
    if (workspace.identity?.exists) {
      sections.push(
        `## Current Identity (fill in during commissioning)\n\n${workspace.identity.content}`,
      );
    }

    // Include basic info about the human if known
    if (workspace.user?.exists) {
      sections.push(`## About Your Human\n\n${workspace.user.content}`);
    }

    return sections.join("\n\n---\n\n");
  }

  // Normal operation (no BOOTSTRAP.md)

  // Base system prompt
  if (basePrompt?.trim()) {
    sections.push(basePrompt.trim());
  }

  // SOUL.md - Core values and personality
  if (workspace.soul?.exists) {
    sections.push(`## Your Soul\n\n${workspace.soul.content}`);
  }

  // IDENTITY.md - Name, class, emoji
  if (workspace.identity?.exists) {
    sections.push(`## Your Identity\n\n${workspace.identity.content}`);
  }

  // USER.md - About the human
  if (workspace.user?.exists) {
    sections.push(`## About Your Human\n\n${workspace.user.content}`);
  }

  // AGENTS.md - Operating instructions
  if (workspace.agents?.exists) {
    sections.push(`## Operating Instructions\n\n${workspace.agents.content}`);
  }

  // MEMORY.md - Long-term memory (only in main session)
  if (workspace.memory?.exists) {
    sections.push(`## Long-Term Memory\n\n${workspace.memory.content}`);
  }

  // Daily memory - Recent context
  const dailyMemorySections: string[] = [];
  if (workspace.yesterdayMemory?.exists) {
    dailyMemorySections.push(
      `### Yesterday\n\n${workspace.yesterdayMemory.content}`,
    );
  }
  if (workspace.dailyMemory?.exists) {
    dailyMemorySections.push(`### Today\n\n${workspace.dailyMemory.content}`);
  }
  if (dailyMemorySections.length > 0) {
    sections.push(`## Recent Context\n\n${dailyMemorySections.join("\n\n")}`);
  }

  // TOOLS.md - Tool configuration
  if (workspace.tools?.exists) {
    sections.push(`## Tool Notes\n\n${workspace.tools.content}`);
  }

  // Skills - Available capabilities
  if (workspace.skills && workspace.skills.length > 0) {
    const skillsSection = buildSkillsSection(workspace.skills);
    sections.push(skillsSection);
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Build the skills section for the system prompt
 * Lists available skills with descriptions - agent should read SKILL.md when needed
 */
function buildSkillsSection(skills: SkillSummary[]): string {
  const lines = [
    "## Skills (Mandatory Scan)",
    "",
    "Before responding, scan <available_skills> descriptions. If exactly one skill clearly applies, read its SKILL.md at <location> with the `Read` tool, then follow its instructions.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push(
      `  <skill name="${skill.name}"${skill.always ? ' always="true"' : ""}>`,
    );
    lines.push(`    <description>${skill.description}</description>`);
    lines.push(`    <location>${skill.location}</location>`);
    lines.push(`  </skill>`);
  }

  lines.push("</available_skills>");

  return lines.join("\n");
}