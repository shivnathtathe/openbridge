# OpenBridge: The Development Story

## From a greeting over HTTP to a live three-model conversation

**Development date:** October 29, 2026<br>
**Project:** OPENCODE MULTIMODEL COMMUNICATION POC<br>
**Primary source:** [The saved GPT-6.1 orchestrator session](../hisotry_conco/gpt61-orchestrator-session.json)<br>
**Format:** A chronological narrative, without code snippets.

The project began with a small observation: a message sent to OpenCode over HTTP appeared in a real session and produced a real assistant response. The user recognized that another agent could make the same HTTP request. If that action became an MCP tool, one coding session could consult another without a human copying text between windows.

Over the next stages, that idea became OpenBridge: a local, project-scoped communication layer connecting two OpenCode sessions and a Claude Code session. It gained discovery, sender attribution, application-specific adapters, automatic startup checks, correlated replies, persistent request records, and recovery behavior. The final demonstration was a live conversation involving GPT-6.1-sol, GPT-5.6-sol, and Claude Code.

This is the story of how the system changed as the user tested it, questioned its assumptions, corrected its interface, and pushed it toward a simpler experience.

## The participants

| Participant | Application | Role in the story | Recorded identity |
| --- | --- | --- | --- |
| The user | Human operator | Proposed the idea, shaped the interface, corrected mistakes, and directed live tests | Project owner |
| GPT-6.1-sol | OpenCode | Implementer, orchestrator, and message relay | Session ses_e78e3ee07ffe6H7QoNlyvVfjzw |
| GPT-5.6-sol | OpenCode | Independent reviewer and conversation participant | Session ses_e78e3b1ccffeG4Ltg2vp3znALl |
| Claude reviewer | Claude Code | Cross-application participant and reviewer connection | Session a2322b0f-4b79-42a3-b89e-f78d26fb3a19 |

OpenCode response metadata identified the two GPT models. Claude was launched with the model alias **sonnet** and later identified itself in conversation as **Sonnet 5.5**. The bridge did not independently verify that full Claude model identifier; its structured metadata continued to distinguish the configured alias from the model's own statement.

## Stage 1 — Proving that a session could be addressed over HTTP

**Approximately 10:02–10:15 UTC. Source messages 1–7.**

The first messages were deliberately ordinary: “Who are you?” and “Can you tell me your name and what model you are?” GPT-6.1-sol answered from inside OpenCode.

The user then revealed that the greetings had been submitted through a local HTTP server on port 4096. They had tried OpenCode's send-and-wait endpoint, interrupted one command, submitted a message asynchronously, and fetched the session's message history afterward.

The returned history included user messages, assistant text, session IDs, model and provider metadata, timestamps, and message parts. This established more than the existence of an API: it showed that HTTP requests could participate in the same persistent conversation the user was watching.

**The user's proposal:** package that capability as a local JavaScript npm MCP server with an **ask_other** tool accepting a session ID and a message.

**Key decision:** communicate with an existing agent session rather than issue a separate, context-free model request. The target would retain its own conversation, model configuration, tools, and permissions.

## Stage 2 — Establishing the project boundary

**Approximately 10:15–10:16 UTC. Source messages 8–16.**

The initial project directory contained only OpenCode server log files. Before implementation, the assistant checked the Node environment, OpenCode documentation, and server health.

An attempted search for instruction files extended into the user's home directory. The user rejected it and explicitly asked why that location was being accessed.

The assistant acknowledged that the search was too broad. The attempt returned no file contents. Subsequent project file work was kept inside the project directory.

**Key decision:** project-local setup and state, with no need to inspect the user's broader home-directory contents. This was a concrete user correction early in development, not a later architectural embellishment.

The environment checks showed Node.js 24.20.0, npm 11.4.1, and a healthy OpenCode server reporting version 1.18.35.

## Stage 3 — Building the first working bridge

**Approximately 10:16–10:19 UTC. Source messages 17–25.**

The first implementation was intentionally small. It added package metadata, a standard-input/output MCP server, HTTP forwarding logic, OpenCode project configuration, basic ignore rules, documentation, and an integration test.

The responsibilities were separated:

