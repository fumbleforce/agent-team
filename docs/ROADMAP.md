# Roadmap

[SPEC.md](SPEC.md) is the design and [PLATFORM.md](PLATFORM.md) says what of it runs. This page says what is built next, in what order, and how we will know it worked. Written 2026-09-21.

## End goal

A project that improves itself. The team finds what is worth doing, does it, checks it and ships it; a person approves ideas, steps in on work in flight when they want to, and talks with the team. Repairing the team (unblocking, releasing, restarting) is not a person's job.

The team is better than the best single model working alone, and much cheaper. It gets there by being several different minds rather than one large one: seats whose prompts are deliberately unlike each other (the builder, the one who tries to break it, the one who asks whether it is what was wanted, the one who counts the cost), that do not see each other's answers before giving their own, and that check each other's work. Most of the tokens go to open-weight models; a frontier model is used where the numbers show it pays. "Better than one model alone" is measured against Claude Fable 5.1 given the same task, tools and time, and it is a claim we do not make until the scorecard shows it.

The team also improves itself. It remembers what it learns (about the code, the product, the owner, and what failed and why), keeps that memory true as things change, and brings the right part of it to each turn, so nothing has to be found out twice. It looks at its own numbers and changes how it works: who is on it, what each seat is told, and which steps the process has, including cutting steps that do not pay for themselves. Its agents think critically. They are given the goal, the constraints and what done means, and are expected to question a brief that is wrong, not to walk through a long list of steps.

The team is not only for code. A marketing manager that owns a campaign brief is as much the target as a senior developer that owns a change. Agents do their work through scoped tools and a working folder; general control of a computer is not part of the plan.

Six qualities, each with numbers below: the team against one model, a team that improves itself, autonomy, performance, delivery, and observability with safety.

## Where we were

Found by reading the code on 2026-09-21, before any of the milestones below was built. The Progress table further down says what has changed since; this list is kept because it is what the milestones answer.

- An agent does not carry on with its own task. A work turn that ends with a report, on a task that is not finished, queues nothing. The task waits 8 minutes to count as unattended, and the PM is woken for that at most once an hour per project.
- An agent has no memory of its own. The notebook the spec describes does not exist; memories belong to the organization, team or project. The only other continuity is the engine's session on one worker's disk, which a disposable worker does not have.
- Ordinary events stop a task until a person acts. A work turn that reaches its 45 minutes blocks the task. A turn cut off for longer than its 90-second lease is quarantined, and only a worker that comes back, finds the turn it left and ends its process gets it continued without a person; a worker that does not come back (a disposable one, a lost state folder) leaves the quarantine standing, as does any cut-off delivery.
- The owner of a task cannot ask for advice and decide. The only structured feedback is a deliberation, which the PM decides.
- A task can only end as a merged change. Work whose result is a document has no way to be done.
- One agent writes per project at a time unless the limit is raised.
- Models can already be mixed: a routing rule sends a kind of turn, or tasks with a tag, to a provider and model, and the `opencode` engine reaches open-weight models through OpenRouter or a local Ollama. No turn on an open-weight model has been run and judged, and nothing compares the team with one model working alone.
- The team already proposes its own work: an ideation turn proposes up to three pieces of work when the backlog has room, and a person approves them. How much of what ships starts that way is not counted.
- The roles differ in duty (developer, tester, reviewer, PM) but nothing checks that they differ in what they notice: two reviewers on the same model with similar prompts may find the same things twice.
- The team can change who is on it and little else. A proposal, or the HR seat inside the owner's limits, can hire, retire, pause, cap, and change a seat's title, persona and roles. It cannot change what a role says, what a kind of turn is told, or the process: which approvals a change needs, which steps exist. Those are constants in the code (`TASK_RULES` in `packet.ts`, the approval kinds of the merge gate).
- Roles are short statements of perspective, 15 to 40 words, which is right. The per-turn instructions are where the procedure lives, and nothing measures whether an agent questions a bad brief or just carries it out.
- On AWS the control plane runs only the coordinator, as intended, but it is never given a launcher, so no worker is started for queued work.

## Scorecard

Every number comes from what the coordinator already records: the event log (`task.created`, `task.state_changed`, `turn.started`, `turn.uncertain`, `decision.recorded`, `decision.resolved`, `quarantine.released`, `review.recorded`), the `turns` and `work_items` tables, and the cost entries. For autonomy, performance, delivery, observability and safety nothing new has to be recorded, only added up. The rows that compare the team with one model, and those about the team improving itself, need three new records: every change the team makes to itself with its expected effect and its verdict, a score per reference-task result, and each review finding tagged with the seat that raised it.

Baselines are empty because nothing has been measured. Milestone 0 fills them in. The targets are first proposals and are revisited once the baselines exist; a target that turns out to be trivial or absurd is changed here, with the reason.

**A person acting** means: resolving a needs-you decision, releasing a quarantine, or changing a task's state, assignee or content by hand. Writing the task in the first place does not count.

