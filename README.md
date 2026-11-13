# AE Daily Plan

An Agent Skill that gives an account executive one plan for the day, built
from their Salesforce book and Apollo's company signals, written by Claude,
and delivered in Slack. Nothing is written back to Salesforce until the rep
approves it.

**Demo video (4:53):** [watch](https://docs.google.com/videos/d/1Gi5TsCLuMv6RjN8M336nr1VM0pU2z4VSAY5hhRlxKMg/play?usp=sharing) or [download](docs/demo.mp4) ·
**One pager:** [docs/one-pager.pdf](docs/one-pager.pdf)

```
Your plan for Thursday, Nov 12
Urgent: Twilio, Asana, Box, GitLab · Meetings today: GitLab at 2:00 PM · Start with: Twilio, Asana, Box

6. Braze · Outbound
   Why now: Readiness A, and they are hiring a Sales Operations Systems and Data Lead (posted Oct 23).
   • Apollo company data: 2,000 employees, headcount up 13% over 12 months
   • Apollo hiring: 18 open sales roles in the last 60 days
   • Apollo news, Nov 9: "Braze named a leader in the inaugural Gartner Magic Quadrant ..."
   Call opener · next step · email, each checked before the rep sees it

Proposed writes (nothing is written until you approve):
☐ 1. Set readiness to B on Smartsheet (was blank)   ☐ 2. ...   [ Apply selected ]
```

A rep types `/plan` in Slack. The skill runs in the background, shows its
progress in the channel, and posts the plan about a minute later.

## Why this exists

An AE starts the day in five systems deciding who to call. The rules for
that decision are not a mystery: a deal waiting on you beats a stale one,
which beats a meeting to prep, which beats outbound. They are written in an
enablement doc. What is missing is applying them to a whole book before
9:00, every day, the same way, with a real reason to call each account.

This skill does three things a rep would otherwise do by hand or skip:

- **Ranks the book by rule.** Overdue deal work and next steps older than 14
  days rise to the top; a deal is never buried under outbound.
- **Finds the why now with Apollo.** Every account in play gets Apollo's
  company data, its open job postings and its recent news. A company posting
  a revenue operations or sales operations role is building the team that
  buys what this seller sells, and that posting becomes the reason to call,
  with its date. Open sales roles and headcount growth feed the readiness
  score; a stale or blank score is rescored from live data.
- **Writes the first draft of every touch** (call opener, next step, email)
  and holds each email to the team's written standard before the rep sees
  it.

**What it unlocks:** the first hour goes to calls instead of tabs; every
outbound touch stands on a dated, checkable fact instead of "just checking
in"; and the CRM gets better every morning (fresh readiness scores with
their reasons, a task for each next step) because the rep only has to say
yes.

## How it works

```
             ┌──────────── Salesforce (as the rep) ────────────┐
             │ Accounts, Opportunities, Contacts, Cases,        │
             │ Events, Tasks, Gong_Call__c (mirrors Gong)       │
             └───────────────┬──────────────────▲──────────────┘
                             │ read             │ write, only what was approved
 Apollo ─ company data, ──► 1. gather.ts ──┐     │
          job postings,     gate, rank,    │  5. apply.ts ◄── "approve 1 2 3"
          news              signals        │     ▲               (Slack thread or chat)
                             │             │     │
                     out/model-input.md    │  4. deliver.ts ──► Slack: one briefing,
                     (names as tokens)     │     ▲                cards in its thread
                             │             │     │
                       2. Claude writes ───┴► 3. check.ts
                       openers, next          email rules in code,
                       steps, emails          names put back, tasks proposed
```

| Step | Who decides | Where |
| --- | --- | --- |
| Gate: active user, time zone, a book to plan | Code | `scripts/gather.ts` |
| Which accounts, in what order | Code: a sort, not a score | `scripts/lib/rank.ts`, `scripts/lib/plan.ts` |
| Hiring and news signals from Apollo | Code, against `references/icp.json` | `scripts/lib/signals.ts` |
| Readiness A, B or C | Code, from Apollo data and signals | `scripts/lib/readiness.ts` |
| Who to contact, and whether email is allowed | Code | `scripts/lib/contacts.ts` |
| The words | **Claude** | `SKILL.md` step 2, or `scripts/write.ts` unattended |
| Whether an email may be shown | Code | `scripts/lib/guidance.ts` |
| What gets written to Salesforce | **The rep** | `scripts/apply.ts` |

