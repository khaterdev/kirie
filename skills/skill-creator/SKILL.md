---
name: skill-creator
description: Create new Kirie skills interactively. Use when learning something new that should become a reusable skill.
emoji: "\U0001F6E0"
version: "1.1.0"
invocation:
  userInvocable: true
---

# Skill Creator

Create new skills for Kirie. Skills are reusable knowledge units (workflows, conventions, guides, tools) that get auto-detected and invocable via the Skill tool.

## Skill Location

All skills live at: `~/.kirie/.claude/skills/<skill-name>/SKILL.md`

Each skill is a directory containing:
- `SKILL.md` (required) - the skill definition
- Optional: reference files, assets, subdirectories

## SKILL.md Format

Every skill file has YAML frontmatter + markdown body:

```markdown
---
name: my-skill-name
description: One-line description of when to use this skill. Be specific about triggers.
emoji: "\U0001F527"
version: "1.0.0"
invocation:
  userInvocable: true
---

# Skill Title

Brief explanation of what this skill does.

## Usage
- "Example invocation phrase 1"
- "Example invocation phrase 2"

## How it works
1. Step one
2. Step two
3. Step three

## [Additional sections as needed]
Content, templates, code examples, references, etc.
```

## Creating a New Skill

### Step 1: Choose a name
- Use lowercase kebab-case: `my-skill-name`
- Be descriptive but concise: `aws-ami-builder`, `terraform-style-guide`, `coding-agent`

### Step 2: Write the description
The `description` field in frontmatter is critical. It's what the Skill tool uses to match user requests to skills. Be specific about when to use it:
- Good: "Build Amazon Machine Images (AMIs) with Packer using the amazon-ebs builder. Use when creating custom AMIs for EC2 instances."
- Bad: "Packer stuff"

### Step 3: Write the body
Include:
- What the skill does (brief)
- Usage examples (natural language invocations)
- How it works (numbered steps)
- Reference material: templates, code snippets, commands, best practices
- Common issues / troubleshooting (if applicable)
- External references / links (if applicable)

The body is loaded as context when the skill is invoked. Make it comprehensive enough to be self-contained.

### Step 4: Create the file
```
mkdir -p ~/.kirie/.claude/skills/<skill-name>
# Write SKILL.md to ~/.kirie/.claude/skills/<skill-name>/SKILL.md
```

### Step 5: Verify
The skill will appear in the Skill tool's available skills list on the next invocation. No restart needed.

## Installing Skills from External Repos

If a repo already has `SKILL.md` files (e.g., `hashicorp/agent-skills`):
1. Clone or download the repo
2. Copy each skill directory into `~/.kirie/.claude/skills/`
3. Include any reference files or assets alongside the SKILL.md
4. Done. No conversion needed if already in SKILL.md format.

## Tips
- Skills are for **actionable knowledge**: how to do things, conventions to follow, templates to use
- For pure facts/context, use memory DB instead (or both)
- Keep skills focused. One skill per topic. Don't cram everything into one file.
- The description field is your SEO. Write it like you're telling someone exactly when to reach for this skill.
- Include real code examples and templates. A skill without examples is just documentation.
- **Learning something = creating a skill + storing in memory DB.** Both, not one or the other.
