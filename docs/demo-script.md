# Demo voiceover

The video is `Apollo Demo with slides.mp4`, 4:52 long: the screen recording
(0:00 to 2:18) and then five slides (`docs/slides.html`), 2:18 to 4:52. It
has no sound. Generate each block below as its own ElevenLabs clip and place
it at its start time.

Each block is written to fit its window at about 150 words a minute. If a clip
runs long, raise ElevenLabs' speed a little (1.05) or tell me the clip
lengths and I'll retime the slides to match. Send me the clips and I can mix
them into the video too.

## Part 1: the recording

**0:00 to 0:06** · `/plan` is typed

> This is AE Daily Plan, an Agent Skill. A rep asks for today's plan in Slack.

**0:06 to 0:40** · the progress checklist ticks

> Behind that command, a small listener on my laptop holds a Socket Mode connection to Slack, so there's no server to host. It starts Claude Code in the background, on the same skill a rep could run in a Claude Code window. Scripts read the rep's book from Salesforce, then Apollo's company data, job postings and news for every account in play. Claude writes, code checks every email, and the plan posts. The checklist follows the agent's real tool calls, not a timer.

**0:40 to 0:52** · the briefing arrives

> About forty seconds later the plan arrives: one briefing with what's urgent, today's meeting, where to start, and what couldn't be checked, like Apollo news this key can't read.

**0:52 to 1:14** · Twilio and Asana cards

> Code ranks the book. It's a sort, not a score: overdue deal work first, then stale next steps, today's meetings, and outbound last. Twilio leads because a pricing task has been overdue since November ninth. Asana's next step hasn't moved in twenty one days. Every fact on a card is dated and labeled with its source.

**1:14 to 1:22** · the Box card

> Box has a high priority support case open, so code holds the pitch email. The rep calls about the case first.

**1:22 to 1:36** · GitLab, then its Salesforce record

> GitLab is a meeting today, so its card adds discovery questions and likely objections. Every card links to its record in Salesforce, read live as the rep. Nothing is copied out.

**1:36 to 1:46** · PagerDuty, Braze, Amplitude, Smartsheet

> Apollo earns its place here. PagerDuty lost a deal in June; Apollo shows a new sales strategy director posting. Time to reopen it.

**1:46 to 1:57** · left out, proposed writes, tick and Apply

> Okta is left out: Apollo shows it's too big, wrong industry. Then the proposed writes. Nothing touches Salesforce until the rep ticks one and presses Apply.

**1:57 to 2:18** · the GitLab task in Salesforce

> Only the person who asked for the plan can apply it. Each write must pass an allow list of objects and fields, and is logged with its value before and after. The result links straight to the record: here's the task on GitLab, due today, with the plan's reason in its comments.

## Part 2: the slides

**2:18 to 2:49** · What it changes for the team

> The rules for who to call already live in enablement docs, but nobody applies them to a whole book before nine, every morning, the same way. This does. The first hour goes to calls instead of tabs. Every outbound touch stands on a dated, checkable fact. And the CRM gets better each day, with readiness scores and their reasons, and a task for every next step, because the rep only says yes.

**2:49 to 3:22** · Who decides what

> Why a skill, and not a script or an MCP call? Each part does what it's best at. Apollo's API fetches facts; its MCP server is wired in for people search, which this Apollo plan refused. Code decides order, readiness, who's safe to contact and whether an email may be shown, because a rule in a prompt is a request, and in code it's a guarantee. Claude writes only the words, from dated facts labeled by source, with names swapped for tokens.

**3:22 to 3:55** · Where AI helped, and where I did not trust it

> Claude Code wrote most of this under my review. Real runs caught what tests didn't: the checker dropped Claude's own email for a five word subject, and once misread "Thanks for reviewing" as a sign off, so a test covers that. Apollo tied bad news to accounts, so no email may pitch on it. Run from Slack, Claude may call three scripts and nothing else, and it can never write to Salesforce. I broke rules on purpose to watch each test fail.

**3:55 to 4:24** · What I assumed, and what I left out

> I assumed each system's own permissions are the right scope, so everything runs as the rep; that RevOps owns the ideal customer profile, in a file anyone can read; and that calls and tickets live in Salesforce, so Gong is a mirrored object and Cases stand in for the support desk. I left out sending email, any write without approval, stored copies of CRM data, and a model score for ranking.

**4:24 to 4:52** · Before reps depend on it

> To harden it: tokenize names at the model boundary in code. Map each Slack user to their own Salesforce login, so reads and writes run as that rep. Run the listener on an always on host, with a scheduled plan per rep and a ledger of every run. Build evals from reps' verdicts on real plans. And measure replies and meetings booked against a holdout before claiming time saved.

## What the exercise asks, and where it is answered

| Asked for | Where |
| --- | --- |
| A skill solving a real GTM problem with an external system | All of part 1; 2:18 slide |
| The problem, and how it benefits the team | 0:00, 2:18 |
| How it works on the back end | 0:06, 0:52, 1:57; 2:49 slide |
| Assumptions | 3:55 |
| Skill, script or MCP | 2:49 |
| How the data is shaped for the model | 0:52 (dated, sourced facts); 2:49 (tokens) |
| What was left out | 3:55 |
| Where AI helped, and where it was not trusted | 1:14 (held email), 1:57 (allow list); 3:22 |
| What production needs | 4:24 |
| Five minutes or less | 4:52 |