**What starts it.** The skill is one implementation with three doors:

- **`/plan` in Slack**, the way a rep uses it. `bot/listen.ts` holds a Socket
  Mode connection to Slack, so commands and button clicks arrive over a
  connection the laptop opened: no public URL, no server. On `/plan` it starts
  Claude Code headless (`claude -p`) on this folder, which loads the same
  skill a person would use, and turns the run's tool calls into a progress
  message (reading, writing, checking, posting). Apply on the proposed writes
  runs `apply.ts` with exactly the ticked numbers.
- **A Claude Code window** on this folder: *"build my plan for apollo-demo"*.
  The same steps, visible, which is how the skill was built and is tested.
- **A schedule with nobody at the keyboard**: the scripts chained, with
  `write.ts` calling the Claude API in place of an agent (below).

The headless run gets only the tools the skill's steps use: three named
scripts, reading the skill and its output folder, and writing one file.
`apply.ts` and the name map (`out/tokens.json`) are denied outright, so the
run that writes the plan can never write to Salesforce. Only a click on
Apply can, and only by the person who asked for the plan.

Systems:

- **Salesforce:** read and write, through the `sf` CLI login, as the rep.
- **Apollo:** REST API with a key. Bulk company enrichment, job postings and
  news for every account in play, cached for the day so a rerun spends no
  credits twice.
- **Claude:** the agent running the skill, or the Claude API
  (`claude-opus-5-5`, structured output) for unattended runs.
- **Slack:** a bot token posts the plan; an app level token carries `/plan`
  and Apply over Socket Mode. Optional: without Slack the plan prints and
  approval happens in the chat.

Everything runs on a laptop. Every connection is outbound, Slack's included,
so there is no server. The listener only answers while it is running; in
production it would sit on a small always on host.

Gong and the support desk are read through Salesforce: calls live in a
`Gong_Call__c` object shaped like the one Gong's Salesforce package syncs,
and support tickets are Cases. That is how most companies have them, and it
means one login and Salesforce's own sharing decide what the plan can see.

## Run it

Needs Node 22.18 or later (TypeScript runs directly) and, for the live run,
the Salesforce CLI.

### With no accounts at all

```bash
npm install
npm test
node .claude/skills/ae-daily-plan/scripts/gather.ts --fixtures
```

Then open the repository in Claude Code and ask: *"build my plan with the
fixtures"*. Claude follows `SKILL.md`: it writes `out/written.json`, runs the
check, and prints the plan. The fixtures are the seeded book below plus
invented Apollo answers in Apollo's response shape.

### Live