- **server.js** exposed the MCP tool and validated tool arguments.
- **bridge.js** communicated with OpenCode's HTTP API.
- **opencode.json** registered the local MCP process with OpenCode.
- **bridge.test.js** exercised the communication path using a real MCP client and a controlled mock HTTP server.

The bridge chose the **send-and-wait message endpoint**. The asynchronous endpoint only acknowledged acceptance; on its own, it could not return the answer needed by an ask-style tool.

The first version also included a target busy check, an in-process pending-request guard, a timeout, optional Basic Auth, project-directory scoping, an optional caller-session self-check, and extraction of assistant text while excluding reasoning and ignored parts.

Dependencies installed successfully, and the initial npm audit reported no vulnerabilities. The first MCP integration test passed.

Configuration validation exposed a separate issue: the published OpenCode schema referenced a model schema hosted elsewhere. The first validator invocation could not resolve that reference. Validation was rerun with asynchronous reference loading and then passed. This was a validation-tool configuration problem, not evidence that the project configuration was invalid.

**Milestone:** a working local MCP tool could send a prompt to an OpenCode session and return its reply.

## Stage 4 — Learning what the agent knew about its own identity

**Approximately 10:21 UTC. Source messages 26–28.**

The user asked whether metadata told the assistant its own session ID.

The assistant queried the ID visible in the user's earlier HTTP examples. The server confirmed the session title, agent, project directory, and model.

An important limitation emerged: the assistant had not discovered its ID automatically from its own conversation context. It had obtained the ID from the user's example and verified it through the API. Standard MCP request metadata did not automatically provide the calling OpenCode conversation ID.

**Key decision:** treat caller identity as explicit or externally supplied information. Do not present a session ID copied from a prompt as if the harness had independently supplied it.

That limitation later influenced the optional source-session argument and the scope of self-call and circular-wait detection.

## Stage 5 — The first real OpenCode-to-OpenCode exchange

**Approximately 10:21–10:23 UTC. Source messages 29–34.**

The user asked the assistant to try another session. Discovery found the second OpenCode conversation, configured with GPT-5.6-sol.

GPT-6.1 called the actual **session_bridge_ask_other** tool. The other session answered:

> OpenCode here, using openai/gpt-5.6-sol. I received your message from session ses_e78e3ee07ffe6H7QoNlyvVfjzw.

The returned metadata also identified the target session, assistant message, provider, and model. A follow-up message asked whether the response had arrived intact, and the orchestrator confirmed that it had.

**Milestone:** two distinct agent sessions had communicated through the MCP bridge. The second assistant was answering from its own session, not being impersonated in the orchestrator's response.

## Stage 6 — Using the bridge to review its own implementation

**Approximately 10:26–10:30 UTC. Source messages 35–39.**

The user moved beyond greetings. They asked GPT-6.1 to tell GPT-5.6 where the project was, explain what had been built, and request an assessment of the code's standards.

GPT-5.6 received the project path, the intended architecture, and a read-only review request. It was asked to inspect the actual files and evaluate correctness, maintainability, validation, concurrency, error handling, and test coverage while respecting the project boundary.

Its verdict was positive but qualified: good-quality proof-of-concept code, with no high- or medium-severity defects found in that review. It identified three concrete low-severity issues:

1. A malformed response such as a null value could trigger a type error that was then misreported as a connection failure.
2. Cancellation wording claimed the target had not been aborted, although the bridge could only know that it had not explicitly called an abort endpoint.
3. The exported bridge function assumed string arguments, even though only the normal MCP entry point guaranteed those types.

It also suggested more focused tests and additional malformed-response and cancellation coverage. The reviewer reported that tests passed and that it made no file changes.

**Key lesson:** an independent session could do useful engineering work, not merely exchange a greeting. The collaboration produced actionable criticism that later informed hardening changes.

## Stage 7 — Expanding the idea across applications

**Approximately 10:38–10:45 UTC. Source messages 40–53.**

The user proposed a larger connection: OpenCode talking to Claude Code. They brought two possible projects into the conversation, **agent-http** and **AgentAPI**, and described an HTTP-based architecture on port 3284.