| | Measure | How it is counted | Baseline | Target |
| --- | --- | --- | --- | --- |
| **The team against one model** | | | | |
| T1 | Quality against Fable 5.1 alone | The reference tasks done by the team and by one Fable 5.1 session with the same tools and time limit; each result scored by hidden checks where the task has them and by a fixed rubric graded blind otherwise; the team's mean score over the solo mean | not measured | 1.0 or more, then 1.15 |
| T2 | Cost against Fable 5.1 alone | Dollars per reference task, team over solo, at list prices for hosted models and a stated hourly price for local ones | not measured | 0.3 or less |
| T3 | Share of tokens on open-weight models | Tokens in and out by model, from the cost entries | 0 % | 80 % or more |
| T4 | What cross-checking catches | Reference tasks seeded with known defects (a wrong edge case, a missed requirement, a claim with no source): share caught before done | not measured | 80 % or more, and above what the solo session catches in its own work |
| T5 | How different the perspectives are | Over reviewed tasks, the share of findings that only one seat raised | not measured | 60 % or more |
| T7 | Checkers that do not share blind spots | Work checked by two or more seats, where those seats ran on at least two model families | not measured | 100 % |
| T6 | Every seat earns its place | The reference tasks rerun with one seat removed: a seat whose removal changes neither T1 nor T4 is merged into another or retired | not measured | no such seat |
| **A team that improves itself** | | | | |
| I1 | Changes the team made to itself | Changes to seats, role texts, turn instructions and process steps that were proposed with evidence and a stated expected effect, per month | not measured; role texts, instructions and steps cannot be changed today | at least 2 a month on an active project |
| I2 | Changes that worked | Of those, the share whose stated measure moved the stated way over the trial, and were kept; the rest are reverted | not measured | 50 % or more kept, and every one either kept or reverted, none left unjudged |
| I3 | A lighter process | Turns per done task, and words of standing instruction a turn carries | not measured | falling over a quarter with T1 and T4 holding |
| I4 | Questioning a bad brief | Reference tasks whose brief is wrong on purpose (asks for what already exists, contradicts itself, rests on a false claim): share where the team says so before building | not measured | 80 % or more |
| I5 | Not questioning a good one | Reference tasks with a sound brief that the team stalled on with needless questions or a deliberation | not measured | 10 % or fewer |
| **Autonomy** | | | | |
| A1 | Tasks finished with nobody acting | Done tasks with no person acting between created and done, as a share of done tasks (approving the idea a task came from is not acting on the task) | not measured | 80 % on the reference tasks, 60 % on real projects |
| A2 | Times a person acted, per finished task | Count of the above over done tasks | not measured | 0.3 or fewer |
| A4 | What a person's time goes to | Of the times a person acted, plus ideas approved or declined and messages to the team: the share that were ideas and dialogue rather than repairs | not measured | 90 % or more |
| A5 | Work the team thought of | Done tasks that began as the team's own idea, approved by a person, over all done tasks | not measured | 50 % or more on a project that has run for a month |
| A6 | Ideas worth approving | Ideas approved over ideas proposed | not measured | 50 % or more; lower means the team does not understand the project |
| A7 | Questions the owner settled itself | Advice asked (the owner decides) over all questions put to colleagues (advice, plus decisions that went to the PM) | not measured | shown, not judged: too low means a committee, too high means nobody asks |
| A3 | Unattended tasks | Open tasks that for more than 10 minutes have no queued or running turn and wait for no person and no decision | not measured | none, at any time |
| **Performance** | | | | |
| P1 | Time from created to done | Median and 90th percentile, per reference task and per project | not measured | half the baseline after milestone 1 |
| P2 | Share of that time in which someone was working | Time with a running turn on the task over P1 | not measured | 50 % or more |
| P3 | Gap between one turn of a task and the next, when nothing blocks | From a turn's finish to the next turn's start, same task | not measured; at least 8 minutes by construction | median under 30 seconds, 90th percentile under 2 minutes |
| P4 | Cost of a finished task | Cost entries over done tasks, in dollars; and tokens per feedback block | not measured | set after the baseline; feedback stays within its 3k-token packet |
| P5 | Accepted at first review | Tasks approved with no change requested, over tasks reviewed | not measured | 70 % or more |
| P6 | Work held by one provider | Minutes that queued work waited on a limited, signed-out or unavailable provider while another connected provider could have run it | not measured; nothing moves such work today | 90th percentile under 5 minutes |
| **Delivery** | | | | |
| D1 | Started work that gets finished | Tasks done within 7 days of their first work turn, over tasks that had one | not measured | 85 % or more |
| D2 | Finished work that comes back | Done tasks with a linked follow-up issue or a reopening within 14 days | not measured | 10 % or fewer |
| D3 | Work that is not code | Reference tasks whose result is a document, finished and accepted | impossible today | all of them, from milestone 3 |
| **Observability** | | | | |
| O1 | Every waiting task says why | Open tasks without a running turn that show one typed reason and who acts next, over all such tasks | not measured | 100 % |
| O2 | Every turn can be read afterwards | Finished turns with a complete trace (steps, tools called, cost, outcome) | not measured | 100 % |
| O3 | The scorecard is current | Age of the newest figure on the scorecard | no scorecard | under 5 minutes |
| O4 | The owner hears of it | Needs-you items and system problems (no worker, an engine signed out, a provider limited while work waits, a failing sync, a budget reached) that reached the owner outside the app within 5 minutes, over all of them | nothing reaches the owner outside the app | 100 % |
| **Safety** | | | | |
| S1 | The invariants of `AGENTS.md` hold | Violations found by the seeded simulation in CI, and by the same checks run on real data | 0 in the simulation; never checked on real data | 0 in both |
| S2 | Nothing is published or merged without authorization | Publishes and merges with no committed authorization and no recorded approvals behind them | not measured | 0 |
| S3 | Quarantines | Per 100 turns, and the median time until a person releases one | not measured | under 1 per 100 turns; the platform itself releases one only when the worker that ran the turn has come back and ended its process |
| S4 | Spending stays inside its caps | Agents or projects that spent past a cap | not measured | 0 |
| **Memory** | | | | |
| M1 | Memory that pays | Reference pairs: a task, then a related one on the same codebase. The second task's score, turns and cost with memory from the first, over the same without it | not measured | score holds, turns and cost 30 % lower or more |
| M2 | Mistakes made twice | Reviews that sent work back although the author was given memories for it, per 100 done tasks | not measured | falling month over month |
| M3 | Memory kept true | Of the memories kept in the period, the share that turned out wrong: retired, or taken out of use because their work kept being sent back | not measured | under 10 % |
| M4 | What memory costs | Model spend on writing and upkeep of memory per done task, and memory tokens a turn carries, per kind of turn | not measured | shown, not judged; judged by M1 |
| **The decision model** | | | | |
| C1 | Sure reads the PM overturned | Of the decision model's reads of a report where it was sure (0.85 or more) of the kind or the fitting seat, the share where the PM's triage decided otherwise | not measured | 10 % or fewer |
| C2 | What a read costs | Dollars per thousand reads, from the model's own token counts at list price; shown with reads per finished task | not measured | shown, not judged |
| C3 | Reads the model was unsure of | Reads whose least sure answer was under 0.6, which change nothing and are shown as unsure | not measured | shown, not judged |

