# Stats and quota

> What this page is for: how much of each Agent's quota is used and when it resets; how historical usage breaks down by token, message, tool, model and project; and where to find the cross-Agent retro insights.

![Quota](../../assets/shot-quota.png)

Reached from "Stats & quota" in the sidebar, with two tabs at the top of the page: **Quota** and **Usage stats**. Whichever you pick is remembered per device. When the sidebar is filtered by machine, this page counts only that machine.

## Quota

One card per Agent: avatar, name, machine (one account on two machines says "+ <machine> · same account"), plan (Pro, Max, Plus, Team and so on), and below that a usage bar per time window: the label (such as 5 hours, 7 days, or a specific model), the percentage used, and "resets in Nh". Above 70% it turns yellow, above 90% red. At the bottom of the card are the update time (anything over 10 minutes old is flagged as stale) and the collapsed "Where this comes from".

- The percentage is how much is **used**. One account shares a single quota across machines; they do not add up. When the two sides disagree, it points out "not the same account as on <machine>", though it can also be that one of the two readings is stale.
- Where it comes from: Claude Code uses the official usage endpoint (reading the login state on this machine, read-only and never sent anywhere), while Codex and ZCode read their own local state. Anything missing or stale is marked as such, never inferred to be zero.
- "Refresh quota" reads again; "No quota data · N" expands the Agents that returned nothing.
- The top bar and the menu bar icon show these same bars for this machine.

## Usage stats

The toolbar: by Agent (all or one), time range (7 days, 30 days, 90 days, a year, everything), and by token or by message. With two machines and no filter, it says "A + B", meaning the stats of both are added together.

The contents, top to bottom:

1. **The insight card** (see below).
2. **Four numbers**: total tokens (input, output, cache read, cache write, thinking), message count (session count, subagent share), active days (current streak, longest streak), and tool variety (number of active periods or the start date).
3. **Who used it**: a bar of each Agent's share of the tokens.
4. **Activity heatmap**: a GitHub-style calendar, where the shade is that day's tokens or messages.
5. **When the work happens**: a week × hour grid, naming the busiest periods.
6. **Last N days**: a bar per day, stacked by Agent.
7. Rankings: most-used tools, models (by reply), most-used skills (the Skill tool or / commands), subagents spawned, and projects by who burns the most tokens.

Token counts come from each Agent's own records: Claude Code's usage on every API reply (deduplicated by requestId), Codex's cumulative token_count per turn, and ZCode's tokens per message. Money is not calculated here; you are on a subscription, so the quota page is all you need. The first open has to index all of your chat history, which can take a minute.

## Insights

The card at the top of the stats page is a cross-Agent retro, the equivalent of Claude Code's own /insights but covering the sessions of every Agent:

- **Report**: a report written by a model (the last N days), expandable by section, with "Open the full page" for the HTML; you can "Generate" one by hand (usually 1 to 3 minutes) or set it to generate automatically every 7 / 14 / 30 days; past reports can be switched between.
- **Signal counts**: behavioral signals counted with regular expressions: too many corrections, context overflow, tool errors, nothing on the board, overlong sessions, broken down by Agent.
- **Alerts**: per-session warnings, with new ones flagged on the workbench and in system notifications; "Open session" jumps there; "Mark all seen" marks this batch.
- **Send an agent to improve**: hand the friction and suggestions sections to an Agent to turn into changes to the rules or the skills.

From the command line: `dispatch insights` (signals) and `dispatch insights report|list|show|open|schedule`. For the model the insight reports use, see [Known limits](26-limits.md).