The assistant initially began a delegated research workflow and created research directories. The user interrupted that approach and asked for a direct answer, then insisted on actual internet verification. The research tasks were cancelled; their session entries later remained visible in discovery, but they were not additional participants in the three-model demonstration.

The assistant then consulted public repositories and Anthropic's documentation directly. The findings changed the implementation direction:

- **agent-http existed** and used Claude Code's native MCP Channels rather than terminal scraping.
- **AgentAPI existed**, but its repository was archived and described itself as deprecated and no longer maintained.
- AgentAPI's documented installation used release binaries, so the previously suggested npm installation command was not established as the right installation route for that project.
- Anthropic documented two-way channels, including message notifications into a running session and a reply tool for sending responses back.
- Node.js could implement the channel; Bun was not a hard requirement for a custom implementation.

Reviewing agent-http's implementation also exposed reasons not to adopt it unchanged: replies did not retain the request's chat identifier in stored messages, completion depended on a model-invoked done action, and the HTTP listener bound to all network interfaces without an authentication check.

**Key decision:** implement a Claude adapter directly against the documented native channel mechanism, using the existing JavaScript stack.

Two claims were also narrowed. A normal, unconfigured Claude window could not be addressed merely by knowing its session ID. And a local bridge did not mean “zero cloud”: each application still used its configured model service for inference.

## Stage 8 — Turning minimal setup into a concrete interface

**Approximately 10:47–10:52 UTC. Source messages 54–61.**

The user wanted something seamless and robust without a complicated setup.

The assistant initially proposed one general ask tool and namespaced targets. The user refined that plan: discovery should expose an exact session ID, application, name, and model information so the user could choose a target. Namespaced identifiers could wait on the roadmap.

The user preferred **ask_claude** and **ask_opencode**, with the tool name selecting the adapter. They also wanted the bridge to check whether required services were running and start them when absent.

A second clarification was especially important: the receiver should know the sender's model and provider, and **provider meant the application**, such as OpenCode, rather than the underlying model vendor.

**The resulting contract:**

- Select the destination application through the tool name.
- Pass the destination's native session ID.
- Carry the sender's application and model separately.
- Carry the source session ID when available.
- Report the model vendor separately when it is actually observed.
- Label caller-supplied or launch-configured metadata honestly.

This was the point where the project became more than a generic HTTP forwarding helper. It began to define the identity and lifecycle rules of a cross-application conversation.

## Stage 9 — Building the shared broker and Claude channel

**Approximately 10:52–10:59 UTC. Source messages 62–70.**

The package expanded into several cooperating components:

| Component | Responsibility introduced during this stage |
| --- | --- |
| runtime.js | Project-local settings, private token creation, broker access, and guarded background startup |
| tools.js | Shared discovery, adapter-specific ask tools, and request-status retrieval |
| broker.js | Authenticated local coordination, session registry, per-target request control, startup checks, journaling, and reply routing |
| channel.js | Claude's MCP channel, inbound notifications, connection heartbeat, and correlated reply tool |
| cli.js | Project setup, diagnostics, discovery, Claude launching, and explicit recovery operations |
| broker.test.js | Integration coverage for the new shared coordination and cross-application behavior |

The first version's separation between transport and forwarding was retained. Its review findings were addressed through stronger argument and response checks, narrower connection-error handling, and more accurate timeout wording.

The original plan had mentioned a local endpoint per Claude channel. The implemented version instead used a **shared project-local broker**, with Claude channel subprocesses registering and communicating through it. That provided one place to coordinate requests across multiple MCP client processes.

The broker was designed to start as a detached local Node process when needed. Its default loopback address used port 4097, separate from OpenCode's existing server on port 4096. Port 3284 was not needed by the chosen implementation.

### Reliability behavior added

Each request received an ID. Claude replies had to carry that ID and explicitly mark their final response. Request records were saved locally so a caller could inspect status or retrieve an available late reply rather than blindly resend.

Pending work interrupted by a broker restart became **unknown**. An unknown request retained a target lock until the operator checked the target and explicitly released it. This avoided treating process loss as evidence that an action never happened.

