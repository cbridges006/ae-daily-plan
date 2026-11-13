Build a self playing animated explainer, 2 minutes 28 seconds long, as one HTML page at exactly 1802 by 1080 pixels. It plays once, start to finish, with no clicks, no controls and no sound (I am laying a voiceover on top). I will screen record it, so every scene must start at the exact second given below, and nothing should flash, scroll or loop.

It follows a screen recording of a Slack app called AE Daily Plan: an Agent Skill that builds an account executive's daily plan from Salesforce and Apollo, written by Claude and delivered in Slack, and that only writes to Salesforce when the rep approves. The animation explains why it matters and how it was built.

Style: clean and editorial, white background, near black text (#14181d), muted gray for secondary text (#515a66), system sans serif. Four accent colors, each always meaning the same thing: green #1f6f4a is code, purple #5b3fa3 is Apollo, amber #8a4b08 is Claude, blue #2b4fa3 is the rep. Large type, generous space, few words on screen at once. Motion: smooth eases, elements drawing in, counting up, sliding into place, connecting lines that draw themselves. Calm, never bouncy. No stock icons of people, no emojis, no logos.

Scene 1, 0:00 to 0:33, "What it changes for the team"
- An enablement document appears, full of rules, and a clock reads 9:00. Five app windows (Salesforce, Apollo, Gong, Support, Slack) scatter around a small rep figure, showing the scramble.
- The windows collapse into one clean Slack message titled "Your plan for today".
- Three outcomes build in one at a time: "The first hour goes to calls", "Every touch stands on a dated fact" (show a small card reading: Hiring a Director, Sales Strategy & Operations, posted Oct 30), "The CRM gets better every day" (a Salesforce field ticks from blank to "Readiness B").

Scene 2, 0:33 to 1:05, "Who decides what"
- A pipeline draws left to right, seven connected steps, each colored by who owns it: Rep: /plan in Slack. Code: read Salesforce. Apollo: company data, job postings, news. Code: rank and qualify. Claude: write openers and emails. Code: check every email. Rep: tick and Apply.
- Label the code steps "a rule in code is a guarantee" and the Claude step "writes the words only".
- A data card slides in showing what the model sees: an account block with "Why now", dated facts each tagged with its source, and a contact shown as a token [[P6]] instead of a name. The token glows to show names never reach the model.
- A small purple side note: "Apollo's MCP server: wired in for people search".

Scene 3, 1:05 to 1:35, "Where I did not trust AI"
- A stream of draft emails flows from the Claude step into a green checkpoint gate. Most pass. One is stopped with the label "5 word subject, limit is 4". Another is stopped: "pitches on bad news".
- The gate itself gets a small repair: a red mark "misread 'Thanks for reviewing' as a sign off" turns into a green check "test added".
- A sandbox box labeled "background run" contains three script tiles; a fourth tile "Python one liner" bounces off its wall, and a Salesforce icon outside is marked "never writes".
- A row of test lights flips red one by one, then all green: "rules broken on purpose, each caught".

Scene 4, 1:35 to 2:02, "What I assumed, and what I left out"
- Left side, blue, builds as a short list: "Permissions decide scope: runs as the rep", "RevOps owns the ICP, in a file", "Calls and tickets live in Salesforce".
- Right side, red, items appear and are struck through: "Sending email", "Writes without approval", "Stored copies of CRM data", "A model score for ranking".

Scene 5, 2:02 to 2:28, "Before reps depend on it"
- A short road or ladder with five rungs that light up in order: "Names tokenized at the model boundary", "Each Slack user mapped to their own Salesforce login", "An always on host, a plan per rep, a ledger of every run", "Evals from reps' verdicts", "Replies and meetings measured against a holdout".
- End on a calm closing frame from 2:22 to 2:28: "AE Daily Plan", and beneath it "Salesforce · Apollo · Claude · Slack" and "github.com/cbridges006/ae-daily-plan".

Write all on screen text exactly as given above; do not add claims, numbers or company names that are not here.
