# Auditing whether the rules are followed

Core principle: what the rules say comes from the rule files in the workspace; this reference only gives the method to extract, check and handle them. The authorization boundaries of the system, the person and the project rank above this skill.

## Extract conventions that can be checked mechanically

While reading the chain of rules that applies, look for imperative sentences that can become a check command, and note where each comes from.

| Kind | Rule sentence | Evidence |
|---|---|---|
| Naming | "folders must be kebab-case" | the list of sibling names and the stated exceptions |
| Required files | "every project must have X" | the file exists and has the minimum content |
| One source | "A is a symlink to / imports B", "only edit B" | `readlink`, realpath, imports, load diagnostics |
| Safety red lines | "no secrets in code", "the ignore file must contain X" | tracked files, ignore rules, secret scanner |
| Folder discipline | "no loose files in the root" | root manifest and allow list |
| Declarations hold | "the start command / URL / service name must be real" | package and config files, the service or a live probe |
| Release process | "the full report and the person's confirmation come before cleanup" | knowledge receipt, deploy marker, cleanup candidates, the person's approval after the report |

Behaviour preferences such as "lead with the conclusion" are followed too, but they are not structural audit results unless a verifiable template or gate exists.

## Find the rule chain that really applies

Do not assume every platform reads the same file from the root:

1. Identify the current agent and `cwd`.
2. From the project root to `cwd`, look for this platform's rule files, overrides, fallbacks and path rules.
3. Then the user- or organization-level rules.
4. Note the load order and what overrides what; in one folder, count only the files the platform really loads.
5. When the project declares that CLAUDE.md and AGENTS.md must share one source, check the symlink or import; without such a declaration, only report the risk of them drifting apart, and do not decide the direction yourself.

## Scope of the check

- **A request about the current project**: audit this project's content; the rules above and the sibling names are read only.
- **A change across projects**: audit the upstream and consumer docs that are really affected, and say first why the scope widens.
- **The whole workspace**: only after the person explicitly allows it, check existence, one-source and rules project by project; decide by risk whether to read files in full.
- **Global configuration**: by default a read-only audit of dead references, contradictions and load drift; never write project details into global files.

## How each finding is handled

Follow the local rules first; when they say nothing more specific, use these defaults. In phase 1 every finding is only reported, whatever its level; the level decides what you offer in phase 2.

### Safe to fix once picked

All of these hold: inside the request's scope, safe, reversible, no outside effects, and the current rules allow it. For example:

- a symlink or import the local rules require is missing;
- `.gitignore` lacks a pattern for sensitive files the rules require;
- an obvious typo in a doc, or a link confirmed to point at something that no longer exists;
- an out-of-date summary of a fact that the current code or runtime decides without doubt.

These are what "Fix the safe ones" covers in phase 2.

### Needs its own yes

- renaming a folder or project, deleting a file or folder;
- merging rule files with different content when the authoritative one is not clear;
- rules and steady practice have drifted apart and it is unclear which should change;
- changing a project outside the scope, global configuration or someone else's workspace;
- stopping services, permissions and secrets, irreversible migrations, messages to others, and other risky actions the local rules list;
- the only evidence sits in an unmerged or dirty lane that a cleanup would lose.

### Report only

- the person limited the request to "have a look / audit / report";
- the problem is outside the requested scope;
- the platform's generated files must not be edited directly;
- the fact cannot be verified or needs permissions on an outside system.

## The quality of the rules themselves

Also check:

- **Dead references**: do the paths, commands, services and projects exist? When unsure about paths on another device, do not propose deleting them.
- **Contradictions**: do rules at different levels, overrides, skills and practice demand opposite things?
- **Not executable**: lots of "keep it tidy / be careful" with no criterion.
- **Duplication**: the same red line copied into global, project and skill files, bound to drift.
- **Overload**: core rules buried under history; propose removing or moving before adding sections.
- **No gate**: the same violation for the third time means prose is not enough. Within the local authorization, propose (or, once picked, build) a check, hook or test.

## What each reported finding contains

- the evidence and where the rule comes from;
- its scope;
- the impact on the person or the way people work together;
- the proposed action and its level (safe once picked / needs its own yes / report only);
- for "report only", why it cannot be changed here.

Do not replace the material for a decision with "found N problems", and do not mix problems outside the scope into a "the project is clean" conclusion.