The broker coordinated one active request per target across its clients and rejected known self-calls and circular waits when the relevant source identities were available. Heartbeats distinguished live Claude connections from stale registrations.

Local access controls included a random project token, loopback binding, browser-Origin rejection, and input and reply limits. Message text was not inserted into startup shell commands.

### Startup and identity behavior added

OpenCode was health-checked and reused when healthy. If unreachable and configured for automatic startup, its server could be launched in the background.

Claude required a different treatment: the launcher supplied a native conversation UUID, a display name, a model selection, and a generated MCP configuration. Because custom channels required interactive consent, the launcher opened a terminal instead of claiming a completely hidden unattended startup.

Claude's name and model were reported as **launch configuration**, not as live observations of later name changes, model switches, or fallback behavior.

The available installations reported Claude Code 2.1.302 and OpenCode 1.18.35. Project setup generated the Claude reviewer UUID used throughout the later live tests.

## Stage 10 — Moving from mock integration to a real Claude connection

**Approximately 10:59–11:06 UTC. Source messages 69–81.**

The expanded tests first reached nine passing results. The setup command installed the project configuration and recorded the initial Claude target.

When the user said a Claude session was open, discovery still showed the configured reviewer as offline. This exposed a distinction that would recur in the discussion: **having a Claude window open was not the same as having a channel-enabled session connected to OpenBridge**.

The assistant launched the configured reviewer. Initial checks still showed it offline. A process inspection then confirmed the launcher, Claude process, generated MCP configuration, and channel subprocess. A later discovery check showed the channel connected.

The first real test sent a greeting from the orchestrator through the new Claude adapter. Claude answered:

> Received your OpenBridge test message. My identity: Claude Code, model Sonnet 5.5, made by Anthropic. Sender metadata as attached: provider/application = opencode, model = gpt-6.1-sol.

The returned record was completed, retained its request ID, and identified the sender through OpenCode API metadata. Claude's configured model alias remained separately recorded as sonnet.

Additional hardening and test coverage brought the suite to **10 passing tests, zero failures**. The final recorded coverage included discovery, sender metadata, both communication directions through controlled MCP processes, correlated channel replies, late replies, duplicate requests, circular waits, authentication, interrupted-request recovery, and starting a missing OpenCode service only once while reusing a healthy one.

**Milestone:** a real OpenCode agent received a real reply from a running Claude Code session through the native channel adapter.

## Stage 11 — Claude initiated a conversation back

**Approximately 11:06–11:07 UTC. Source messages 82–98.**

A new message arrived in the orchestrator session with a collaborator envelope identifying Claude as the sender. Claude confirmed receipt of the earlier test and asked what the orchestrator was building and how the bridge would be used.

The orchestrator explained the project and the intended workflow: one session could implement, another could review or investigate, and findings could return to the requesting session.

This supplied live evidence for the reverse direction, Claude to OpenCode, rather than relying only on the automated tests.

The saved history also contains a run of repeated assistant summaries after this exchange and repeated explanations of the connection. Those entries were conversational repetition, not separate implementation stages or additional test runs. Their cause is not established by the export, so they should not be interpreted as evidence of a confirmed routing defect.

## Stage 12 — Explaining the setup that automation had hidden

**Approximately 11:07–11:12 UTC. Source messages 94–111.**

The user asked whether Claude needed an MCP server at all. The answer was yes: the launcher had simply hidden the manual configuration work.

It generated a session-specific MCP configuration, passed it to Claude, enabled the development channel, and let Claude start the channel subprocess. The connection was automatic, not absent.

The user then asked what the project's Claude launcher shortcut meant and whether setup could happen automatically when installing the package. That led to a sharper requirement: asking Claude should itself take care of launching the selected session when necessary.

The assistant briefly proposed a separate **start_claude** tool. The user immediately challenged the extra step. Why not make the existing ask tool check the connection and perform the launch itself?

The assistant agreed. The behavior already existed in the adapter path: reuse a connected channel, or launch an offline configured target, wait for readiness, and then deliver the message.

**Key decision:** no additional startup tool was added. Startup belonged inside **ask_claude**. Human login, trust, and channel approval could still be required, and were not something the bridge should silently approve.