1. **Salesforce.** Sign up for a free
   [Developer Edition](https://developer.salesforce.com/signup), then:
   ```bash
   sf org login web --alias apollo-demo
   sf project deploy start --target-org apollo-demo
   sf org assign permset --name AE_Daily_Plan --target-org apollo-demo
   node salesforce/seed/seed.ts --org apollo-demo
   ```
   The seed refuses any org that is not a Developer Edition.
2. **Apollo.** Create an API key with `organizations/bulk_enrich`,
   `organizations/enrich`, `organizations/job_postings` and
   `news_articles/search` (Settings, Integrations, API).
3. **Slack.** At [api.slack.com/apps](https://api.slack.com/apps), create an
   app from the manifest in `setup/slack-manifest.json` (it turns on Socket
   Mode, interactivity and `/plan`), install it, and invite it to a channel
   (`/invite @AE Daily Plan`). Copy the bot token and the channel ID, and
   under Basic Information create an app level token with
   `connections:write`.
4. **Save the keys** to a git ignored `.env`, hidden as you type:
   ```bash
   zsh setup/save-env.zsh
   ```
   ```bash
   zsh setup/save-one.zsh SLACK_APP_TOKEN
   ```
5. Start the listener and leave it running, then type `/plan` in the channel:
   ```bash
   npm run bot
   ```
   Or, without Slack's door, in Claude Code from this folder: *"build my plan
   for apollo-demo"*, then reply `approve 1 2 3` in the thread and ask Claude
   to apply them.

For a scheduled run with nobody at the keyboard, add `ANTHROPIC_API_KEY` to
`.env` and chain the scripts, with `write.ts` in place of Claude in the loop:

```bash
S=.claude/skills/ae-daily-plan/scripts
node $S/gather.ts --org apollo-demo && node $S/write.ts && node $S/check.ts && node $S/deliver.ts
```

The rep approves in the Slack thread; `apply.ts --org apollo-demo --from-slack`
makes those writes.

## Write up and demo

- [The demo](https://docs.google.com/videos/d/1Gi5TsCLuMv6RjN8M336nr1VM0pU2z4VSAY5hhRlxKMg/play?usp=sharing), 4:53 (also [`docs/demo.mp4`](docs/demo.mp4)). A rep runs `/plan` in
  Slack, reviews the plan, applies writes and opens the record in Salesforce;
  then the design, trust, scope and hardening, narrated.
- `docs/one-pager.pdf`: what it is, why it matters, how it works, and the
  discussion questions on one page.
- `docs/demo-script.md`: the five minute walk through.

## The demo book

Eleven accounts in `salesforce/seed/data.ts`, each there to show one rule:
an overdue task (Twilio), a stale next step (Asana), an open high priority
case that holds the pitch email (Box), a meeting today (GitLab), a lost deal
quiet for 60 days (PagerDuty), a target with nobody on record (Braze), a
stale readiness score Apollo refreshes (Amplitude), an opted out contact who
must not be approached (Smartsheet), an account worked inside the quiet
period (DocuSign), one outside the ICP (Okta) and a partner (Dropbox).

**The CRM records are invented.** The company names and domains are real so
Apollo has something to resolve, and Apollo's answers about them are real;
the deals, calls, cases and people in Salesforce are not, and say nothing
about those companies.

## Design decisions

**Skill, script, or a direct MCP call?** All three have a place, and each
does what it is best at. API calls fetch facts. Scripts decide everything
that must be the same every morning and explainable to a rep, so every rule
is a test. Claude writes, from facts it is handed. A pure prompt skill would
be quicker to change, but "rank by these rules" in a prompt is a request,
and in code it is a guarantee. The skill format is still right on top: it
tells the agent when to use this, in what order, and what it must never do.
Apollo's MCP server is wired in too (`.mcp.json`, `--people mcp`) for people
search on plans that include it; its answer goes to the scripts as a file,
never straight into a write.

**Structuring data for the model.** One block per account: a key, a
category, a why now, a contact token, and dated facts, each labeled with
its source ("Apollo hiring: ..., posted Oct 23"). People are tokens
(`[[P3]]`), so names never reach the model; `check.ts` puts them back only in
what the rep reads. Unattended, `write.ts` asks for structured output whose
`key` field is an enum of the plan's account ids, so Claude cannot return an
account that is not in the plan or a mangled id. Anything missing is said
("not written this run"), never guessed.

**Left out on purpose.** Sending email or creating drafts. Any write without
approval. Storing a copy of CRM data. A model score for ranking. Mobile
numbers (never queried). Revealing Apollo email addresses, which costs
credits. A hosted server: Socket Mode gives Slack commands and buttons
without one.

**What Apollo's plans allowed, tested rather than assumed.** Company
enrichment worked on the free plan. Job postings, news and bulk enrichment
work on Professional. People search and people match were refused on every
plan tried, over the REST API and over Apollo's MCP server (whose docs say
it works on any plan; the account said otherwise), and the one open people
endpoint, `organization_top_people`, returned nobody. So Apollo's job here is
signals and readiness, which is where it changes the plan most, and people
search is built, switched off, and listed as what a higher tier adds.

**Assumptions.** Each system's own permissions are the right scope, so
everything runs as the rep. The ICP in `references/icp.json` (buyer titles,
size, industries, signal windows) is RevOps owned and changes without code.
A readiness score older than 30 days is stale. A job posting older than 60
days says little about today. Gong and support data are in Salesforce, as
they are at most companies.

## Where AI helped, and where it was not trusted

This was built with Claude Code. It wrote most of the code and tests under
review, and it is the model inside the skill.

Not trusted, and checked against real runs:

- **The emails.** Every rule in `references/email-rules.md` is enforced in
  `guidance.ts`. On the first full run, the email Claude wrote for Amplitude
  had a five word subject against a limit of four. It was dropped and the
  card says why.
- **The checker, too.** The email rules were also written with AI help, and
  one was too blunt: any line starting with "Thanks" counted as a sign off.
  On the first live run, a good four sentence email that opened "Thanks for
  reviewing the proposal" was dropped for having zero sentences. A test now
  covers it, written to fail before the fix.
- **Apollo's data.** The first live run showed what a vendor feed really
  looks like. Apollo tied off topic articles to companies ("MCP's first data
  leaks" came back for Asana), so a headline must now name the company. It
  returned a "max severity security flaw exploited" story for GitLab and a
  shareholder investigation for Braze: facts a rep should know before
  calling, so they stay on the card, but an email built on them is dropped
  in code. It reported an acquisition as the latest "funding stage", which
  no longer counts as a raise. A first filter on "gtm" counted a product
  marketing role as buyer team hiring; only the ICP's buyer titles count now.
- **The model's answer shape.** In Precog, the production version of this
  playbook, every call opener once read "not written": one model answered in
  prose and the next left out the account id, while the tests passed against
  a stand in model that always answered correctly. Here the key is an enum in
  the response schema, and `check.ts` reports any account left unwritten.
- **The tests themselves.** A test that cannot fail is worse than none. Ten
  rules were broken on purpose, one at a time, and the suite went red each
  time, among them: stale at 14 days instead of 15; a missing opt out flag
  read as permission; the 125 word limit raised; an extra field allowed on an
  Account write; the support case hold removed; contact names left
  unscrubbed; any "operations" job title counted as buyer team hiring; job
  postings that could not be read treated as "none".
- **The writes.** `apply.ts` writes only objects and fields on its allow
  list, whatever the plan file says, checks Salesforce for a duplicate right
  before creating a Contact, and logs every before and after.
- **The background run.** Run headless from Slack, Claude gets three named
  scripts and one file to write, and nothing else. On the first headless
  run it reached for a Python one liner to fix an email after the checker
  failed it; that was refused, and it made the fix with an edit to the one
  file it may write. `apply.ts` is denied to it entirely. Progress in Slack
  is read from its actual tool calls, and "done" means the plan reached
  Slack, not that the agent said so.
- **The org.** The seed refuses anything but a Developer Edition, because a
  laptop that has worked on real orgs still has them logged in.

## What was already built, and what is new

The ranking, contact rules, email checks and the lessons above come from
**Precog**, an AI agent platform for go to market teams that I designed and
built, where this runs as the AE daily plan playbook. New for this
exercise: the skill packaging; Apollo in place of Clay, now supplying
hiring and news signals as well as readiness; Salesforce as the single
system of record for calls and cases; `/plan` and Apply in Slack over
Socket Mode, running the skill headless; `write.ts`;
the seed book; and every test here.

## What to harden before reps depend on it

| Here | In production |
| --- | --- |
| Name tokens are a convention the skill follows | Tokenized at the model boundary in code, which the model cannot route around |
| Apply is limited to the Slack user who asked for the plan, and writes through one Salesforce login | Each Slack user mapped to their own Salesforce user (through SSO), so the plan reads and the write runs as that rep |
| One listener on a laptop, one plan at a time | The listener on an always on host, a plan per rep on a schedule as well as on `/plan`, with a ledger of every run and every skip |
| ICP and signal rules in a JSON file | Owned by RevOps, versioned, with a change log |
| Rules proven by unit tests | An eval set built from reps' verdicts on real plans (keep, wrong, improve) |
| No outcome measured | Replies and meetings booked against a holdout group |
| Apollo news filtered by keyword | A classifier for relevance and sentiment, checked against rep feedback |
| No new contacts on this Apollo plan | People search on a higher tier, matched against the CRM before any write |
| One rep | Rate limits and paging for a team |

## Layout

```
.claude/skills/ae-daily-plan/
  SKILL.md                 what Claude does, in order, and what it must never do
  references/icp.json      buyer titles, size, industries, signal windows
  references/email-rules.md
  scripts/gather.ts        read, gate, ask Apollo, rank, hand the model its input
  scripts/write.ts         Claude through the API, for unattended runs
  scripts/check.ts         email rules, names back, tasks proposed
  scripts/deliver.ts       Slack, or the terminal
  scripts/apply.ts         approved writes only, logged
  scripts/lib/             the rules, each pure and tested
bot/
  listen.ts                /plan and Apply in Slack, over Socket Mode
  logic.ts                 its decisions (progress, permissions, who may apply), tested
salesforce/
  force-app/               custom fields, Gong_Call__c, permission set
  seed/                    the demo book and invented Apollo answers for offline runs
setup/
  slack-manifest.json      the Slack app, in one paste
  save-env.zsh             saves keys to .env without showing them
```

## License

MIT