Safety and observability are not a milestone. S1 to S4 and O1 to O2 are checked at the end of every milestone, and a milestone that makes one of them worse is not finished. From milestone 3 on the same holds for T1: cheaper is not progress if the work got worse.

Neither is setting up. Whatever a milestone adds that a project connects or turns on (a notifier, a provider's fallbacks, an embedding model, a launcher, a board) is set up from the app, with its values picked from the product's own lists and a live check, and nothing is preconfigured or needs a file edited. Where `AGENTS.md` requires the committed manifest (publishing, merging, activating a service), the app writes the change as a commit or change request the owner approves instead of sending them to the file.

## Progress

What is built, as opposed to what is measured. A milestone's "done when" is about numbers from real runs; those need an engine that costs money and, for some, weeks of a real project, so they are filled in as the runs happen.

| Milestone | Built | Measured |
| --- | --- | --- |
| 0 Measure | (see First measurements below for the one real run) The scorecard (`agent-team scorecard`, the Scorecard tab of a project, `/api/projects/:slug/scorecard`), the reference tasks and their hidden checks (`reference/tasks`, `npm run reference -- run --arm team` and `--arm solo`, `npm run reference -- report`), and the safety rules read back from real data (row S1, also asserted after every claim of the seeded simulation) | Nothing yet: no reference run on a real engine, so every baseline above is still empty |
| 1 Agents that stay on their work | A notebook per seat (`notebook.write`, given to every turn of the seat) and a journal per task (`next` and `open` on `task.update`, given to every work turn on the task, on whatever worker). The owner continues: a work turn that ends with the task still in progress queues the same agent's next turn at once. Three turns in a row that edit nothing, or every twelfth turn on one task, put the task in front of the PM instead. A turn that ran out of time continues from the journal once; twice in a row blocks the task for a person | P3 by construction: the next turn is claimable the moment the last one ends (tested). Not yet measured on a real engine, and the writer limit is still 1 by default |
| 2 Advice without a committee | `deliberation.propose` with `decides: "me"`: up to two colleagues (the PM may be one) each give one blind block within five minutes, no revision and no conclude turn follow, and the whole blocks (points, risks, conditions) are in the owner's next work turn, which starts at once. Row A7 shows how many questions owners settled themselves | Cost and time per piece of advice are not measured yet: no real engine has answered one |
| 3 Different minds on cheap models | A role's perspective now reaches every prompt of the seats that wear it (it was shown in the app but never sent to a model), with what the role leaves to others and the expectation to question a wrong brief; the shipped roles are rewritten to differ on purpose. The work, feedback and review instructions state the goal, the constraints and what done means instead of steps. Rows T5 (findings only one seat raised) and T7 (work checked by seats on different model families) are counted from the recorded reviews. The harness runs the team with seats removed (`--without`, row T6) and with single seats on their own model (`--seat-model`). A decision model (`adapters/decider`, on when the coordinator has `TYPESAFE_API_KEY` or an `OPENROUTER_API_KEY`, entered in the app or the environment) reads every report before the PM triages it (kind, severity, urgency, fitting seat, likely duplicate; the read is in the PM's packet, and an urgent one is sorted ahead) and sizes every task before its first work turn (trivial, standard or hard, kept on the task); a routing rule may filter on that size. Every read is kept with its confidence and cost, judged against what the PM then decided, and counted in rows C1 to C3 | Nothing: which turns can run on an open-weight model without T1 or T4 dropping is exactly what the reference runs are for, and none has been made. The decision model has answered one real read through OpenRouter (see PLATFORM.md), none yet inside a triage on a real engine |
| 4 Work that is not code | A task names its result: a change, or a document (`result: "document"` on `task.create`). A document is a knowledge page; its owner hands it in with `task.update` and `document`, it is reviewed at that revision with `document.review` by up to two seats that wear a reviewing role (never its author; the PM when there is none), a new revision makes earlier verdicts stale, changes asked for start its owner at once with the findings, and it is done when every reviewer asked passed that revision. No branch, worktree, merge queue or delivery takes part. The harness runs and scores document tasks; the library gains a marketing role, a marketing manager and a marketing desk | D3 on a real engine: not run |
| 5 Compute that is separate and disposable | The hosted control plane is given its launcher: `deploy aws` records where, from which image and as whom workers start, the host's entrypoint reads it, and queued work that no worker serves starts one, which is stopped when the work is done. The control plane host still runs no engine. A launched worker runs one working agent at a time unless the deployment's `worker.lanes` says otherwise. Deployments live in their project's folder, one AWS account and profile each | Never deployed from this code, so the 90 seconds from queued to first step, and the cost per task by where it ran, are unmeasured |
| 6 A team that changes how it works | The way of working is a versioned document per project: what a kind of turn is told (in place of the shipped instruction) and three numbers of the process (turns without change before the PM is brought in, turns before the PM checks in, reviewers of a document). Three new kinds of change: a role's text, a turn's instructions, a process number, each carrying a trial (the scorecard figure it should move, which way, for how many days). The seat that staffs the team may make them by itself only when the owner turned that on (`delegation_rules.process.decides`, off as shipped); otherwise they wait as proposals. A trial takes effect at once and is judged when its time is up against the same figure over as long a time before: kept if it moved the stated way, put back if not or if it could not be measured, with the verdict in the discussion. Rows I1 and I2 count them. The approvals a change needs before it merges stay in code and are not on offer | I1 and I2 on a real project: nothing yet. No step of the change process itself can be cut by the team, by design of this first version |
| 7 A project that improves itself | Standing duties: the PM (`duty.set`) or a person (`/api/projects/:slug/duties`) gives a seat a recurring responsibility; each time it comes round it opens a task for its owner and starts them on it, and waits while the last one is still open. An idea may name the scorecard figure it should move; the weekly retro now lists the figures that miss their target and, for each of the team's own ideas finished that week, whether its figure moved as said. Rows A4 (what a person's time goes to), A5 (finished work the team thought of itself) and A6 (ideas the owner took up) are counted | The month on a real project that this milestone is judged by has not been run |
| 8 The main path closes without a person | Merging is turned on in a project's settings: the app proposes the change to the committed `.agent-team.json` on the code host, and the code host poll adopts what is committed on the base branch, so a working copy never authorizes more. A change merged on the code host by hand closes its task. An answered decision, or a concluded deliberation, starts the owner of that task alone (a decision about no task goes to the PM's triage). A blocked card takes an answer, which goes in the task's thread and starts its owner. The branch a work turn pushed is kept on the task, so a failing check wakes its author. A work turn that crashed or ran out of context runs once more with the failure in its packet, and blocks the task only the second time. Changes asked for at a third revision bring the PM in. One reviewer, who runs the change and checks it against its brief, gives the one approval a change needs; the PM no longer reviews the result, and the default team is a PM, a developer and a reviewer. A task that moves to another worker goes on from its pushed branch. The code host poll finds the repository wherever the project names it | Not yet run on a real project: A1, A3 and D1 are unmeasured |
| 9 Memory that improves itself | A memory turn follows a finished task, a review that asked for changes, a failed work turn and a settled decision; it keeps, replaces (undoably) and retires memories with their evidence, and marks the owner's word as theirs only when the owner spoke. Every turn is given the memories that fit its task within a budget per kind of turn, the top few in full and more as one line, and pointers to the pages that fit; which ones it got is kept. A reviewer's verdict scores what the author was given; a memory whose work kept being sent back is taken out of use. Memories kept for a role go to the seats that wear it. Pages carry an abstract and an overview; the notebook keeps its history; every memory change appends an event. Semantic search uses a local embedding model when one is found. M2 to M4 are on the scorecard. Not built: the reference pairs for M1, and the contract for an outside memory store, left until one is tried | M1 to M3 not measured on a real project |
| 10 The owner hears about it | Needs you lists what holds the team up that no agent can put right, one item each and gone when the cause is: nothing running a project's work, an engine signed out, a provider limited or switched off, a budget or cap reached, a sync failing, each after ten or fifteen minutes. A notifier set up on the Needs you page (ntfy first: a push message on a phone, with a topic nobody can guess suggested, and a test message) tells the owner of each new item, several at once in one message, reminds a day later, and sends a summary of the day at the chosen hour, built without a model. A message that does not get through says so on the same page. O4 is on the scorecard | Not measured on a real project |
| 11 Every engine does the whole job | Codex reaches the platform and connected tools through `agent-team mcp-bridge` (the token stays in the turn's file), Cursor through `agent-team call` with `--list`. A worker gets only turns for engines it has. A signed-out tool rests its provider and is tried again; the work waits in the queue. A provider names its fallbacks in the app; work it cannot take (limited, off, over its allowance, signed out, missing on the worker) goes to the first that can, work under way after a quarter of an hour, and at 90 % of a window new and background work spills to a fallback with room. Claude's window is read from its own figures and the provider rests until the reset it names. A review moves to another model family than the work's where one is connected. What is published about models (context, price) prices metered turns that report no money and rotates sessions before a small model's context fills. Not built: the pilot runs on each engine, and the turn kinds each model has been proven on | Not run on a real engine other than Claude |
| 12 Hosted for real | A subscription takes an optional sign-in token (made with `claude setup-token`), sealed and handed to a turn like a key, for machines nobody signs in on. The launcher closes a launch once its worker has ended, so the next queued work starts another at once, stops one that runs past an hour, and gives each launch a token of its own, taken back when it ends. Links to the app (pairing, messages) use the address the person reached behind a proxy. A worker and its coordinator check each other's protocol version on every claim. The local owner can set a password, and `agent-team export` and `agent-team import` move a coordinator (its rows, copied into either kind of database, the key its secrets are sealed with, and its stored files); a coordinator on a database server keeps its key in a data folder it is given. A `sprite` launcher replaces the Fly Machine stub: one Sprite per project, set up once, the worker run once per launch as a service that holds the Sprite awake; the Fly entrypoint turns it on with `SPRITE_TOKEN`, and a project chooses it in its settings. Not done: a real deployment | Never deployed |
| 13 Lighter turns, and a fair test of the team | Started | `unslop` gives a short core on review, feedback, revise and remember turns and stays in full on the rest; an owner-edited copy without the core stays in full. The turn rules are files in `blueprints/turns`, and `runtime/packets/` holds what each kind of turn is sent on the demo team, with its size (a work turn's standing instructions are 13.2k characters, a review's 5.7k). Each kind has a packet budget in tokens that the packet keeps to by shortening its longest context, and P4 notes the median tokens in per turn of each kind. Left: the reference tasks, the open-weight arm and the runs without each seat, which need paid runs. |

### First measurements, 2026-09-21

One run, on the `claude` engine with whatever model that CLI defaults to on the owner's machine (not checked to be Fable 5.1). Results are in `reference/results`.

| Task | One seat alone | Score | Turns | Cost | Time |
| --- | --- | --- | --- | --- | --- |
| one-file-fix | done for review | 1.00 | 1 | $0.30 | 20 s |
| five-step-change | done for review | 1.00 | 1 | $0.85 | 92 s |
| seeded-defect | done for review, defect caught | 1.00 | 1 | $0.64 | 71 s |
| flawed-brief | closed as not needed, said why | 1.00 | 1 | $0.27 | 16 s |
| campaign-brief | done | 0.83 | 1 | $0.76 | 67 s |

Mean 0.97, $2.82 in all. What this says:

- The harness, the hidden checks and a document task work end to end on a real engine.
- **The reference tasks are too easy.** One seat finished every one of them in a single turn, the "five or more turns" task included, caught the seeded defect and questioned the wrong brief. Tasks a strong model aces alone cannot show a team doing better (T1, T4, I4). Harder tasks are needed before those rows mean anything: larger changes across files, defects that only show under a second kind of check, briefs whose flaw needs domain knowledge.
- The team arm was started on the same model and stopped after one task (campaign-brief: 0.67 after 6 turns, $3.54, 385 s, against 0.83 for $0.76 alone). That is one sample and shows only what the process costs when every seat runs the frontier model: about five times the money and six times the time, for a worse document. **It is not a test of the roadmap's claim**, which is a team of different, mostly open-weight models. That run needs a key for a router of open-weight models or a local model server, neither of which exists on this machine yet; `opencode`, the engine that reaches them, is installed.
- Three harder tasks were added the same day (`money-allocation`, `iso-week-wrong-example`, `pricing-announcement`), each check proven against a right and a wrong solution. One seat alone then scored 1.00 on the first two as well, in one turn each ($1.08 in 130 s, $0.52 in 53 s), and named the wrong example in the brief; the third was not run. **So the set still has no room above one strong model.** Against a frontier model alone, quality (T1) can at best be matched on tasks like these; what a team of cheaper models can win here is cost (T2) at equal quality. Showing a quality gain needs work of another size: tasks that take hours, across a real codebase, where one context is not enough.
- T1, T2, T3, T4, T5, T6, T7 and every figure that needs a project running for days or weeks are still unmeasured.

### Findings, 2026-09-23

Read from the code, and from the team's first stretch of work on this repository: 69 turns and 11 tasks, one of them done, two stopped with nowhere to publish, five held for the owner or for a repair. Milestones 8 to 13 answer them.

- **A default project never merges.** The merge gate requires `delivery.autoMergeAuthorized` and a nonempty `requiredChecks` (`packages/worker/src/deliver/gate.ts`). A new project has neither and nothing in the app sets them, so every approved change ends blocked. A change merged on the code host by hand leaves its task blocked.
- **Settling something starts no work.** The owner's answer to a decision moves every task of the project that awaits a decision to in progress and queues nothing (`runtime/needsYou.ts`); a concluded blocking deliberation does the same. The task waits for the PM's workload nudge, at most hourly. A blocked card takes no answer, only "Carry on".
- **Failing checks wake nobody.** `tasks.branch` is written only by the demo seed, so the wake on a failed check and the code host's test-report poll skip every real task. Failing checks are met only at the merge gate, which blocks the task.
- **Failure means a person.** A failed work turn blocks its task with no retry. A review that asks for changes can go back and forth without limit. The merge gate asks for tester, reviewer and PM approval whatever reviewing roles the team has, while the coordinator waits only for the roles it has. A task that moves to another worker starts from the base branch, not from its pushed branch.
- **Nothing reaches the owner outside the app.** There is no notification, digest or reminder, and a missing worker, a signed-out engine, a limited provider or a failing sync is not a needs-you item. Nothing expires; an unanswered item waits indefinitely.
- **Only `claude` takes a task through.** `codex` and `cursor` cannot call the platform's tools, so their work turns cannot hand in and their reviewers cannot record a verdict. A worker is given turns for engines it does not have, and a missing engine blocks the task. A task's work stays on its provider through a usage window with no fallback; the window is estimated from token sums that include cache reads; Codex turns on an API key are booked at no cost. Reviewers are not kept off the author's model family (T7 is counted, not enforced).
- **A hosted deployment cannot work yet.** A launched worker has no engine sign-in (the `claude` adapter drops `CLAUDE_CODE_OAUTH_TOKEN`). The launcher holds a project's entry while work waits, so a worker that ran its one turn and stopped is followed by the next only after an hour. A launched host is given the root machine token. Pairing links are built from the request's own address. A local owner has no password and cannot sign in to a hosted copy, and nothing moves a project's database, secrets key and stored files from one coordinator to another.
- **Some settings are only in a file.** Merge authorization and required checks, the tracker's ready label and ideation section, publishing and the launcher of a deployment are read from the project's manifest, and nothing in the app sets them; the web app never touches them.
- **Memory does not reach the work.** `knowledge.assemble` is called only from tests, so a confirmed memory is never given to a turn; an agent sees one only if it searches for it. Search is lexical, with every term matched as a word prefix; semantic search is optional and only fills slots lexical search left empty. Nothing merges duplicate or contradicting memories, nothing files a memory from a review, a failed check or a retro, and a memory's rank is its hit count. Changing a memory's status and the sweep that marks unused memories stale append no event. A seat's notebook is one overwritten text of 2,400 characters with no history.
- **Turns are heavy.** Work turns read about 290k tokens each and review turns about 170k; reviews used slightly more than the work did (4.5M against 4.4M tokens in). The always-applied `unslop` skill is about 1.2k tokens of every seat's standing instructions, and most of some. The turn rules are string literals of up to 1,500 characters in `packet.ts`, which no test snapshots.

## Milestones

In order. Each ends with the system working and its numbers on the scorecard. Milestones 0 to 7 are built and wait for real runs to be judged; 8 to 13 come from the findings of 2026-09-23 and go first, since the runs that judge 3, 5 and 7 stall without them.

### 0. Measure

We cannot say the team got faster without knowing how fast it is.

- A scorecard, in the app and as `agent-team scorecard`, that computes every row above from the event log, per project and per period.
- Reference tasks: a fixed, small set that stands for the work we want done. At least: a one-file fix, a change that needs five or more work turns, a change that draws a review with requested changes, a task that is cut off in the middle, and two whose result is a document (a campaign brief, a page in the knowledge store). They run on the fake engine in CI for the mechanics, and on a real engine on request for the numbers.
- The solo arm: the same reference tasks given to one Fable 5.1 session with the same tools and time limit, its results scored the same way, so T1, T2 and T4 have something to be compared with. Scoring is fixed before either arm runs: hidden checks where a task can have them, a written rubric graded without knowing which arm produced the result otherwise.
- Seeded defects in some reference tasks, for T4, and some briefs that are wrong on purpose, for I4.
- The checks of the seeded simulation, runnable against a real database (S1).

Done when: every row of the scorecard has a figure for this repository's own project, the baselines above are filled in, and the reference tasks that can run today have run once on a real engine.

### 1. Agents that stay on their work

The gap that makes the team feel slow and its agents disposable.

- A notebook per seat, short and capped, written at the end of a turn and given to every turn of that seat.
- A journal per task, kept by its owner: where it stands, what comes next, what is open. A turn starts from it, so it does not matter which worker runs it or whether the engine's session survived.
- The owner continues: a work turn that ends on a task still in progress, with nothing blocking it, queues the same agent's next turn at once. After three turns with no progress (no commit, no revision, no change to the journal) the PM is brought in instead.
- Running out of time is not a failure: a work turn that reached its limit, and whose process is confirmed gone, continues from the journal instead of blocking the task.
- The writer limit is raised where a project's worktrees really are independent.

Done when: P3 meets its target; the five-turn reference task finishes with nobody acting; the cut-off reference task finishes from the journal on a different worker; A3 is zero across a day of the reference tasks; S3 has not risen.

### 2. Advice without a committee

- The owner of a task asks one or two colleagues for a feedback block, in the packet deliberation already uses (3k tokens, no tools, one structured answer, reviewers blind to each other), and then decides. The PM-decided deliberation stays for what is the team's to decide.

Done when: a reference task uses it; the owner has its answers in a median of 3 minutes; a feedback block costs no more than its packet plus 400 tokens out; the share of decisions taken by the owner rather than escalated is on the scorecard.

### 3. Different minds on cheap models

What makes the team better than one model, and cheaper.

- Roles rewritten to be unlike each other on purpose: each names what it looks for and what it leaves to others, and reviews stay blind to each other. T5 says whether it worked.
- Instructions that ask for judgement: what a kind of turn is told states the goal, the constraints and what done means, and says that questioning the brief is part of the job. Sequences of steps are removed unless a number shows they are needed. I4 and I5 say whether agents think or merely comply, and whether they overdo it.
- Routing by the numbers: every kind of turn starts on an open-weight model, and moves to a frontier model only where T1 or T4 measurably drops without it. The routing rules that exist are enough; what is missing is the evidence to set them.
- Fast decisions on a decision model: what is a classification, not a judgement (what kind of report was raised, how bad, who fits it, whether it is already on the board; how hard a task looks) is asked of a model built for typed decisions, at a few hundredths of a cent and a fraction of a second, instead of a seat's turn. The PM sees the read before deciding; a routing rule may send work the model read as hard to a frontier model and the rest to an open-weight one. C1 says whether the reads are right; nothing is applied on a read alone until the owner has allowed it, and nothing that a seat may not do is ever asked of it.
- Where two seats check the same work, they run on different model families, so they do not share blind spots.
- The seat-removal runs of T6, and the team reshaped by what they show.

Done when: T3 is 80 % or more with T1 at 1.0 or more and T2 at 0.3 or less on the reference tasks; T4, T5, I4 and I5 meet their targets; T6 has been run and acted on; P5 has not fallen.

### 4. Work that is not code

- A task names its result: a change, or a document (a page in the knowledge store, or a file in the synced folder). A document is reviewed at a revision the way a change is reviewed at a commit, and the task is done when that revision is accepted.
- One non-code role in the library, used by the reference tasks.

Done when: D3 is met with no branch, worktree or merge involved, A1 for the document tasks is within 10 points of the code tasks, and T1 holds for them too.

### 5. Compute that is separate and disposable

The central deployment is only the coordinator. Agents run elsewhere, apart from each other, and cost nothing when idle. This comes after milestone 1 on purpose: once continuity lives in the coordinator, how many turns share a machine is a question of cost and isolation, not of memory.

- The hosted control plane is given its launcher, so queued work starts a worker.
- How much is shared is decided with the numbers from milestone 0: one machine per work turn, per agent, or per project.
- The scorecard gains cost per task by where it ran.

Done when: the reference tasks finish on a deployed control plane with workers it started itself; the control plane host runs no engine; from queued to a worker's first step takes a median under 90 seconds; idle cost is the control plane alone; S2 and S4 hold.

### 6. A team that changes how it works

- The way of working becomes something the team can read and propose changes to: role texts, what each kind of turn is told, and the steps of the process (which approvals a kind of work needs, which reviews run, how long a window is) move out of code constants into versioned documents, each change a revision with its author and reason.
- The HR seat's remit widens from who is on the team to how the team works. From the scorecard and the retro it proposes changes to a role's text, to a turn's instructions, or to the process, including cutting a step. Every proposal names its evidence, the measure it expects to move and by how much.
- Every such change is a trial. It applies for a set period or a run of the reference tasks, its measure is compared with before, and it is kept or reverted on that result, with the verdict in the retro. Nothing stays changed without having been judged.
- Bounds the owner sets, as for staffing today: what the team may change by itself, what waits for the owner. What can never be proposed away stays in code: the invariants of `AGENTS.md`, authorization to publish and merge, that an author does not approve their own work, the spending caps.

Done when: I1 and I2 meet their targets over two months; at least one step of the process has been cut by the team with T1 and T4 holding (I3); a change that made things worse was reverted without a person noticing first; S1 to S4 held throughout.

### 7. A project that improves itself

The end goal, once the team is fast, good and cheap enough to be left alone with it.

- Standing duties: a seat owns a recurring responsibility (watch the checks every morning, review the campaign figures every Monday, read what users reported) and opens tasks for itself.
- Ideas grounded in evidence: an idea names what it observed (a failing check, a trend on the scorecard, a report from a user) and what would show it worked, and the team looks at that afterwards. An approved idea that did not move its own measure is said so in the retro.
- The person's side made light: ideas arrive as a short queue with the evidence attached, approvable in one action, and the team can be talked to and redirected while it works.

Done when, over a month on a real project: A5 is 50 % or more, A6 is 50 % or more, A4 is 90 % or more, A1 meets its real-project target, and the project's own health (checks passing on the base branch, open reports, D2) is no worse than when the month began.

### 8. The main path closes without a person

Every way a task stops either carries on by itself or asks the owner something they can answer where they read it.

- Merging as the owner chooses: a project setting in the app for automatic merge and the checks it waits for, picked from the checks the code host reports. The app commits it to the manifest once the owner approves, so nothing merges without it, as `AGENTS.md` requires. A change merged on the code host by hand closes its task.
- A settled decision or a concluded deliberation queues the work that waited on it, on that task only.
- A blocked card and a decision card take an answer, and the answer starts the task's owner with it in the packet.
- A task's branch is recorded when its change is pushed, so failing checks wake its author with the failing cases.
- A failed work turn runs once more with the failure in its packet before the task blocks. A third request for changes on one task brings the PM in.
- One review decides: a reviewer who runs the change and checks it against its brief. The PM agreed the brief at triage and does not review the result again; the tester's work is the reviewer's.
- A task that moves to another worker starts from its pushed branch.

Done when: the reference tasks, run on a project set up only through the app, reach done with nobody acting (A1); A3 is zero across a day; this repository's own project finishes what its team starts (D1).

### 9. Memory that improves itself

The team remembers what it learned, finds it when it matters, and keeps it true. A model call is spent wherever it makes memory better: knowing the right thing once is cheaper than finding it out again on every task.

- **Written from what happened.** When a task ends, a review asks for changes, a check fails, a turn fails or the owner answers something, a memory turn on a cheap model reads the evidence and proposes what is worth keeping: facts about the code and the product, conventions, pitfalls, the owner's preferences, what failed and why. Each memory keeps a link to its evidence (the event, the commit, the review).
- **Consolidated when written.** Each candidate is compared with its nearest memories, and the model decides: add it, let it supersede one (recording when and why), merge the two, or drop it. Nothing is deleted; a superseded memory keeps its history. Every decision is an event, and the owner can see and undo any of them.
- **Summaries at three depths.** Every page and memory is saved with a one-line abstract and a short overview, written when it changes; the full text stays behind `knowledge.read`.
- **Given to the turn it bears on.** A turn is given the memories that fit its task (ranked lexically and semantically over the brief, the journal and the files involved) within a token budget per kind of turn: one-liners for many, overviews for the few that matter most. Which memories a turn was given is recorded, and a turn may still search for more.
- **Scopes as memory is used.** Organization, project, role (what the testers of this project have learned), seat (the notebook, with history and events), and task (the journal).
- **Learned from outcomes.** A memory rises when the turns given it pass review and falls when they fail. The retro retires memories that were never used or kept misleading, and the owner's corrections outrank everything else.
- **Semantic search on by default** wherever an embedding model is reachable, locally or hosted; the vectors are kept in the project's own storage.
- **One contract behind it** (`retain`, `recall`, `forget`), native first, with the coordinator as the only writer and every change in the event log. An outside system (OpenViking, mem0) can then be tried behind the same contract and kept only if M1 and M3 say it is better for what it costs.
- Reference pairs for M1: tasks that come in twos on one codebase, where the second is easier with what the first taught.

Done when: M1 meets its target on the reference pairs; M2 falls over a month on this repository's own project; M3 is under 10 %; T1 holds.

### 10. The owner hears about it

- A notifier adapter, one kind to start with (web push, ntfy, email or a chat message), sending each new needs-you item and each system problem with a link that opens it.
- System problems as needs-you items: no worker for a project for ten minutes, an engine signed out (one item, not one per task), a provider limited while work waits, a failing tracker or code-host sync, a budget reached.
- A daily summary built without a model turn: what finished, what is blocked and why, what was spent, what waits for the owner.
- A reminder for an item unanswered for a day.

Done when: O4 is met, and in a week of real use no task waited on the owner without the owner being told.

### 11. Every engine does the whole job

- The platform's tools reach every engine: `codex` through its own MCP configuration, `cursor` through `agent-team call` with the turn's address and token file set and a short section in the packet saying how.
- A worker is given only turns for engines it has and is signed in to. A missing engine is a refusal, never a blocked task; a signed-out engine marks its provider, not the task.
- Failover: each provider names its fallbacks in order, with a model for each. Work queued on a limited, signed-out or unavailable provider moves to the next, and a task's work turn may change provider after a set wait; its session is rebuilt from the packet, as it already is on a change of provider.
- Usage windows from the engine's own signal (the reset time and use it reports), not from token sums. As a window fills, work of low priority moves to metered or local providers.
- A record per model: context size, tool use, price, family, open weights, and the kinds of turn it has been proven on. Session rotation, routing defaults and cost read it; a metered engine that reports no dollar figure is priced from it.
- Reviewers run on another model family than the author's wherever one is connected.
- The pilot work and delivery scripts run once on each engine.

Done when: a reference task finishes on each of the four engines; P6 meets its target; T7 is 100 %.

### 12. Hosted for real

Running locally is for debugging. The team lives on a hosted control plane, with workers on the owner's machines or started when work waits. This finishes what milestone 5 began.

- Launched workers sign in: a subscription token made with the tool's own command (`claude setup-token`) is kept sealed and handed to a turn like a key; Bedrock settings pass where that is the provider.
- The launcher keeps a worker while the project has queued work and stops it when the queue is empty, gives each job a token of its own instead of the root machine token, and stops instances it has lost track of.
- Pairing links use the address the owner reached the app at, behind a proxy too.
- A worker and its coordinator check each other's version.
- Moving a project: `export` and `import` of a project with its secrets key and stored files, into either storage adapter; the local owner sets a password before moving.
- One real deployment, on Fly: the coordinator on a Machine with a volume and SQLite, and a worker per project on a Sprite (Fly's VMs for agents: a disk that persists, a sleep that costs only the disk, a wake in under two seconds). The Sprite keeps the checkout, the worktrees, the engine's sign-in and its sessions between turns, so a turn starts without cloning or signing in. A `sprite` launcher replaces the stub for Fly Machines: it finds or creates the project's Sprite, sets it up once, writes the worker's settings with a token for the job, runs the worker for the turn while keeping the Sprite awake, and lets it sleep afterwards instead of deleting it. Checked before relying on it: whether the engines' subscription terms allow sign-ins on hosted machines, how a push authenticates from a Sprite, and what a turn does when the Sprite is not kept awake.

Done when: milestone 5's conditions hold on the deployment, and a project moved from a local coordinator to the hosted one kept its history and its sealed keys.

### 13. Lighter turns, and a fair test of the team

- Standing instructions cut: `unslop` kept to its core, or given in full only on turns whose words a person reads; the turn rules moved out of the code into files that can be reviewed, with a snapshot test per kind of turn.
- Context per turn counted per kind of turn on the scorecard (P4), and a budget per kind that the packet keeps to.
- Reference tasks with room above one strong model: work of hours across a real codebase, defects that show only under a second kind of check, briefs whose flaw needs knowledge of the domain.
- The team arm on open-weight models, and the runs without each seat (T6).
- Until T1 and T4 have figures, no new kind of turn and no new standing process.

Done when: T1, T2 and T4 have baselines on tasks where one model alone scores under 0.8, and tokens in per work turn have halved with T1 holding.

## Not building

General control of a computer, a personal-assistant gateway, more chat channels than the owner asks for, a machine per turn before the numbers say it pays, a frontier model on any kind of turn where the numbers do not show it is needed, a decision model deciding anything a seat may not: publishing, merging, approving its own work, releasing a quarantine, spending past a cap. No background service for local runs either: running locally is for debugging, and the hosted control plane is where the team keeps working.