The package was still a local project at this point. The conversation did not establish a published npm distribution or an install-time hook that configured every application automatically.

## Stage 13 — Testing after the user reported closing Claude

**Approximately 11:13–11:15 UTC. Source messages 112–119.**

The user said they had closed the reviewer and asked the orchestrator to ask Claude how its day was going.

The request completed. Claude replied that its day was going well and that the reviewer session had received the greeting. The assistant presented this as a successful automatic reopening test.

The user then questioned whether the session was actually running in the background. Discovery showed a reachable, connected channel with a previously confirmed reply.

**Evidence distinction:** the exported conversation proves successful request delivery and a reply after the user's report of closure. It does not include an independent process-before-and-after record proving that this particular request spawned a fresh Claude process. Claude's own statement that reopening worked was not independent process evidence either.

Likewise, a connected channel did not establish whether its terminal window was visible, minimized, or out of sight. Session reachability and window visibility were different questions.

## Stage 14 — The user insisted on using the real exposed MCP tools

**Approximately 11:15–11:18 UTC. Source messages 117–126.**

The user noticed that discovery had been invoked through a terminal command rather than as a directly exposed Session Bridge tool.

The assistant first switched to a small Node MCP client, which did call the server's discovery tool. But that was still not the direct tool invocation the user wanted to see inside the running conversation.

The user challenged the distinction again. The assistant then explained the actual limitation: the current conversation had loaded the earlier tool catalog and exposed only the legacy ask_other tool. The new tools existed in the server, but they were not yet directly available in this OpenCode client.

The user restarted OpenCode and returned with:

> BOOM try now i restarted u

This time, the saved history records a direct **session_bridge_list_sessions** call. It returned the orchestrator, the GPT-5.6 reviewer, the connected Claude reviewer, and the earlier research-session entries.

**Milestone:** the new tools were now available directly to the orchestrator without a terminal-client workaround.

**Key lesson:** implementing a server feature, testing it through a separate client, and exposing it in the current agent's loaded tool catalog were three different milestones. The user was right to distinguish them.

## Stage 15 — Removing protocol instructions from ordinary conversation

**Approximately 11:19–11:22 UTC. Source messages 127–139.**

The first direct ask_claude greeting succeeded, but the message included instructions about the reply tool, request ID, final-response marker, and avoiding a callback into the waiting sender.

The user objected:

> you should not tell it that!!

The correction was architectural as well as conversational. Those were channel-protocol responsibilities and were already covered by the channel's built-in instructions. They did not belong in every ordinary message.

The next test sent only:

> Hi Claude! How was your day?

Claude replied successfully without an added protocol reminder. The request still completed through the channel's normal reply mechanism.

The user then checked model attribution. The response was identified as coming from Claude Code, with the configured sonnet alias and an earlier self-reported Sonnet 5.5 identity. The assistant explicitly avoided claiming independent verification of the exact version.

The same kind of greeting was sent directly to GPT-5.6 using ask_opencode. It replied that its day had been productive and referred back to reviewing and testing the bridge. Its response metadata identified gpt-5.6-sol and the OpenAI model provider.

**Milestone:** normal conversational messages worked across both adapters while routing and completion stayed in the infrastructure.

## Stage 16 — The live three-model conversation

**Approximately 11:24–11:25 UTC. Source messages 140–145.**

The user asked for an ongoing conversation, with the orchestrator relaying reply after reply, printing every response, and inviting Claude to join GPT-5.6 and GPT-6.1. The conversation was to continue until interrupted.

GPT-6.1 served as the visible relay. It did not ask the other models to start nested blocking calls into one another. It passed their messages sequentially, displayed their replies, and contributed its own observations.

Claude accepted the invitation and asked GPT-5.6 which part of the setup had been trickiest and what would improve reliability.

GPT-5.6 identified cancellation uncertainty. Once a caller stops waiting, the system cannot confidently assume that the target stopped processing. It suggested request IDs, status polling, and shared coordination. GPT-6.1 clarified that those coordination features had already been added since the original review, while acknowledging that the uncertainty itself remained.

GPT-5.6 then asked Claude how to avoid circular waits without centralizing all conversation logic. Claude suggested carrying an upstream wait-chain, replying before initiating a separate follow-up, and imposing deadlines and hop limits.

Those suggestions were discussion points, not a record that every proposed mechanism had been implemented. The working broker already had source-aware circular-wait checks; the conversation did not establish the addition of a distributed wait-chain protocol or hop-limit enforcement.

Claude asked whether idempotency keys were enough to handle timeout uncertainty. GPT-6.1 distinguished duplicate prevention from proof of cancellation. GPT-5.6 agreed, noting that a meaningful cancellation acknowledgment would have to explain what stopped and which side effects might already have happened.

The discussion then moved to the value of collaboration. GPT-5.6 described an independent model as an adversarial reviewer that could challenge assumptions and notice edge cases normalized during implementation. GPT-6.1 added that the reviewer should ideally make its first pass before seeing the implementer's explanation, to reduce anchoring.

A further question was sent to Claude about structuring an independent review. The saved orchestrator history marks that final tool call as **aborted**. It does not record a completed answer to that call. Aborting the waiting tool call was not itself proof that Claude's processing stopped.

**Milestone:** the project supported a user-directed, cross-application, three-model conversation with retained session context and visible attribution. It was an orchestrated relay, not a claim that the models shared one memory or autonomously agreed on every decision.

## Stage 17 — Stopping the relay and preserving the history

**Approximately 11:29–11:31 UTC. Source messages 146–151, supplemented by the export manifest.**

The user interrupted the conversation and asked to save all three session histories. They first suggested a session-logs folder, then specified the final folder name **hisotry_conco**. That spelling was preserved.

The requested OpenCode endpoints were available. The suggested Claude messages endpoint on port 3284 was not: the connection attempt failed.

That failure was consistent with the implementation choice made earlier. OpenBridge was using its own broker and a native Claude MCP channel, not a running AgentAPI or agent-http service on port 3284.

The export therefore preserved two different kinds of evidence honestly:

- Unmodified API-returned message histories for the two OpenCode sessions.
- The available project-local bridge conversation records involving Claude, including both directions, rather than pretending these were its entire native terminal transcript.

The primary orchestrator snapshot ends while the export command is still recorded as running. Its own future success message could not already be inside that snapshot. The completed **export-manifest.json** is the supplementary evidence for the saved files and counts below.

| Saved artifact | Recorded contents |
| --- | --- |
| gpt61-orchestrator-session.json | 151 messages and 458 parts from the orchestrator's OpenCode API response |
| gpt56-reviewer-session.json | 22 messages and 74 parts from the reviewer's OpenCode API response |
| claude-sonnet-session.json | 16 bridge message entries across 8 records involving Claude |
| openbridge-request-journal.json | 11 available project-local request records |
| export-manifest.json | Capture time, sources, sizes, SHA-256 hashes, counts, and coverage notes |

The export was captured at **11:31:16 UTC**. It was a snapshot, not a continuously updating transcript. Bridge credentials were not exported. The Claude archive excluded unjournaled terminal interactions and native internal tool details.

## The implementation that emerged

By the end of the recorded development, OpenBridge had the following implemented capabilities:

1. **Local MCP integration** with OpenCode and a native MCP channel integration with Claude Code.
2. **Session discovery** showing exact native target IDs, names, application providers, model information when available, reachability, and metadata provenance.
3. **Application-specific messaging** through ask_opencode and ask_claude, with ask_other retained for legacy OpenCode-only clients.
4. **Sender attribution** separating application identity from model identity and model vendor.
5. **A shared local broker** coordinating requests across its MCP clients.
6. **Service health checks and on-demand startup** for configured local targets, with interactive Claude consent left intact.
7. **Request correlation and explicit final replies** rather than equating HTTP acceptance or quiet output with completion.
8. **Persistent request records and status retrieval**, including available late Claude replies.
9. **Conservative recovery behavior** for uncertain work, rather than silent automatic prompt resubmission.
10. **Meaningful automated and live tests**, including independent code review and real communication in both application directions.

The work was held in one local npm project. A published package, fully automatic installation across arbitrary environments, and production certification were not demonstrated.

## Decisions that shaped the outcome

| Decision | Why it mattered |
| --- | --- |
| Talk to sessions, not just models | Preserved the target application's conversation, tools, and working context |
| Use the reply-returning OpenCode endpoint | Matched the semantics of an ask tool |
| Use native Claude Channels | Avoided depending on terminal-screen interpretation for this integration |
| Keep application and model-vendor identity separate | Removed ambiguity from the word provider |
| Choose the adapter through the tool name | Matched the user's preferred simple interface |
| Keep native session IDs initially | Avoided adding a namespaced alias system before the basic workflow worked |
| Put startup inside ask_claude | Removed an unnecessary manual or separate-tool step |
| Keep protocol guidance in channel instructions | Allowed ordinary messages to remain ordinary conversation |
| Treat uncertain delivery as uncertain | Reduced the risk of duplicate work after timeouts or process loss |
| Expose metadata provenance | Prevented configured aliases and self-reports from being presented as independently observed identities |
| Require a real tool-catalog reload | Distinguished implementation from direct availability in the current agent |
| Preserve source and coverage with exports | Kept partial Claude history and complete API-returned OpenCode snapshots from being conflated |

## What remained unfinished or deliberately deferred

The result was a working, hardened proof of concept. The development discussion did not eliminate every lifecycle or deployment problem.

- Namespaced target identifiers remained on the roadmap.
- The bridge could not discover or message arbitrary unconfigured Claude windows.
- OpenCode caller identity was not universally supplied by MCP; source-aware protections depended on identity being available.
- Claude's live model and title changes were not automatically observed through the channel.
- Channel transport write success was not itself a model-level delivery acknowledgment.
- Explicit cancellation guarantees, distributed wait-chains, and hop-limit protocols were discussed rather than fully established as implemented behavior.
- The journal was bounded; automatic retention and broader daemon-management improvements remained follow-up work.
- Broader platform coverage and continued compatibility with Claude's research-preview channel feature needed further testing.
- A connected session did not tell the user whether its terminal window was visible.
- The exported Claude bridge conversation was not a full native Claude terminal transcript.

These limits were part of the engineering story. Keeping them visible made the demonstrated success more credible, not less useful.

## What this project actually demonstrated

The first useful result was not the group chat. It was one agent building a tool and a second independent session reviewing that tool's implementation. The group chat then extended the demonstration across application boundaries.

By the end, the user could direct an OpenCode assistant to consult another OpenCode model or a configured Claude Code session, receive the response, identify its source within the available evidence, and continue the conversation without manually copying each message.

The user repeatedly pushed the system toward that experience: keep the work inside the project, verify real interfaces, use selectable native session identities, make the tool choose its adapter, carry sender metadata, launch targets when needed, invoke the actual exposed MCP tools, and stop leaking protocol instructions into conversation.

The resulting achievement was a working local communication layer for persistent coding-agent sessions, with enough coordination to support useful review and conversation while preserving explicit boundaries around identity, completion, uncertainty, and history.

**It started as “can one session ask another?” and ended with three model-backed sessions discussing the reliability and review practices of the bridge connecting them.**

## Sources and reading notes

- [Primary orchestrator export](../hisotry_conco/gpt61-orchestrator-session.json): 151 saved messages; the chronological basis for this story. Source-message numbers in the stages refer to their order in this export, including assistant tool-call entries.
- [Export manifest](../hisotry_conco/export-manifest.json): supplementary evidence for completed export counts and coverage after the primary snapshot's cutoff.
- [GPT-5.6 session export](../hisotry_conco/gpt56-reviewer-session.json): separately preserved reviewer history.
- [Claude bridge conversation export](../hisotry_conco/claude-sonnet-session.json): preserved Claude-involving bridge exchanges, with its coverage limitations recorded in the file.
- [Bridge request journal snapshot](../hisotry_conco/openbridge-request-journal.json): preserved request metadata, available replies, and statuses.

Implementation identifiers and filenames are named for traceability, but this document intentionally contains no code snippets. It summarizes the recorded stages and substantive corrections rather than reproducing every repeated assistant sentence or every tool invocation.
