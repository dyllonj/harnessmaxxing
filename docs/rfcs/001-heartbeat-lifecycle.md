# RFC-001: Agent Heartbeat & Lifecycle Management

| Field        | Value                              |
|--------------|------------------------------------|
| **Title**    | Agent Heartbeat & Lifecycle Management |
| **RFC**      | 001                                |
| **Status**   | Draft                              |
| **Date**     | 2026-02-21                         |
| **Author**   | Harnessmaxxing Contributors        |
| **Runtime**  | TypeScript / Node.js               |

---

## 1. Abstract

This document specifies the heartbeat protocol and lifecycle management system for harnessmaxxing, a greenfield agent harness platform built on TypeScript and Node.js. It defines the primitives required to run AI agents as persistent, supervised processes: a tick-based execution model, a semantically rich heartbeat protocol, a finite state machine governing agent lifecycle, a checkpointing mechanism for cross-process survival, and an Erlang-inspired supervisor hierarchy adapted for the non-deterministic failure modes unique to LLM-backed agents. The system is designed around opinionated defaults with thin interfaces at exactly two extension seams — `CheckpointStore` for persistence and `MessageBus` for inter-agent and system communication — keeping the core minimal while enabling arbitrary backend substitution. This RFC explicitly does **not** cover payment and billing integration, long-term memory and retrieval-augmented generation, swarm coordination and multi-agent topology management, or multi-model routing and load balancing; each of these is deferred to subsequent RFCs that will extend the lifecycle primitives defined here.

---

## 2. Motivation & Problem Statement

### 2.1 The Persistence Gap

The current generation of agent frameworks — LangChain, CrewAI, AutoGen, the OpenAI Agents SDK — share a foundational assumption inherited from the web: computation is request/response. A user sends a prompt, the framework orchestrates some chain of LLM calls and tool invocations, and a result comes back. The process that handled the request can then be discarded. This model works for chatbots, for single-shot code generation, for RAG pipelines that answer a question and move on. It does not work for agents that need to run autonomously for hours, days, or weeks.

The gap between "agent demo" and "agent in production" is almost entirely about lifecycle. Consider what happens when you deploy an agent that monitors a GitHub repository, triages incoming issues, and opens pull requests for straightforward fixes. The agent needs to poll for new issues, maintain context about the repository's architecture and coding conventions, remember which issues it has already triaged, manage concurrent tool invocations (reading files, running tests, pushing commits), and do all of this continuously. If the process hosting this agent crashes — an OOM kill, a cloud instance preemption, a deployment rolling update — the agent's entire state is lost. Its conversation history with the LLM is gone. Its in-progress triage of a complex issue is gone. Any tool invocations it had queued are gone. The agent is not just interrupted; it is annihilated.

This is not a theoretical concern. Production agents encounter specific, recurring failure scenarios that current frameworks have no answer for:

**Process crash mid-tool-execution.** The agent calls an external API — sends a Slack message, creates a Jira ticket, pushes a git commit — and the process crashes after the side effect occurs but before the agent records that it occurred. On restart, the agent has no memory of the action. It may repeat it. A duplicate Slack message is annoying; a duplicate financial transaction is catastrophic. Current frameworks offer no mechanism to track which side effects have been committed and which are still pending.

**OOM during long context.** An agent working on a complex task accumulates a large conversation history. The context window fills up; the process's memory usage climbs as the serialized context grows. Eventually the Node.js process exceeds its memory limit and is killed by the operating system. The agent had been making progress on a multi-step task — perhaps it had completed seven of ten steps — and all of that progress is lost. There is no checkpoint to resume from.

**Cloud instance preemption.** On AWS, GCP, and Azure, spot/preemptible instances can be reclaimed with as little as 30 seconds of warning. An agent running on a preemptible instance needs to checkpoint its state within that window or lose everything. No current agent framework provides a mechanism for graceful preemption handling — the concept does not exist in their models.

**Stuck loops and runaway costs.** An agent encounters an error from a tool invocation, retries, gets the same error, retries again, and enters an infinite retry loop. Each retry consumes tokens. The agent is "alive" by any process-level health check — it is executing code, making API calls, responding to health probes — but it is accomplishing nothing and burning money. By the time a human notices, the agent has consumed hundreds of dollars in API costs. There is no supervisor watching the agent's semantic progress, only its process-level liveness.

These failure scenarios are not edge cases. They are the normal operating conditions of any agent that runs for more than a few minutes. The persistence gap is the central problem blocking the transition from agent prototypes to agent infrastructure, and it is the problem this RFC addresses.

### 2.2 Why Traditional Process Management Fails

The obvious response to "agents need lifecycle management" is "use existing process management." Unix has managed processes for fifty years. systemd provides unit files with restart policies, health checks, and dependency management. Kubernetes offers liveness probes, readiness probes, startup probes, pod disruption budgets, and rolling update strategies. Erlang/OTP provides supervision trees, process linking, and the "let it crash" philosophy. These are mature, battle-tested systems. Why not use them directly?

Because AI agents have fundamentally different failure modes than traditional processes. Traditional process management assumes a binary health model: a process is either alive and functioning, or it is dead and needs to be restarted. This assumption holds for web servers, databases, and message queues — processes whose correctness can be assessed by whether they respond to requests and return valid data. For AI agents, the binary model is categorically insufficient. An agent can be alive by every process-level metric — responding to health checks, consuming CPU, making network calls — while being completely useless or actively harmful. The failure modes unique to AI agents include:

**Context exhaustion.** Every LLM has a finite context window. As an agent works, its conversation history grows. Eventually the context window fills up. The agent's process is still running. It still responds to health checks. But it can no longer reason effectively — new information pushes out old information, the agent loses track of its goals, its outputs degrade. A systemd health check sees a healthy process. A Kubernetes liveness probe gets a 200 OK. But the agent is functionally brain-dead. Detecting this failure requires understanding the agent's context utilization relative to its model's limits — semantic health information that no traditional process manager collects.

**Hallucination spirals.** An agent begins producing outputs that are internally inconsistent, factually wrong, or disconnected from its assigned task. Perhaps it encountered an ambiguous tool output and made an incorrect inference, and subsequent reasoning compounds the error. The agent is running. It is making LLM calls. It is invoking tools. But the actions it takes are garbage. Detecting a hallucination spiral requires evaluating the semantic coherence of the agent's recent outputs — a fundamentally different kind of health assessment than "is the process responding to TCP connections."

**Budget depletion.** An agent has consumed its allocated token budget, cost budget, or time budget. The process is perfectly healthy. The agent could continue working indefinitely. But it must be stopped — not because of a failure, but because of a policy constraint. Traditional process managers have no concept of "this process is healthy but must be terminated because it has spent too much money." Budget depletion is a lifecycle event that exists in no process management framework because no traditional process has a per-invocation cost measured in dollars.

**Tool side-effect cascades.** An agent executes a sequence of tool calls with external side effects: it reads a database, computes a result, sends an email, and then crashes before updating its internal state. On restart, the agent does not know the email was sent. If it re-executes the sequence, the email is sent again. Traditional process management handles this for deterministic processes through write-ahead logs and transaction boundaries. But an agent's "transaction" spans an LLM call — which is non-deterministic — and arbitrary external tool invocations — which may not support idempotency. The side-effect tracking problem requires agent-specific machinery that no process manager provides.

**Stuck loops.** An agent attempts a task, fails, retries with a slightly different approach, fails again, and enters a loop where it keeps trying variations of the same failing strategy. Each iteration burns tokens and time. The process is alive. The agent is "working." But it is not making progress. Detecting stuck loops requires tracking the agent's progress over time — not just whether it is executing, but whether its executions are achieving anything. This is a semantic assessment that requires domain-specific health policies.

These failure modes share a common thread: they cannot be detected by observing the process from the outside. They require introspection into the agent's internal state — its context utilization, its recent outputs, its budget consumption, its progress toward its goals. This is why the heartbeat in our system is not a ping but a structured telemetry message carrying semantic health data. And it is why the supervisor in our system is not a process restarter but a policy evaluator that understands the specific ways AI agents fail.

Traditional process managers are necessary but insufficient. We run on top of them — our agents are still OS processes managed by systemd or Kubernetes. But the layer above the process, the layer that understands what it means for an agent to be healthy, must be purpose-built.

### 2.3 The Backbone Hypothesis

This RFC argues that lifecycle management is the foundational primitive of any agent platform — the layer on which everything else is built. This is not a claim about implementation priority (though lifecycle should be built first). It is a claim about architectural dependency: every other subsystem in an agent platform assumes the existence of lifecycle primitives, and the design of those primitives constrains the design of everything that follows.

**Payments need lifecycle hooks.** An agent billing system must meter usage at a granular level: tokens consumed, API calls made, compute time used, tool invocations executed. To meter accurately, the billing system needs to know when an agent starts working (to begin metering), when it stops (to end metering), when it checkpoints (to record cumulative usage), and when it recovers (to resume metering from the last checkpoint). These are lifecycle events. Without a lifecycle system that emits them reliably, the billing system must independently track agent state — duplicating lifecycle logic, introducing consistency bugs, and creating a parallel source of truth about whether an agent is running.

**Memory needs lifecycle hooks.** A long-term memory system for agents — episodic memory, semantic memory, working memory — must persist memory contents when an agent checkpoints and restore them when an agent recovers. It must compact or summarize memory when context is exhausted. It must archive memory when an agent is terminated. Every one of these operations is triggered by a lifecycle state transition. Without lifecycle primitives, the memory system must implement its own state machine to decide when to persist, restore, compact, and archive — again duplicating lifecycle logic.

**Swarm coordination needs lifecycle hooks.** A system that manages multiple cooperating agents — spawning workers, distributing tasks, aggregating results, handling worker failures — is fundamentally a supervisor-of-supervisors. It needs to know when agents start, stop, fail, recover, and exhaust their budgets. It needs to spawn replacement agents when workers die. It needs to redistribute work when an agent's context is exhausted. These are all lifecycle operations. A swarm coordinator built without lifecycle primitives must implement its own agent monitoring, failure detection, and restart logic.

The pattern is consistent: every subsystem that interacts with agents needs to observe and react to lifecycle state transitions. If the lifecycle system is well-designed — emitting rich events, providing reliable state queries, offering hook points for extension — then each subsystem can focus on its own domain logic and subscribe to the lifecycle events it cares about. If the lifecycle system is absent or poorly designed, every subsystem independently reinvents lifecycle management, creating inconsistency, duplication, and subtle bugs when the independent implementations diverge.

The analogy is the operating system's process model. Every OS provides a process abstraction: creation (fork/exec), state transitions (running, sleeping, stopped, zombie), monitoring (wait, signals), and cleanup (exit, resource reclamation). Application frameworks — web servers, databases, job queues — do not re-implement process management. They use the OS primitives. The process model is so foundational that it is invisible; we forget it is there until we work on a platform that lacks it (embedded systems without an OS, early microcontrollers). The chaos of building complex software without a process model is instructive: every component must manage its own scheduling, its own memory, its own failure handling. Nothing composes.

Lifecycle management is to agents what the process model is to operating systems. It is the thing everything else assumes exists. Getting it right means every subsequent subsystem — payments, memory, swarm coordination, tool management, observability — can build on solid ground. Getting it wrong means rebuilding the foundation under every structure that depends on it.

This is why lifecycle is RFC-001. Not because it is the most exciting component of the platform, but because it is the most load-bearing.

---

## 3. Competitive Analysis

The following table summarizes lifecycle management capabilities across existing frameworks and systems. A checkmark indicates that the capability is present and usable in production; a cross indicates absence. Parenthetical notes provide qualifications.

| Capability | LangGraph | Temporal.io | AutoGen 0.4 | CrewAI | OpenAI Agents SDK | Erlang/OTP | **Harnessmaxxing** |
|---|---|---|---|---|---|---|---|
| Heartbeat Protocol | - | Yes | - | - | - | Yes | **Yes** |
| Health Monitoring | - | Yes | - | - | Tracing only | Yes | **Yes (semantic)** |
| Checkpoints | Yes (best-in-class) | Yes | - (planned) | - | Sessions | - (in-memory) | **Yes** |
| Recovery | Replay only | Yes (deterministic) | - | - | Caller-managed | Yes | **Yes (spectrum)** |
| Supervision | - | - | - | - | - | Yes (gold standard) | **Yes** |
| Side-Effect Tracking | - | Yes | - | - | - | - | **Yes** |

### LangGraph

LangGraph has the best checkpoint model in the agent framework space, and it is not close. Their `StateGraph` abstraction maps naturally to checkpointing: graph state is explicit, serializable, and stored at each node transition. The `CheckpointSaver` interface is clean, with production implementations for SQLite, Postgres, and MongoDB. Thread-based persistence means you can resume a conversation graph from any prior state by referencing its thread ID and checkpoint ID.

But LangGraph's checkpoints are replay-oriented. Recovery means replaying the graph from the last checkpoint through all subsequent node transitions. This works well for short, deterministic graphs — a three-step RAG pipeline, a branching decision tree. It works poorly for long-running autonomous agents. If an agent has been running for six hours and crashes after five hundred tool invocations, replaying from the last checkpoint through all five hundred invocations is not a viable recovery strategy. The invocations involved LLM calls (non-deterministic — replay produces different completions), external tool calls (side-effecting — replay may duplicate actions), and context-dependent decisions (the agent's reasoning at step 300 depended on the specific completion it received at step 299, which replay will not reproduce).

LangGraph has no heartbeat protocol. There is no mechanism for an agent to periodically report its health to an external monitor. Health monitoring is limited to basic error handling within the graph execution — if a node throws an exception, the graph transitions to an error state. There is no semantic health assessment: no detection of context exhaustion, stuck loops, hallucination spirals, or budget depletion. There is no supervisor abstraction — failed graphs are surfaced to the caller, and recovery is the caller's responsibility.

LangGraph's checkpoint model is excellent and directly informs our `CheckpointStore` interface. But checkpointing alone is necessary and insufficient for production lifecycle management. LangGraph provides the persistence layer without the supervision layer.

### Temporal.io

Temporal is the closest existing infrastructure to what this RFC describes, and it is instructive to understand both why Temporal is excellent and why it is not sufficient for AI agents.

Temporal's durable execution model solves the core persistence problem: workflow state survives process failures, and the system automatically retries and recovers from crashes. Workflow code is written in a standard programming language (TypeScript, Go, Python, Java) but executed in a durable runtime that persists every state transition. If the worker process crashes, a new worker picks up the workflow from its last recorded state and continues. Activity heartbeats allow long-running activities to report progress, and Temporal uses heartbeats to detect stuck activities and trigger retries.

The problem is Temporal's determinism constraint. Temporal achieves its durability guarantees by requiring workflow code to be deterministic: given the same inputs and the same sequence of activity results, the workflow must produce the same state transitions. This is how replay works — Temporal replays the workflow's event history through the workflow code, and determinism guarantees that replay produces the same state. All non-determinism must be isolated into activities, which are executed at-most-once and whose results are recorded in the event history.

LLM calls are fundamentally non-deterministic. The same prompt with the same model at the same temperature produces different completions on different calls. And in an agent, the next step depends on the completion — the agent reads the LLM's output, decides what tool to call next, formulates the next prompt. The non-determinism is not isolated; it propagates through the entire execution.

You can wrap LLM calls as Temporal activities. Many teams do this. But you lose Temporal's replay guarantee — since the LLM activity's result is recorded in the event history, replay uses the recorded result, not a fresh LLM call. This means the agent's behavior on replay is determined by the original LLM completions, not by current model behavior. In some contexts this is desirable (reproducibility), but it also means you cannot update the model, change the system prompt, or modify the agent's reasoning without invalidating all existing workflow histories. You also end up fighting Temporal's assumptions: workflow code must be deterministic, but agent logic is inherently adaptive; activity retries assume idempotency, but LLM calls with tool use may have already produced side effects.

Temporal provides genuine durability for deterministic workflows. For AI agents, it provides a powerful but awkward substrate that requires significant adaptation. We take Temporal's core concepts — durable state, heartbeat protocols, activity-level progress tracking — and reimplement them without the determinism constraint that makes Temporal's replay model possible but also makes it ill-fitted for LLM workloads.

### AutoGen 0.4

Microsoft's ground-up rewrite of AutoGen (0.4, released in late 2025) represents thoughtful architecture. The event-driven runtime with typed messages, the `AgentRuntime` abstraction, the separation of agent logic from communication topology, and the `ChatCompletionClient` interface for model-agnostic LLM access are all well-designed. The team clearly studied the shortcomings of AutoGen 0.2's tightly coupled, synchronous architecture and addressed them systematically.

But persistence and recovery are explicitly deferred. The `AgentRuntime` is in-memory. Agent state lives in the process that hosts the runtime. If that process crashes, all agent state is lost — conversation histories, intermediate results, task progress. The team has discussed checkpointing in their design documents and GitHub issues, but as of early 2026, no checkpointing mechanism has shipped. There is no heartbeat protocol, no supervisor abstraction, no recovery strategy beyond "restart from scratch."

AutoGen 0.4's architecture is clean enough that lifecycle management could be added without fundamental redesign. The `AgentRuntime` interface could be extended with checkpoint/restore methods. The message-passing model could carry heartbeat messages. But the work has not been done, and the framework is not usable for persistent agents in its current form.

We take from AutoGen the event-driven runtime model and the clean separation of concerns. Our `MessageBus` interface is conceptually similar to AutoGen's message-passing layer, though our messages carry lifecycle semantics (heartbeats, lifecycle events, supervisor commands) in addition to agent-to-agent communication.

### CrewAI

CrewAI is popular for multi-agent orchestration — defining "crews" of agents with roles, goals, and tools, and running them against a task. The framework handles agent-to-agent delegation, tool routing, and output aggregation. For its intended use case — batch-mode multi-agent task execution — it works well.

But CrewAI is fundamentally synchronous and in-memory. A crew is instantiated, kicked off with `crew.kickoff()`, and runs to completion or failure. There is no lifecycle management because there is no lifecycle — agents exist only for the duration of the kickoff call. There is no persistence: if the process crashes, the crew is gone. There is no heartbeat, no health monitoring, no checkpointing, no recovery, no supervision. Agents are instantiated, run, and discarded.

CrewAI's role-based agent definition model and task delegation patterns are useful for swarm coordination (a future RFC), but the framework provides nothing for lifecycle management. It is included in this analysis for completeness and to illustrate that most agent frameworks simply do not engage with the persistence problem.

### OpenAI Agents SDK

The OpenAI Agents SDK (released March 2025, significantly updated through 2025 and into 2026) provides two relevant primitives: sessions and tracing. Sessions give agents persistent thread state — conversation history stored on OpenAI's servers, accessible by session ID, surviving across API calls. Tracing provides OpenTelemetry-compatible telemetry: spans for agent runs, LLM calls, tool invocations, and handoffs, exportable to any OTel-compatible backend.

Sessions provide persistence but not resilience. If your agent process crashes, the session state (conversation history) is preserved on OpenAI's servers. But the agent's execution state — what it was doing when it crashed, what tool calls were in flight, what its next step was going to be — is lost. Recovery is entirely caller-managed: your application code must detect the crash, decide how to recover, reconstruct the agent's intent from the session history, and resume. The SDK provides no supervisor, no heartbeat, no recovery strategy. It gives you the raw materials (persistent conversation state, execution traces) and leaves the lifecycle management to you.

Tracing is valuable for observability but is not health monitoring. A trace tells you what happened after the fact. It does not tell a supervisor what is happening right now. There is no mechanism for a running agent to emit periodic health reports to an external monitor. Traces are write-only telemetry, not bidirectional health communication.

The OpenAI Agents SDK's session model informs our thinking about what state must be externalized for cross-process survival. Their tracing model is complementary to (not competitive with) our heartbeat protocol — we emit heartbeats for real-time supervision and traces for post-hoc analysis. But the SDK provides persistence without lifecycle management, telemetry without supervision.

### Erlang/OTP

Erlang's process model and OTP's supervision framework are the conceptual foundation for our supervisor architecture, and they deserve detailed treatment.

Erlang processes are lightweight (a few hundred bytes of initial memory), fast to spawn (microseconds), and isolated (no shared memory — communication is exclusively through message passing). These properties make it practical to run millions of processes per node. When a process fails, it crashes — and its supervisor detects the crash (via process linking), decides on a restart strategy (one-for-one, one-for-all, rest-for-one), and spawns a replacement. The "let it crash" philosophy works because processes are cheap to create and initialize, and because Erlang's immutable data model means a crashed process leaves no corrupted shared state.

OTP supervisors implement a hierarchy: supervisors supervise workers and other supervisors, forming a tree. The supervision tree provides structured fault tolerance — a failure in a leaf worker is handled by its immediate supervisor, and only escalated up the tree if the supervisor's restart limits are exceeded. This is the gold standard for process lifecycle management in any language or runtime.

But Erlang's model assumes properties that AI agents do not have:

**Cheap, fast startup.** An Erlang process starts in microseconds and immediately begins processing messages. An AI agent starts by reconstructing its LLM context — loading conversation history, re-establishing tool state, potentially re-summarizing prior work. This takes seconds to minutes, not microseconds. The "let it crash and restart" strategy has a different cost-benefit profile when restarts are expensive.

**Deterministic behavior.** An Erlang process, given the same messages in the same order, produces the same state transitions. An AI agent's behavior depends on LLM completions, which are non-deterministic. Restarting an agent from the same state may produce entirely different behavior — different tool calls, different reasoning, different outcomes. Supervision strategies must account for this non-determinism.

**No expensive external state.** An Erlang process's state is its in-memory data — a few kilobytes to a few megabytes, easily reconstructed from the process's initialization logic. An AI agent's state includes its LLM context — potentially hundreds of thousands of tokens of conversation history that cannot be cheaply reconstructed. Losing the context is not like losing a process's local variables; it is like losing the process's brain.

**Binary health model.** An Erlang process is alive or dead. It crashes with an exception, the supervisor detects the crash, and restarts. The health assessment is binary and instantaneous. AI agents, as argued in Section 2.2, have failure modes that are not detectable by process-level monitoring. An agent can be alive (process running, responding to messages) while being unhealthy (context exhausted, hallucinating, stuck in a loop, over budget).

We adopt Erlang's supervision patterns wholesale: the supervision tree structure, the one-for-one/one-for-all restart strategies, the escalation model, the "let it crash" philosophy. But we adapt them for AI agents: restarts are context-aware (the recovery strategy depends on why the agent failed and what state can be restored), health assessment is semantic (the supervisor evaluates heartbeat telemetry, not just process liveness), and supervision policies are configurable per-agent (because a code-generation agent and a customer-support agent have different failure modes and different acceptable restart costs).

### Synthesis

No existing framework or system provides the complete set of lifecycle primitives that production AI agents require. But each provides something valuable that informs our design:

From **LangGraph**, we take the checkpoint model: explicit, serializable state stored at well-defined boundaries, with pluggable storage backends. Our `CheckpointStore` interface is directly inspired by LangGraph's `CheckpointSaver`, extended with epoch metadata and side-effect tracking.

From **Temporal**, we take the concepts of durable execution and activity heartbeats: the idea that computation should survive process failures, and that long-running operations should periodically report progress. We adopt the concepts without the determinism constraint that makes Temporal's replay model both powerful and limiting.

From **AutoGen 0.4**, we take the event-driven runtime model and the clean separation of agent logic from infrastructure. Our tick-based execution model shares AutoGen's philosophy that agent code should be decoupled from the machinery that runs it.

From **Erlang/OTP**, we take the supervision tree pattern, the restart strategy taxonomy, the escalation model, and the "let it crash" philosophy — adapted for the specific failure modes, startup costs, and non-deterministic behavior of AI agents.

What none of them provide — and what this RFC specifies — is the integration of these concepts into a coherent lifecycle management system with semantic health monitoring (heartbeats that carry context utilization, progress metrics, and budget consumption), context-aware recovery strategies (recovery that understands LLM state is not fully capturable and offers a spectrum from hot restart to full reconstruction), cost-aware lifecycle management (budget enforcement as a first-class lifecycle concern, not an afterthought), and side-effect tracking (recording which external effects have been committed so that recovery does not duplicate them). These four capabilities, taken together, constitute the gap between existing systems and what production AI agents require.

---

## 4. Core Concepts & Terminology

This section defines the foundational concepts and vocabulary used throughout this RFC and all subsequent harnessmaxxing specifications. Each term is given a one-line formal definition followed by elaboration. These are not informal glossary entries; they are normative definitions that establish the precise semantics of the system.

### Agent

> A persistent, autonomous computational entity that executes work in a tick-based loop, maintains conversational context with one or more LLMs, and survives process restarts through checkpointing.

An agent is not a function call, not a thread, not a transient handler that processes a request and exits. An agent is a managed process with identity, state, and lifecycle. It has a unique identifier (the `agentId`) that persists across restarts — an agent that crashes and recovers is the same agent, not a new one. It has state that includes both traditional computational state (task queues, key-value data, configuration) and LLM-specific state (conversation history, system prompt, tool definitions). It has a lifecycle governed by a finite state machine with well-defined transitions and transition guards.

An agent runs in a tick-based loop: on each tick, it processes incoming messages, executes a unit of work (typically an LLM call followed by tool invocations), emits a heartbeat, and optionally creates a checkpoint. The tick is the atomic unit of agent execution. Between ticks, the agent is in a consistent state that can be checkpointed.

Critically, an agent's identity is not tied to a process. An agent may be hosted in process A, crash, and be recovered in process B. From the perspective of the rest of the system — other agents, the supervisor, external clients — it is the same agent. The `agentId` is the stable handle; the hosting process is an implementation detail. This is the fundamental distinction between an agent and a process: a process is a runtime container, while an agent is a persistent entity that happens to be hosted in a process.

### Heartbeat

> A structured message emitted by an agent on each tick, carrying semantic health data, resource consumption metrics, and execution metadata.

Traditional heartbeats are binary signals: the process is alive (heartbeat received) or presumed dead (heartbeat missed). Our heartbeats are rich telemetry. A heartbeat message includes:

- **Timestamp and sequence number**, for ordering and gap detection.
- **Lifecycle state**, the agent's current position in its state machine.
- **Context utilization**, the fraction of the agent's LLM context window currently consumed, including token counts for system prompt, conversation history, and tool definitions.
- **Budget consumption**, cumulative tokens used, estimated API cost, wall time elapsed, and tool invocations executed, measured against the agent's configured budget limits.
- **Progress indicators**, application-defined metrics that allow the supervisor to assess whether the agent is making forward progress (e.g., tasks completed, steps advanced, error rate over a sliding window).
- **Execution metadata**, the duration of the most recent tick, the number of LLM calls and tool invocations in the tick, any errors encountered.

The supervisor consumes heartbeat streams and evaluates them against health policies. A heartbeat that reports 95% context utilization triggers a different response than a heartbeat that reports zero progress over the last twenty ticks. This semantic richness is what distinguishes our health monitoring from binary liveness checks.

Heartbeat emission is the agent's responsibility. An agent that fails to emit a heartbeat within the configured timeout is presumed unhealthy — but the absence of a heartbeat is only one of many health signals. An agent that emits heartbeats reporting a stuck loop is also unhealthy, even though heartbeats are arriving on schedule.

### Tick

> A single iteration of an agent's event loop; the atomic unit of agent work.

The tick is the fundamental scheduling primitive. Each tick follows a fixed sequence:

1. **Inbox drain.** The agent reads messages from its inbox on the `MessageBus` — commands from the supervisor, messages from other agents, external events.
2. **Work execution.** The agent performs its core work for this tick. For most agents, this means constructing a prompt from current state and recent messages, calling the LLM, parsing the response, and executing any tool calls the LLM requested.
3. **Heartbeat emission.** The agent constructs and emits a heartbeat message carrying the metrics described above.
4. **Checkpoint (conditional).** If the checkpoint policy triggers — every N ticks, or when significant state changes occur, or on explicit request — the agent serializes its state and writes it to the `CheckpointStore`.
5. **Yield.** The agent yields control, sleeping until the next tick.

Tick rate is adaptive. An agent actively working may tick every few seconds (limited primarily by LLM response latency). An agent in a sleeping state may tick every few minutes, emitting heartbeats to confirm liveness but performing no work. The tick rate is configurable per-agent and may be adjusted dynamically by the supervisor.

The tick boundary is the consistency boundary. Between ticks, the agent's state is consistent and checkpointable. During a tick, the agent may be in an intermediate state — a tool call in flight, an LLM response partially processed. Checkpoints are never taken mid-tick. This is a deliberate design choice: it means a crash mid-tick loses at most one tick's worth of work, and recovery always resumes from a clean state.

### Lifecycle State

> One of a finite set of states in the agent's state machine, defining the agent's current operational status.

Every agent is in exactly one lifecycle state at all times. The complete set of states is:

- **UNBORN** — The agent has been defined (configuration exists) but has never been started. No process hosts it. No checkpoint exists. This is the initial state for newly created agents.
- **INITIALIZING** — The agent's process has been started and it is performing first-time setup: loading configuration, establishing LLM connections, constructing its initial context envelope, registering with the supervisor. The agent is not yet accepting work.
- **RUNNING** — The agent is actively executing its tick loop, processing messages, calling LLMs, invoking tools, emitting heartbeats. This is the primary operational state.
- **SLEEPING** — The agent is alive but not actively working. It continues to emit heartbeats at a reduced rate and will drain its inbox on each tick, but it does not execute work steps. Agents enter the sleeping state when they have no pending work, are waiting for an external event, or are explicitly paused by the supervisor.
- **ERROR** — The agent has encountered a non-fatal error and is awaiting supervisor intervention. The agent's process is still running, but the agent has stopped executing work ticks. The error state carries error metadata (error type, message, stack trace, the tick number on which the error occurred) that the supervisor uses to select a recovery strategy.
- **CHECKPOINTED** — The agent has been cleanly shut down after writing a final checkpoint. No process hosts it. It can be recovered from its checkpoint. This state is distinct from DEAD: a checkpointed agent is expected to be recovered, while a dead agent is not.
- **RECOVERING** — The agent is being restored from a checkpoint. A new process has been started, the checkpoint has been loaded, and the agent is reconstructing its state — re-establishing LLM context, replaying any unreplayed messages, verifying side-effect records. Recovery transitions to RUNNING on success or ERROR on failure.
- **DEAD** — The agent has been terminated and will not be recovered. Its checkpoints may still exist (for forensic analysis) but no supervisor will attempt to restart it. Terminal state.
- **ARCHIVED** — The agent has been terminated and its final state has been archived for long-term storage. Checkpoints may be pruned. This is the terminal state for agents that completed their work successfully.

State transitions are guarded: not every transition is legal. An agent in the UNBORN state can transition to INITIALIZING but not directly to RUNNING. An agent in the DEAD state cannot transition to any other state. The transition guards are enforced by the lifecycle runtime, and illegal transitions throw errors. Every state transition produces a lifecycle event that is emitted on the `MessageBus`, enabling the supervisor and other subsystems to react to lifecycle changes.

### Checkpoint

> A serialized snapshot of an agent's state at a point in time, sufficient to reconstruct the agent in a new process.

A checkpoint contains:

- **Agent metadata**: `agentId`, agent type, configuration version, the lifecycle state at checkpoint time, the tick number, and the epoch number.
- **Context envelope (approximate)**: The agent's LLM context — system prompt, conversation history, tool definitions, and any injected context. This is approximate because LLM context may include model-internal state (attention patterns, cache entries) that is not accessible to the agent framework. The checkpoint stores the text content of the context, not the model's internal representation.
- **External state**: Application-defined state that the agent maintains outside its LLM context — task queues, key-value stores, counters, flags, references to external resources.
- **Side-effect record**: A log of external side effects committed during the current epoch — API calls made, messages sent, files written, database records created. Each side effect is tagged with its tick number and a unique effect ID. The side-effect record enables the recovery process to determine which effects have already been committed and avoid duplicating them.
- **Budget snapshot**: Cumulative resource consumption at the time of the checkpoint — tokens used, estimated cost, wall time, tool invocations.
- **Checkpoint metadata**: Timestamp, checkpoint ID (a monotonically increasing sequence per agent), the ID of the previous checkpoint (forming a chain), and a checksum for integrity verification.

The critical acknowledgment: **LLM state is not fully capturable.** When an agent is recovered from a checkpoint, the LLM context is reconstructed from the stored conversation history. But the LLM's internal state — the specific attention patterns, the cached key-value pairs, the token probabilities computed during prior inference — is not preserved. The recovered agent has the same conversation history but may behave differently because the model processes the reconstructed context differently than the original incrementally-built context. Checkpoints enable approximate reconstruction, not exact replay. This is a fundamental limitation of the LLM-as-a-service model, and our recovery strategies are designed to account for it.

Checkpoints are stored via the `CheckpointStore` interface — one of the system's two extension seams. The default implementation uses the local filesystem; production deployments will use databases (Postgres, SQLite) or object stores (S3, GCS). The interface is intentionally minimal: `save(checkpoint)`, `load(agentId, checkpointId?)`, `list(agentId)`, `delete(checkpointId)`. Richer querying and lifecycle management of checkpoints themselves (compaction, pruning, archival) are handled by policies above the interface.

### Context Envelope

> The complete LLM context for an agent: system prompt, conversation history, tool definitions, and any injected context.

The context envelope is what makes an agent "itself." Two agents with identical code but different context envelopes are different agents — they have different knowledge, different conversation histories, different understandings of their tasks. Lose the context envelope, and you must reconstruct the agent's identity from external state: its configuration, its task queue, its checkpoint. The reconstructed agent will have the same goals and tools but none of the reasoning history that got it to its current state.

The context envelope is the most expensive component of an agent's state, measured in both bytes and reconstruction cost. A long-running agent may have a context envelope consuming tens or hundreds of thousands of tokens. Serializing this for checkpointing is straightforward (it is text). Deserializing it and feeding it back to an LLM on recovery is expensive — it consumes a full context window's worth of input tokens, incurring API cost proportional to the context size.

Context envelope management is a core lifecycle concern. The agent must monitor its context utilization (reported in heartbeats), manage context when it approaches the model's limits (summarization, truncation, or context window rotation), and ensure the context is checkpointed at appropriate intervals. The supervisor must monitor context utilization across agents and intervene when an agent's context grows dangerously large.

### Supervisor

> A process that monitors one or more agents via their heartbeat streams and takes corrective action when health policies are violated.

The supervisor is inspired by Erlang/OTP supervisors but adapted for AI agents. It consists of two logical components:

The **Health Assessor** consumes heartbeat streams from all supervised agents and evaluates them against configurable health policies. A health policy is a predicate over recent heartbeats — for example, "context utilization has exceeded 90% for three consecutive heartbeats" or "the agent has reported zero progress for twenty ticks" or "estimated cost has exceeded the soft budget limit." When a policy evaluates to true, the Health Assessor produces a health violation event.

The **Recovery Engine** receives health violation events and executes recovery strategies. The mapping from health violations to recovery strategies is configurable per-agent. A simple configuration might specify: on context exhaustion, perform context rotation; on stuck loop, restart from the last checkpoint with a modified prompt; on budget depletion, gracefully stop the agent; on repeated failures, escalate to a human operator.

Supervisors form a hierarchy, just as in Erlang. A supervisor may supervise individual agents, other supervisors, or a mix of both. Health violations that a supervisor cannot handle (because its restart limits are exceeded, or because the violation type is outside its configured strategies) are escalated to the supervisor's parent. The root supervisor escalates to human operators.

A supervisor is itself a process with a lifecycle — it can crash and be restarted. Supervisor state (the set of supervised agents, current health assessments, restart counters) is checkpointed, so a recovered supervisor can resume monitoring without losing its assessment of agent health.

### Recovery Strategy

> A predefined approach for bringing a failed agent back to a healthy operational state.

Recovery strategies exist on a spectrum from lightweight to heavyweight:

- **Hot restart.** The agent's process is restarted, but its in-memory state is reconstructed from the most recent checkpoint without modification. Appropriate for transient errors — a network timeout, a temporary API failure, an out-of-memory condition resolved by process restart.
- **Context rotation.** The agent's context envelope is modified before restart — typically by summarizing the conversation history to reduce context utilization, or by dropping old messages beyond a certain horizon. Appropriate for context exhaustion.
- **Prompt augmentation.** The agent is restarted with modifications to its system prompt — for example, adding instructions to avoid a specific failure mode that was detected (e.g., "Do not retry the X API — it is currently down"). Appropriate for stuck loops and known environmental issues.
- **Checkpoint rollback.** The agent is restored from an earlier checkpoint (not the most recent one), effectively rewinding its state to before the failure occurred. Appropriate for hallucination spirals and compounding errors where recent state is corrupted.
- **Cold restart.** The agent is restarted from its initial configuration with no checkpoint — a fresh start. The agent's task queue and external state are preserved (if stored externally), but its conversational context is lost. Appropriate when all checkpoints are suspect.
- **Escalation.** The agent is stopped, and a notification is sent to a human operator with diagnostic information (recent heartbeats, error details, the side-effect record). Appropriate for safety-critical failures, repeated recovery failures, and any situation where automated recovery is insufficiently trustworthy.

The key insight motivating this spectrum: "restart the process" is insufficient for AI agents because the process is only half of the state. The LLM context — the agent's accumulated reasoning, its understanding of the current task, its memory of prior actions — is the other half. A recovery strategy for an AI agent must address both the process state (computational) and the cognitive state (LLM context). This dual nature of agent state is what makes lifecycle management for AI agents fundamentally different from lifecycle management for traditional processes.

### Budget

> A set of hard and soft limits governing an agent's resource consumption: token count, API cost, wall time, tool invocations, and sub-agent spawns.

Budgets are first-class lifecycle constructs, not an afterthought bolted onto a monitoring system. Every agent is assigned a budget at creation time. The budget specifies:

- **Token limits** (soft and hard): total input tokens, total output tokens, total combined tokens. Soft limits trigger warnings and supervisor review. Hard limits trigger mandatory stop.
- **Cost limits** (soft and hard): estimated API cost in dollars. Estimation is based on per-model token pricing and actual token consumption.
- **Time limits** (soft and hard): wall-clock time since the agent's first tick in the current epoch.
- **Invocation limits** (soft and hard): total tool invocations, total LLM calls, total sub-agent spawns.

Budgets are enforced per-tick. On each tick, the agent updates its cumulative consumption metrics and checks them against its budget. If a soft limit is breached, the agent reports the breach in its next heartbeat and continues operating. If a hard limit is breached, the agent transitions to the CHECKPOINTED state after completing the current tick — a graceful stop, not an abrupt kill. The supervisor monitors budget consumption through heartbeats and may intervene before hard limits are reached (e.g., by sending a "wrap up" command when a soft limit is breached).

Budget exhaustion is a lifecycle event, not an error. An agent that completes its budget and gracefully stops has not failed — it has operated within its resource constraints. This distinction matters for recovery: a budget-exhausted agent should not be automatically restarted (which would reset its budget), but a crashed agent should be. The lifecycle state machine distinguishes these cases.

### Epoch

> A contiguous period of agent execution between checkpoints.

An agent's lifetime is a series of epochs. Each epoch begins when the agent starts (from INITIALIZING) or recovers from a checkpoint (from RECOVERING) and ends when the agent creates a checkpoint (transitioning to CHECKPOINTED) or terminates (transitioning to DEAD or ARCHIVED). Within an epoch, the agent executes a sequence of ticks, accumulates state changes, commits side effects, and consumes budget.

Epochs provide natural boundaries for several concerns:

- **Resource accounting.** Budget consumption is tracked per-epoch and cumulative. A recovered agent starts a new epoch with the cumulative budget consumption from its checkpoint, ensuring that budget limits account for total lifetime consumption, not just current-epoch consumption.
- **Side-effect tracking.** The side-effect record is scoped to the current epoch. On recovery, the agent reads the side-effect record from its checkpoint to determine which effects were committed in the prior epoch and must not be repeated.
- **Checkpoint chaining.** Each checkpoint references the previous checkpoint, forming a chain. The chain of checkpoints is the chain of epochs. This chain enables point-in-time recovery (restore from any prior epoch) and forensic analysis (examine the agent's state at any epoch boundary).
- **Observability.** Epochs provide a natural granularity for metrics, logs, and traces. Per-epoch metrics (tokens consumed, tools invoked, errors encountered, wall time) give operators a time-series view of agent behavior across its lifetime.

The epoch concept unifies several concerns that would otherwise require independent tracking mechanisms. Rather than maintaining separate counters for "tokens since last checkpoint," "side effects since last checkpoint," and "ticks since last checkpoint," the epoch provides a single temporal boundary that all subsystems reference.

---

## 5. Architecture

The architecture of the agent heartbeat and lifecycle management system is organized around four core subsystems: the **agent event loop**, which drives all agent computation through a deterministic tick cycle; the **heartbeat protocol**, which provides semantically rich health telemetry far beyond binary alive/dead signals; the **supervisor**, which consumes heartbeat streams, assesses agent health, and orchestrates recovery; and the **checkpoint store**, which persists agent state to durable storage for fault tolerance and migration. These subsystems communicate through two abstraction boundaries -- the `MessageBus` interface (backed by Redis Streams) and the `CheckpointStore` interface (backed by SQLite via better-sqlite3) -- that decouple the core protocol from its storage and transport implementations. The following sections define each subsystem in full detail, beginning with a structural overview and proceeding through the lifecycle state machine, the tick cycle, and the heartbeat protocol.

---

### 5.1 System Overview

```
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                              SYSTEM BOUNDARY                                    │
 │                                                                                 │
 │  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                           │
 │  │  Agent A     │   │  Agent B     │   │  Agent C     │                          │
 │  │ ┌─────────┐  │   │ ┌─────────┐  │   │ ┌─────────┐  │                          │
 │  │ │Tick Loop │  │   │ │Tick Loop │  │   │ │Tick Loop │  │                          │
 │  │ └────┬────┘  │   │ └────┬────┘  │   │ └────┬────┘  │                          │
 │  │      │       │   │      │       │   │      │       │                          │
 │  │  heartbeats  │   │  heartbeats  │   │  heartbeats  │                          │
 │  │  checkpoints │   │  checkpoints │   │  checkpoints │                          │
 │  └──────┼───────┘   └──────┼───────┘   └──────┼───────┘                          │
 │         │                  │                  │                                  │
 │ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ MessageBus interface ─ │
 │         │                  │                  │                                  │
 │         ▼                  ▼                  ▼                                  │
 │  ┌─────────────────────────────────────────────────┐                             │
 │  │              Redis Streams Message Bus           │                             │
 │  │                                                  │                             │
 │  │  stream:heartbeats     ◄─── agent heartbeats     │                             │
 │  │  stream:commands:{id}  ───► lifecycle commands   │                             │
 │  │  stream:events         ◄─── system events        │                             │
 │  └─────────────────┬───────────────────────────────┘                             │
 │                    │                                                             │
 │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
 │                    │                                                             │
 │                    ▼                                                             │
 │  ┌──────────────────────────────────────────────┐                                │
 │  │               SUPERVISOR                      │                                │
 │  │                                               │                                │
 │  │  ┌───────────────────┐  ┌─────────────────┐  │                                │
 │  │  │  Health Assessor   │  │ Recovery Engine  │  │                                │
 │  │  │                   │  │                  │  │                                │
 │  │  │ - Heartbeat eval  │  │ - Strategy sel.  │  │                                │
 │  │  │ - Anomaly detect  │  │ - Restart logic  │  │                                │
 │  │  │ - Trend analysis  │  │ - Checkpoint mgr │  │                                │
 │  │  └───────────────────┘  └─────────────────┘  │                                │
 │  │                                               │                                │
 │  │        lifecycle commands (pause, resume,      │                                │
 │  │         kill, checkpoint) ──────────────────►  │                                │
 │  │                          via stream:commands   │                                │
 │  └──────────────────────────┬───────────────────┘                                │
 │                             │                                                    │
 │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ CheckpointStore interface ─ ─  │
 │                             │                                                    │
 │                             ▼                                                    │
 │  ┌──────────────────────────────────────────────┐                                │
 │  │        SQLite Checkpoint Store                │                                │
 │  │        (better-sqlite3)                       │                                │
 │  │                                               │                                │
 │  │  ┌─────────┐  ┌─────────┐  ┌──────────────┐  │                                │
 │  │  │  Hot     │  │  Warm   │  │  Cold        │  │                                │
 │  │  │  (live)  │  │  (recent│  │  (archived)  │  │                                │
 │  │  └─────────┘  └─────────┘  └──────────────┘  │                                │
 │  └──────────────────────────────────────────────┘                                │
 │                                                                                 │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

Data flows through the system along two primary axes. The **telemetry axis** runs from agents upward to the supervisor: each agent's tick loop emits a heartbeat message onto the `stream:heartbeats` Redis Stream at the conclusion of every tick. The supervisor consumes this stream via a blocking `XREADGROUP` call, feeding each heartbeat into the Health Assessor for evaluation. The Health Assessor maintains a sliding window of heartbeats per agent, computing trend lines across semantic health metrics, resource consumption rates, and tick frequency. When the Health Assessor determines that an agent is degraded or critical, it hands the assessment to the Recovery Engine, which selects and executes a recovery strategy.

The **command axis** runs in the opposite direction, from the supervisor back to individual agents. The supervisor publishes lifecycle commands -- `pause`, `resume`, `kill`, `checkpoint` -- onto per-agent command streams (`stream:commands:{agentId}`). Each agent's tick loop drains its command stream at the top of every tick (step 2, "Process Inbox"), ensuring that lifecycle directives are processed before any new work is attempted. This ordering guarantee is critical: it means a `kill` command issued between ticks will always be processed before the next work unit executes.

The **persistence axis** is orthogonal to both. Agents write checkpoints directly to the SQLite CheckpointStore -- not through the message bus -- because checkpoint data can be large (serialized agent state, conversation history, effect ledger) and Redis Streams are optimized for small, high-throughput messages rather than bulk storage. The supervisor also reads from the CheckpointStore when executing recovery: it loads the most recent valid checkpoint, verifies its integrity, and passes it to a new agent instance for restoration. The CheckpointStore maintains three tiers -- hot (actively referenced by a running agent), warm (recent checkpoints retained for fast rollback), and cold (archived checkpoints moved to compressed storage) -- but these tiers are transparent to consumers of the `CheckpointStore` interface.

The two dashed boundaries in the diagram -- `MessageBus` and `CheckpointStore` -- are the system's abstraction seams. All communication between agents and the supervisor flows through the `MessageBus` interface, which defines `publish(stream, message)`, `subscribe(stream, group, consumer)`, and `ack(stream, group, id)` operations. All state persistence flows through the `CheckpointStore` interface, which defines `write(agentId, checkpoint)`, `read(agentId, version?)`, `list(agentId)`, and `archive(agentId, version)` operations. These interfaces exist so that the core lifecycle protocol can be tested against in-memory implementations and, in the future, re-targeted to different backends (e.g., NATS for the message bus, PostgreSQL for the checkpoint store) without modifying agent or supervisor code.

---

### 5.2 Agent Lifecycle State Machine

Every agent progresses through a well-defined set of lifecycle states. The state machine captures every legal transition, the events that trigger them, the preconditions that must hold, the side effects that are executed, and the hooks that are invoked to allow user-defined extension.

```
                         ┌──────────┐
                         │  UNBORN  │
                         └────┬─────┘
                              │ spawn()
                              ▼
                       ┌──────────────┐
                       │ INITIALIZING │
                       └──────┬───────┘
                              │ ready
                              ▼
                   ┌─────► RUNNING ◄─────┐
                   │          │          │
                   │    ┌─────┼─────┐   │
                   │    │     │     │   │
                   │    ▼     ▼     ▼   │
                   │ SLEEPING ERROR CHECKPOINTED
                   │    │     │     │   │
                   │    │     ▼     │   │
                   │    │ RECOVERING│   │
                   │    │     │     │   │
                   │    └─────┼─────┘   │
                   │          │         │
                   └──────────┘    (or) │
                                       │
                                  ┌────▼───┐
                                  │  DEAD  │
                                  └────┬───┘
                                       │ archive()
                                       ▼
                                 ┌──────────┐
                                 │ ARCHIVED │
                                 └──────────┘
```

The central hub of the state machine is `RUNNING`. Most transitions either exit from `RUNNING` into a satellite state or return to `RUNNING` from one. This star topology reflects the design intent: agents should spend the vast majority of their lifetime in `RUNNING`, with other states representing transient conditions (error, recovery) or deliberate pauses (sleeping, checkpointed). The only terminal states are `DEAD` and `ARCHIVED`, and the transition between them is one-way.

#### State Transition Table

| From | To | Trigger | Guards | Actions | Hooks |
|---|---|---|---|---|---|
| UNBORN | INITIALIZING | `spawn()` | -- | Allocate agent ID, create checkpoint slot | `PRE_SPAWN` |
| INITIALIZING | RUNNING | `ready` | Init complete, health check passes | Start tick loop, emit first heartbeat | `POST_SPAWN`, `ON_INITIALIZE` |
| INITIALIZING | ERROR | `init_error` | Init throws or times out | Log error, preserve init context | `ON_ERROR` |
| RUNNING | SLEEPING | `sleep(duration)` | No pending effects | Pause tick loop, emit final heartbeat | `ON_SLEEP` |
| RUNNING | ERROR | `error` | Unhandled exception in tick | Stop tick loop, emit error heartbeat | `ON_ERROR` |
| RUNNING | CHECKPOINTED | `checkpoint()` | No in-flight tool calls | Serialize state, write to store | `PRE_CHECKPOINT`, `POST_CHECKPOINT` |
| RUNNING | DEAD | `kill()` / `budget_exhausted` | -- | Stop tick loop, finalize effects, emit death heartbeat | `PRE_DEATH`, `ON_DEATH` |
| SLEEPING | RUNNING | `wake()` / `timer_expired` | Budget remaining | Resume tick loop | `ON_WAKE` |
| SLEEPING | DEAD | `kill()` | -- | Finalize effects | `PRE_DEATH`, `ON_DEATH` |
| ERROR | RECOVERING | `recover()` | Recovery attempts < max | Select recovery strategy | `PRE_RECOVERY` |
| ERROR | DEAD | `abandon()` / `max_retries` | -- | Emit summary, finalize | `PRE_DEATH`, `ON_DEATH` |
| CHECKPOINTED | RUNNING | `resume()` | Checkpoint valid | Restore state, resume tick | `POST_RESTORE` |
| CHECKPOINTED | RECOVERING | `restore_failed` | Checkpoint corrupted | Try previous checkpoint | `PRE_RECOVERY` |
| RECOVERING | RUNNING | `recovery_success` | Health check passes | Resume tick loop with new state | `POST_RECOVERY` |
| RECOVERING | ERROR | `recovery_failed` | Strategy exhausted | Escalate to next strategy | `ON_ERROR` |
| RECOVERING | DEAD | `all_strategies_exhausted` | -- | Emit final summary | `PRE_DEATH`, `ON_DEATH` |
| DEAD | ARCHIVED | `archive()` | Finalization complete | Move checkpoint to cold storage | `ON_ARCHIVE` |

#### Design Rationale

**SLEEPING vs. CHECKPOINTED.** These states may appear similar -- both represent an agent that is not actively executing work -- but they encode fundamentally different intents. `SLEEPING` is a voluntary, temporary pause: the agent expects to resume in the same process, in the same memory space, after a specified duration or external wake signal. The tick loop is paused but not torn down; the agent's in-memory state is preserved. `CHECKPOINTED`, by contrast, is a persistence event. The agent's full state has been serialized to the CheckpointStore, and the system makes no guarantee about whether resumption will occur in the same process, on the same machine, or at all. A checkpointed agent may be restored minutes later after a preemptive budget save, or it may be restored days later on a different node as part of a migration. The distinction matters because it determines what resources the runtime must keep allocated: a sleeping agent holds its memory, file handles, and context window contents; a checkpointed agent releases them.

**RECOVERING as a distinct state.** Recovery is not an instantaneous operation. It may involve loading a checkpoint from the store, validating its integrity, replaying a subset of the effect ledger, re-establishing connections to external tools, and running a post-recovery health check. This process can span multiple ticks and may require coordination with the supervisor (e.g., to obtain a fresh API key, to be assigned to a different task, or to have sub-agents re-spawned). Modeling recovery as a distinct state rather than a sub-case of `RUNNING` or `ERROR` provides three benefits: it makes the agent's status unambiguous to the supervisor (an agent in `RECOVERING` should not receive new work), it enables recovery-specific hooks (`PRE_RECOVERY`, `POST_RECOVERY`) that allow user code to participate in the recovery process, and it allows the supervisor to apply different health assessment thresholds to recovering agents (e.g., tolerating slower tick rates during state restoration).

**DEAD vs. ARCHIVED.** A `DEAD` agent has ceased execution but its artifacts -- checkpoints, heartbeat history, effect ledger, error logs -- remain in hot storage and are immediately accessible for inspection. This is essential for post-mortem analysis: when an agent dies unexpectedly, operators need to examine its final state, its heartbeat trend leading up to death, and its last checkpoint. The `ARCHIVED` state represents the completion of this inspection window. Once an agent is archived, its checkpoints are moved to cold storage (compressed, possibly offloaded to a different storage tier), and its heartbeat history is summarized into an aggregate record. The transition from `DEAD` to `ARCHIVED` is never automatic -- it must be explicitly triggered by the `archive()` call, which may be invoked by an operator, a retention policy, or a supervisor cleanup routine. The guard requiring `finalization complete` ensures that no pending effects are left unresolved before archival.

---

### 5.3 The Tick Cycle

The tick is the atomic unit of agent work. Every meaningful action an agent takes -- reading a message, calling an LLM, executing a tool, emitting a heartbeat -- happens within the boundary of a single tick. Ticks are sequentially numbered starting from 0 within each epoch (an epoch is a continuous run from spawn or restore to death or checkpoint). The tick cycle is deliberately synchronous within a single agent: there is no concurrent execution of multiple ticks, which eliminates an entire class of race conditions around state mutation and effect tracking.

```
┌──────────────────────────────────────────────┐
│                  TICK N                        │
├──────────────────────────────────────────────┤
│                                               │
│  1. Budget Check                              │
│     ├── tokens remaining > threshold?         │
│     ├── cost < budget limit?                  │
│     └── wall time < max duration?             │
│                                               │
│  2. Process Inbox                             │
│     ├── Lifecycle commands (pause, kill, etc)  │
│     ├── Work items (new tasks, messages)       │
│     └── Sub-agent results                     │
│                                               │
│  3. Execute Work Unit                         │
│     ├── Register intent in effect ledger      │
│     ├── LLM call (prompt → completion)        │
│     ├── Tool execution (if requested)         │
│     └── Mark effects as committed             │
│                                               │
│  4. Emit Heartbeat                            │
│     ├── Semantic health metrics               │
│     ├── Resource consumption update           │
│     └── Execution metadata                    │
│                                               │
│  5. Conditional Checkpoint                    │
│     ├── Every N ticks?                        │
│     ├── Significant state change?             │
│     └── Budget threshold crossed?             │
│                                               │
│  6. Yield                                     │
│     └── await next tick (adaptive interval)   │
│                                               │
└──────────────────────────────────────────────┘
```

#### Step 1: Budget Check

The tick begins with a budget check because no work should be initiated if the agent cannot pay for it. Three resource dimensions are evaluated: token budget (does the agent have enough tokens remaining to make at least one LLM call?), cost budget (has the agent's cumulative spend exceeded its USD cost ceiling?), and wall time (has the agent been running longer than its maximum allowed duration?). Each dimension has both a hard limit and a soft limit. Crossing a soft limit triggers a warning heartbeat and initiates a preemptive checkpoint -- the agent serializes its state to the CheckpointStore so that work can be resumed later with a replenished budget. Crossing a hard limit triggers an immediate transition to `DEAD` via the `budget_exhausted` trigger.

The budget check runs first -- before inbox processing, before any LLM calls -- because the alternative leads to a pathological failure mode. If an agent processes its inbox before checking its budget, it might accept a new task assignment, begin reasoning about it, and then discover mid-execution that it cannot afford to complete the work. This wastes tokens on aborted reasoning and leaves the task in an ambiguous state (assigned but not completed, with partial effects that may need rollback). By checking the budget first, the agent can cleanly refuse new work and checkpoint itself while it still has enough budget to serialize its state.

Edge cases in budget checking include token estimation uncertainty (the agent cannot know exactly how many tokens its next LLM call will consume, so it uses a configurable headroom multiplier, defaulting to 1.5x the estimated prompt size) and race conditions between the budget check and actual API calls (the check is advisory; the actual enforcement happens at the API layer, and the agent must handle mid-call budget exhaustion gracefully by catching the error and transitioning to `DEAD` with whatever state it can salvage).

#### Step 2: Process Inbox

After confirming that the budget permits continued execution, the agent drains its inbox by reading from its per-agent command stream (`stream:commands:{agentId}`) via the MessageBus interface. Messages are processed in a strict priority order: lifecycle commands first, then work items, then sub-agent results. This priority ordering ensures that a `kill` command is never starved by a flood of incoming work items, and that the agent's lifecycle state is always consistent before it attempts to process application-level messages.

Lifecycle commands (`pause`, `resume`, `kill`, `checkpoint`) are handled immediately and may short-circuit the rest of the tick. A `kill` command, for example, causes the agent to skip steps 3-5 entirely, emit a final death heartbeat, and transition to `DEAD`. A `pause` command transitions the agent to `SLEEPING` and suspends the tick loop. A `checkpoint` command causes the agent to serialize its state and transition to `CHECKPOINTED`. Only `resume` (which is a no-op if the agent is already `RUNNING`) allows the tick to continue normally. Work items and sub-agent results are appended to the agent's internal task queue for processing in step 3.

Processing the inbox in step 2 -- after the budget check but before execution -- creates an important correctness property: the agent never executes work on stale instructions. If the supervisor has issued a `kill` command because it detected the agent is stuck, the agent will see that command before it wastes another tick on the stuck task. If a parent agent has reassigned the task to a different agent, the inbox will contain a cancellation message that prevents the agent from duplicating work. The inbox is drained completely (not just one message per tick) to prevent command backlogs during periods of high message volume.

Error handling during inbox processing is lenient: malformed messages are logged and acknowledged (to prevent redelivery) but do not cause the tick to fail. A corrupted work item should not kill an otherwise healthy agent. However, malformed lifecycle commands are treated more seriously -- they are logged at the `error` level and a degraded heartbeat is emitted to alert the supervisor that the command stream may be compromised.

#### Step 3: Execute Work Unit

This is the step where the agent performs actual work. Execution is wrapped in the effect ledger pattern: before any externally visible action is taken, the agent registers its *intent* in the effect ledger (an append-only log of planned actions). The intent record includes a unique effect ID, a timestamp, a description of the planned action (e.g., "call LLM with prompt X", "execute tool Y with arguments Z"), and a status of `pending`. After the action completes successfully, the effect record is updated to `committed`. If the action fails, the record is updated to `failed` with the error details. If the agent dies mid-action, the record remains `pending`, which allows the recovery engine to determine exactly where the agent stopped and whether the action needs to be retried or rolled back.

The work unit itself follows a predictable pattern: the agent constructs a prompt from its current task state and conversation history, sends it to the LLM API, and processes the completion. If the completion includes a tool call request, the agent executes the tool within the same tick, feeds the result back into its state, and (depending on the agent's configuration) may make a follow-up LLM call within the same tick or defer it to the next tick. The single-tick-single-LLM-call model is simpler and easier to reason about, but multi-call ticks are supported for agents that need tight tool-use loops without the overhead of a full tick cycle between each call.

Tool execution is the most dangerous part of the tick because tools have side effects that may not be reversible. The effect ledger mitigates this by providing an audit trail, but it cannot undo an HTTP request that has already been sent. For this reason, tools are classified into three risk tiers: `pure` (read-only, always safe to retry), `idempotent` (has side effects but can be safely re-executed), and `effectful` (has side effects that cannot be undone). The agent's behavior during recovery depends on the risk tier of the last pending effect: `pure` and `idempotent` effects are retried automatically; `effectful` effects require human approval or are skipped with a warning.

#### Step 4: Emit Heartbeat

After executing the work unit (or after skipping it due to an empty task queue), the agent emits a heartbeat onto the `stream:heartbeats` Redis Stream. The heartbeat is constructed by sampling the agent's current state across three dimensions: semantic health (self-assessed progress, coherence, confidence, and stuck-tick counter), resource consumption (tokens used, cost incurred, wall time elapsed), and execution metadata (current lifecycle state, active tools, pending effects, tick timing). The full heartbeat structure is defined in section 5.4.

The heartbeat is emitted *after* execution rather than before because the post-execution heartbeat carries strictly more information. A pre-execution heartbeat could report the agent's state at the beginning of the tick, but it would miss the results of the work unit: whether the LLM call succeeded, whether a tool execution changed the agent's progress, whether the token consumption rate spiked. The post-execution heartbeat captures all of this, giving the supervisor the most up-to-date picture of the agent's condition.

Heartbeat emission is designed to be infallible from the agent's perspective. If the MessageBus is temporarily unavailable (e.g., Redis is restarting), the heartbeat is buffered in memory and retried on the next tick. The agent does not block waiting for heartbeat delivery -- the `publish` call is fire-and-forget with an in-memory retry queue. However, if heartbeats fail to deliver for more than a configurable number of consecutive ticks (default: 5), the agent transitions to `ERROR` because it can no longer be monitored. An unmonitorable agent is, from the system's perspective, as dangerous as a crashed one.

#### Step 5: Conditional Checkpoint

Not every tick produces a checkpoint. Checkpointing is expensive -- it requires serializing the agent's full state (conversation history, task queue, effect ledger, tool state, and any user-defined state held by the agent subclass) to JSON and writing it to the SQLite CheckpointStore. For an agent with a large conversation history, this can take tens of milliseconds and produce megabytes of data. The system therefore uses a conditional checkpoint strategy, evaluating three triggers at the end of each tick.

The first trigger is periodic: every N ticks (configurable, default 10), the agent checkpoints regardless of other conditions. This provides a guaranteed upper bound on work loss -- at most N ticks of progress can be lost in a crash. The second trigger is semantic: the agent checkpoints when it detects a "significant state change," defined as a transition in the task queue (task completed, new task accepted), a change in lifecycle state, or a user-defined significance predicate. The third trigger is budgetary: when the agent's remaining budget crosses a threshold (default: 20% remaining), it checkpoints to ensure that the work completed so far is preserved even if the budget runs out before the next periodic checkpoint.

When a checkpoint is triggered, the agent transitions to `CHECKPOINTED`, which invokes the `PRE_CHECKPOINT` and `POST_CHECKPOINT` hooks. The `PRE_CHECKPOINT` hook allows user code to prepare for serialization (e.g., flushing caches, closing file handles that cannot be serialized). The `POST_CHECKPOINT` hook allows user code to react to a successful checkpoint (e.g., logging, emitting metrics). If the checkpoint write fails (disk full, database locked), the agent emits a degraded heartbeat and continues running -- a failed checkpoint is not a fatal error, but it does mean the agent is operating without a safety net until the next successful checkpoint.

#### Step 6: Yield

The final step of the tick is a yield -- the agent releases control and waits for the next tick to be scheduled. The yield duration is adaptive, governed by the agent's current activity level and lifecycle state. The adaptive tick rate operates across four regimes.

When the agent is actively executing work (step 3 produced an LLM call and/or tool execution), the yield duration is 0-100ms. The lower bound is 0ms (immediate next tick) when the agent has more work queued; the upper bound is 100ms when the agent's task queue is empty but it expects new work shortly. The exact duration within this range is determined by a simple heuristic: if the last tick's LLM call returned a tool-use request, the next tick should begin immediately (0ms) to process the tool result; otherwise, a brief pause (50-100ms) reduces unnecessary CPU consumption.

When the agent is waiting for external input (its task queue is empty and no sub-agent results are pending), the yield duration extends to 1-5 seconds. This regime is appropriate when the agent has been assigned a task that depends on human input, an external API callback, or a sub-agent that is still working. The longer interval reduces the agent's resource footprint while still allowing reasonably prompt response when input arrives.

When the agent is in the `SLEEPING` state, the yield duration extends further to 30-60 seconds. Sleeping agents are not executing work and do not need fast response times, but they must still emit heartbeats so that the supervisor knows they are alive. The 30-60 second interval is calibrated against the supervisor's heartbeat timeout (default: 90 seconds), ensuring that at least one heartbeat is emitted per timeout window even in the worst case (60-second yield + heartbeat emission time < 90-second timeout).

The tick rate is itself a diagnostic signal. The supervisor monitors each agent's `tickRate` (reported in the heartbeat's execution metadata) and compares it against the expected rate for the agent's current state. An agent that reports `state: RUNNING` but whose tick rate has dropped to sleeping-regime levels is likely stuck -- perhaps blocked on an LLM call that is not returning, or caught in an infinite loop that does not yield. This tick-rate anomaly detection is one of the supervisor's primary tools for identifying agents that are alive but not making progress, a failure mode that binary alive/dead health checks cannot detect.

---

### 5.4 Heartbeat Protocol

The heartbeat is the primary communication channel between agents and the supervisor. Unlike traditional health check systems that model liveness as a binary predicate ("is the process responding to pings?"), this protocol treats the heartbeat as a rich telemetry payload that answers a fundamentally different question: *is the agent making meaningful progress toward its goal?* A process can be alive, responsive, and burning tokens at full speed while producing no useful output -- looping, hallucinating, or pursuing a dead-end strategy. The heartbeat protocol is designed to detect and surface these failure modes.

#### Message Structure

Every heartbeat is a JSON-serialized object conforming to the following TypeScript interface:

```typescript
interface Heartbeat {
  // Identity
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;

  // Semantic Health
  health: {
    status: 'healthy' | 'degraded' | 'critical';
    progress: number;        // 0-1, self-assessed task progress
    coherence: number;       // 0-1, self-assessed output quality
    confidence: number;      // 0-1, confidence in current approach
    stuckTicks: number;      // consecutive ticks with no meaningful progress
    lastMeaningfulAction: string;
  };

  // Resource Consumption
  resources: {
    tokensUsed: number;
    tokensRemaining: number;
    estimatedCostUsd: number;
    wallTimeMs: number;
    apiCalls: number;
    toolInvocations: number;
  };

  // Execution Metadata
  execution: {
    state: LifecycleState;
    currentTask: string | null;
    activeTools: string[];
    pendingEffects: number;
    subAgents: string[];
    contextWindowUsage: number;  // 0-1, how full is the context window
    tickDurationMs: number;
    tickRate: number;            // ticks per second
  };
}
```

The `agentId` field uniquely identifies the agent across the entire system. The `epoch` field is a monotonically increasing integer that increments each time the agent is spawned or restored from a checkpoint; it disambiguates heartbeats from different incarnations of the same logical agent. The `tick` field is the sequential tick number within the current epoch. Together, the tuple `(agentId, epoch, tick)` uniquely identifies every heartbeat in the system and establishes a total ordering over an agent's history. The `timestamp` field is a Unix epoch millisecond timestamp used for wall-clock correlation and timeout computation.

#### Semantic Health

The semantic health section is the radical departure from conventional health monitoring. Traditional systems ask "is the process alive?" -- a question that can be answered with a TCP connection, an HTTP 200, or a simple ping-pong. This system asks four richer questions: Is the agent making progress? Is its output coherent? Is it confident in its approach? Is it stuck?

**`progress`** is a float in the range [0, 1] representing the agent's self-assessment of how far it has advanced toward completing its current task. The agent computes this by comparing its current state against the task's completion criteria (if explicitly defined) or by estimating the fraction of sub-goals it has accomplished (if the task is decomposed). A progress value that has not increased over the last K ticks (configurable, default 5) causes `stuckTicks` to increment, even if the agent is actively executing work. Progress is deliberately subjective -- it reflects the agent's own assessment, not an objective measurement -- because the agent has the richest context about what constitutes forward motion for its particular task.

**`coherence`** is a float in the range [0, 1] representing the agent's self-assessment of the quality and internal consistency of its recent outputs. This metric is computed by the agent at the end of each tick by comparing the semantic content of its most recent LLM completion against the task objective and its previous outputs. A coherence score below 0.5 indicates that the agent's outputs are drifting off-topic, contradicting earlier reasoning, or degenerating into repetitive patterns. The agent computes coherence using a lightweight heuristic: it checks whether the most recent completion references the task objective, whether it introduces new information or repeats previous content, and whether tool calls (if any) are consistent with the stated plan. This heuristic is imperfect, which is why coherence is cross-referenced by the supervisor (see trust model below).

**`confidence`** is a float in the range [0, 1] representing the agent's self-assessment of whether its current approach is likely to succeed. High confidence (> 0.8) indicates that the agent has a clear plan and is executing it; medium confidence (0.4-0.8) indicates uncertainty about the approach but continued progress; low confidence (< 0.4) indicates that the agent is exploring, backtracking, or unsure how to proceed. The supervisor uses confidence in conjunction with progress to distinguish productive exploration (low confidence but increasing progress) from unproductive flailing (low confidence and stagnant progress). A sustained drop in confidence over multiple ticks is a signal that the agent may benefit from external intervention -- a hint, a task reassignment, or a fresh start from checkpoint.

**`stuckTicks`** is an integer counting the number of consecutive ticks during which `progress` has not increased by more than a configurable epsilon (default: 0.01). This counter resets to 0 whenever meaningful progress is detected. The supervisor uses `stuckTicks` as a primary input to its health assessment: an agent with `stuckTicks > 10` and `confidence < 0.3` is almost certainly stuck and a candidate for recovery. `stuckTicks` is more reliable than any individual metric because it captures a temporal pattern rather than a point-in-time measurement.

**`lastMeaningfulAction`** is a human-readable string describing the most recent action that the agent considers to have made progress. Examples include `"completed subtask 3 of 7"`, `"found root cause of bug in auth module"`, or `"generated test cases for parser"`. This field exists primarily for debugging and operator visibility -- it appears in the supervisor's dashboard and in post-mortem reports. It is not used in automated health assessment because its free-text format makes programmatic interpretation unreliable.

**The trust model.** Semantic health metrics are self-reported, which raises an obvious concern: agents can lie. An agent caught in a hallucination loop might sincerely believe it is making progress and report `progress: 0.7, coherence: 0.9`. The system addresses this through a trust-but-verify model. The supervisor cross-references self-reported health metrics against objective signals that the agent cannot fabricate: resource consumption patterns (is token usage consistent with reported progress?), tick rate (is the agent processing at a rate consistent with the work it claims to be doing?), and output analysis (the supervisor can sample the agent's recent LLM completions and independently assess coherence). When the supervisor detects a divergence between self-reported health and objective signals -- for example, an agent reporting `progress: 0.8` but whose token consumption has plateaued and whose last 5 completions are semantically identical -- it overrides the agent's self-assessment and marks it as `degraded` or `critical`.

The trust model is deliberately asymmetric: the supervisor trusts pessimistic self-assessments more than optimistic ones. An agent that reports `confidence: 0.2` is almost certainly telling the truth (there is no incentive to under-report confidence), so the supervisor acts on it immediately. An agent that reports `confidence: 0.95` while its `stuckTicks` is climbing is probably wrong, and the supervisor applies additional scrutiny. This asymmetry reflects a fundamental property of LLM-based agents: they are more likely to be overconfident than underconfident, because the underlying models are trained to produce fluent, assertive outputs even when uncertain.

#### Resource Consumption

The resource consumption section provides real-time tracking of the agent's expenditure across six dimensions. These metrics serve two purposes: budget enforcement (preventing agents from exceeding their allocated resources) and predictive management (projecting future consumption to enable preemptive action).

**`tokensUsed`** and **`tokensRemaining`** track the agent's cumulative token consumption against its allocated budget. The supervisor uses these values to compute a burn rate (tokens per tick, tokens per minute) and project when the agent will exhaust its budget. If the projected exhaustion time falls below a threshold (default: 5 minutes or 50 ticks, whichever comes first), the supervisor issues a `checkpoint` command to preserve the agent's progress before the budget runs out. This preemptive checkpointing is one of the system's most important safety mechanisms: without it, an agent that runs out of tokens mid-task loses all progress since its last checkpoint.

**`estimatedCostUsd`** is a running dollar-cost estimate derived from token usage and the pricing schedule of the underlying LLM provider. This value is inherently approximate because pricing may vary by model, by time of day, or by volume tier, but it is accurate enough for budget management purposes. The system supports both hard cost limits (the agent is killed immediately when the limit is reached) and soft cost limits (the agent is warned and checkpointed when the limit is approached). The distinction between hard and soft limits is configured per-agent at spawn time and can be updated at runtime via the supervisor.

**`wallTimeMs`** tracks the total elapsed wall-clock time since the agent was spawned or last restored from checkpoint. Wall time is an important resource dimension independent of token consumption because some failure modes (e.g., an agent blocked on a non-responding external API) consume wall time without consuming tokens. The supervisor applies wall-time limits to detect agents that are alive but frozen -- making no API calls, consuming no tokens, but also making no progress.

**`apiCalls`** and **`toolInvocations`** count the number of LLM API calls and tool executions, respectively, since the start of the current epoch. These counters provide a coarser-grained view of activity than token counts but are useful for anomaly detection: an agent making hundreds of API calls per tick is probably in a loop, and an agent making zero tool invocations over many ticks when its task requires tool use is probably stuck or confused.

The resource consumption data enables the supervisor to implement predictive budget management. By fitting a linear regression to the last N heartbeats' token consumption values, the supervisor can estimate the tick at which each resource dimension will hit its limit. When the projected exhaustion falls within a configurable danger zone, the supervisor takes action: it may issue a `checkpoint` command (preserving progress), a `pause` command (preventing further consumption while a human reviews the situation), or a `kill` command (if the agent has already been warned and continues to consume resources at an unsustainable rate). The choice of action depends on the resource dimension and the severity of the projection, as defined in the supervisor's policy configuration.

#### Execution Metadata

The execution metadata section provides operational context that the supervisor uses for scheduling, anomaly detection, and safe lifecycle management.

**`state`** is the agent's current lifecycle state as defined by the state machine in section 5.2. This field is redundant with the state transitions emitted on the event stream, but it is included in every heartbeat for consistency: the supervisor can reconstruct any agent's current state from its most recent heartbeat alone, without needing to replay the event stream.

**`currentTask`** is the identifier of the task the agent is currently working on, or `null` if the agent is idle. The supervisor uses this field to detect task-agent affinity issues (e.g., two agents working on the same task due to a coordination bug) and to route recovery decisions (e.g., reassigning the task to a different agent if recovery fails).

**`activeTools`** lists the names of tools that the agent has invoked in the current tick but that have not yet returned results. This field is important for safe lifecycle management: an agent with active tools should not be killed without first waiting for those tools to complete or explicitly canceling them, because tool executions may have side effects that need to be either committed or rolled back.

**`pendingEffects`** is the count of entries in the agent's effect ledger that are in `pending` status -- actions that have been registered as intended but not yet confirmed as committed or failed. This is the supervisor's primary input for determining whether an agent can be safely killed. An agent with `pendingEffects: 0` can be killed at any time without risk of orphaned side effects. An agent with `pendingEffects > 0` should either be allowed to complete its current tick (which will resolve the pending effects) or have its pending effects explicitly rolled back before termination.

**`subAgents`** lists the IDs of any sub-agents that this agent has spawned. The supervisor uses this information to manage cascading lifecycle events: when a parent agent is killed, its sub-agents must be notified and either killed, reassigned, or orphaned (depending on the configured orphan policy). This field also enables the supervisor to construct the full agent hierarchy tree, which is essential for understanding resource consumption at the task level (a parent agent's true cost includes the cost of all its sub-agents).

**`contextWindowUsage`** is a float in the range [0, 1] representing the fraction of the LLM's context window that is currently occupied by the agent's conversation history, system prompt, and pending tool results. This metric is critical because context window exhaustion is a hard failure that cannot be recovered from gracefully -- once the context window is full, the agent cannot make any more LLM calls without truncating its history, which may cause it to lose important context and degrade its performance. The supervisor monitors `contextWindowUsage` and triggers preemptive action when it exceeds a threshold (default: 0.85): it may issue a `checkpoint` command (allowing the agent to restart with a compacted context), or it may send a `compact` command that instructs the agent to summarize its conversation history before the next LLM call.

**`tickDurationMs`** is the wall-clock duration of the most recent tick, from the start of the budget check (step 1) to the completion of the yield (step 6). **`tickRate`** is the inverse, expressed as ticks per second. Together, these fields enable the supervisor's tick-rate anomaly detection. Each agent state has an expected tick rate regime (see section 5.3, step 6), and deviations from the expected regime are flagged. A `RUNNING` agent with a tick rate below 0.1 ticks/second (one tick every 10 seconds) is almost certainly blocked on something -- an LLM call that is not returning, a tool execution that is hanging, or a bug in the tick loop itself. Conversely, a `RUNNING` agent with a tick rate above 100 ticks/second is probably in a tight loop that is not doing useful work (each tick should include at least one LLM call, which takes at least 100-500ms). Both anomalies trigger supervisor investigation.

---

### 5.5 Supervisor Architecture

The supervisor is the central authority responsible for monitoring agent health and orchestrating recovery. Its design draws directly from Erlang/OTP's supervisor behaviour, but departs in critical ways to accommodate the unique failure modes of LLM-backed agents: hallucination spirals, context corruption, budget exhaustion, and coherence degradation have no analogue in traditional process supervision. Where Erlang supervisors make binary alive-or-dead determinations, our supervisor must reason about a continuous spectrum of agent health.

The supervisor is itself a long-lived process that consumes the heartbeat stream from the message bus and emits lifecycle commands back onto it. It does not directly manage agent processes; all interaction is mediated through Redis Streams. This decoupling means the supervisor can be restarted independently of the agents it monitors, and multiple supervisors can be arranged in a tree (with parent supervisors monitoring child supervisors, exactly as in OTP).

```
┌─────────────────────────────────────────────────┐
│                   SUPERVISOR                     │
│                                                  │
│  ┌─────────────────────┐  ┌──────────────────┐  │
│  │   Health Assessor   │  │  Recovery Engine  │  │
│  │                     │  │                   │  │
│  │  • Policy Engine    │  │  • Strategy       │  │
│  │  • Anomaly Detector │──▶    Selector       │  │
│  │  • Budget Predictor │  │  • Executor       │  │
│  │  • Trend Analyzer   │  │  • Verifier       │  │
│  └────────┬────────────┘  └───────┬──────────┘  │
│           │                       │              │
│           │    heartbeats in      │ commands out │
│  ─────────┴───────────────────────┴──────────    │
│              Message Bus (Redis Streams)          │
└─────────────────────────────────────────────────┘
```

The supervisor's internal architecture is split into two cooperating subsystems: the **Health Assessor**, which transforms raw heartbeat telemetry into health verdicts, and the **Recovery Engine**, which maps those verdicts to concrete recovery actions. This separation of concerns ensures that health evaluation logic can evolve independently of recovery strategy logic, and that the same health assessor can feed different recovery engines in different deployment configurations.

#### Health Assessor

The Health Assessor consumes the heartbeat stream and evaluates agent health against configurable policies. It produces a `HealthVerdict` for each agent on every evaluation cycle. A verdict is not simply "healthy" or "unhealthy" -- it is a structured object containing the assessed health level, the specific policies that fired, trend data, and a recommended action. The Health Assessor is composed of four components that run in sequence, each enriching the verdict with additional signal.

**Policy Engine** -- The first line of evaluation. The Policy Engine applies a set of declarative rules to the latest heartbeat and the agent's recent heartbeat history. Policies are composable: each policy is an independent predicate that evaluates to a severity level, and the engine combines them using configurable aggregation (worst-of, majority-vote, or weighted). Policies are configurable per agent, per agent type, or globally, with per-agent overrides taking precedence.

Default policies include:

- `missed_heartbeats`: "3 consecutive missed heartbeats triggers ERROR." A missed heartbeat means the supervisor's evaluation cycle ran and no new heartbeat was found for this agent since the last cycle. Three consecutive misses strongly implies the agent process has died, is deadlocked, or has lost connectivity to the message bus.
- `stuck_detection`: "stuckTicks > 5 triggers DEGRADED." If the agent's `stuckTicks` counter (reported in the heartbeat) exceeds the threshold, the agent is likely looping without making progress. This catches infinite loops, tool call retries that never succeed, and LLM responses that keep repeating the same action.
- `budget_preemption`: "budget usage > 90% triggers preemptive checkpoint." Rather than waiting for budget exhaustion to crash the agent, this policy triggers a checkpoint while the agent still has headroom. The agent can then either continue with reduced allocation or be gracefully paused.
- `coherence_spiral`: "coherence < 0.3 for 3 consecutive ticks triggers CRITICAL." A single low-coherence tick is common and harmless -- the model occasionally produces a less-relevant response. But sustained low coherence is the signature of a hallucination spiral, where the model has drifted into a self-reinforcing loop of confabulation. Three ticks is the empirically determined threshold where intervention is cheaper than allowing the spiral to continue.

```typescript
interface HealthPolicy {
  id: string;
  name: string;
  description: string;

  /** Which agents this policy applies to. Glob patterns on agent ID or agent type. */
  appliesTo: string[];

  /** The evaluation function. Returns null if the policy does not fire. */
  evaluate(
    current: Heartbeat,
    history: Heartbeat[],
    context: PolicyContext,
  ): PolicyResult | null;

  /** Severity when this policy fires. */
  severity: 'warning' | 'degraded' | 'error' | 'critical';

  /** Cooldown: minimum ticks between firings to prevent alert storms. */
  cooldownTicks: number;
}

interface PolicyResult {
  policyId: string;
  severity: 'warning' | 'degraded' | 'error' | 'critical';
  message: string;
  recommendedAction?: RecoveryStrategyType;
  metadata: Record<string, unknown>;
}

interface PolicyContext {
  agentConfig: AgentConfig;
  supervisorConfig: SupervisorConfig;
  currentTick: number;
  timeSinceLastHeartbeat: number;
}
```

**Anomaly Detector** -- The Policy Engine evaluates known failure patterns. The Anomaly Detector catches unknown ones. It operates on statistical deviation from an agent's established behavioral baseline, flagging heartbeats whose metrics fall outside expected ranges. This is not ML-based anomaly detection (which would add unacceptable complexity and latency); it is simple sliding-window statistics: maintain a rolling mean and standard deviation for each metric, flag values beyond configurable sigma thresholds.

The Anomaly Detector is particularly effective at catching:

- **Tick rate collapse**: The agent's tick interval suddenly increases by 10x or more. This often indicates the agent is stuck in a long-running tool call, waiting on an unresponsive external API, or has entered a code path with unexpected blocking I/O. The Policy Engine's stuck detection may not fire because the agent is technically still ticking, just very slowly.
- **Token consumption spikes**: The agent's per-tick token usage jumps far above its historical average without a corresponding increase in task completion. This pattern suggests the model is generating verbose, repetitive output (early hallucination) or that the context has been polluted with extraneous content (prompt injection or tool output explosion).
- **Context window jumps**: A sudden increase in `contextWindowUsage` without corresponding conversation growth suggests that external content has been injected into the context -- either through a tool result that returned far more data than expected, or through a deliberate prompt injection attack. Either way, the context is now polluted and may need reconstruction.

**Budget Predictor** -- Projects resource consumption forward in time using linear regression over the agent's recent consumption history. The predictor answers the question: "At this agent's current burn rate, when will it exhaust each budget category?" This enables the supervisor to take preemptive action rather than reacting to exhaustion after the fact.

The predictor maintains separate projections for token budget, wall-clock time budget, and API call budget. When any projection crosses a configurable threshold (default: 85% of budget consumed with fewer than 50% of tasks completed), it emits a budget warning that the Policy Engine incorporates into its verdict. The canonical output is: "At current burn rate, this agent will exhaust its token budget in 47 ticks. Recommend checkpoint at tick 40 and preemptive pause at tick 45."

Budget prediction is inherently approximate -- agent consumption is not constant, and task complexity varies. The predictor uses a weighted linear regression that emphasizes recent ticks (exponential decay weighting) to adapt to changing consumption patterns. It also incorporates task-queue depth: an agent with 2 remaining tasks and 80% budget consumed is in better shape than one with 20 remaining tasks and the same budget.

**Trend Analyzer** -- The final component before verdict synthesis. The Trend Analyzer looks at health metrics over configurable sliding windows (default: 10, 30, and 100 ticks) and identifies trends that individual-tick evaluation misses. Its core insight is that the direction and velocity of metric changes matter as much as their absolute values.

A single low-coherence tick is noise. Five consecutive low-coherence ticks is a hallucination spiral. A coherence value of 0.5 that has been steadily declining from 0.9 over 20 ticks is more concerning than a coherence value of 0.4 that has been stable for 100 ticks. The Trend Analyzer captures these dynamics by computing first and second derivatives of key metrics over each window and flagging sustained adverse trends.

The Trend Analyzer prevents two pathological supervisor behaviors: **over-reaction** (killing an agent for a single bad tick that would have self-corrected) and **under-reaction** (ignoring a slow degradation that never triggers any single-tick threshold but accumulates to failure). Both pathologies are common in naive monitoring systems and both are expensive: over-reaction wastes recovery resources, under-reaction wastes agent runtime on doomed execution.

#### Recovery Engine

Once the Health Assessor produces a verdict, the Recovery Engine selects and executes the appropriate recovery strategy. The Recovery Engine is deliberately separated from the Health Assessor because health evaluation and recovery execution have different concerns: evaluation must be fast, stateless, and side-effect-free; execution is slow, stateful, and has significant side effects. The Recovery Engine is composed of three subcomponents.

**Strategy Selector** -- Maps health verdicts to recovery strategies using a configurable decision tree. The default mapping is deterministic: given a verdict of a particular severity with particular policy firings, the same strategy is always selected. This determinism is critical for debugging and for building operator trust -- the supervisor must be predictable. The decision tree can be overridden per-agent or per-agent-type, allowing different recovery postures for different workloads (e.g., a safety-critical agent might escalate to human at WARNING level, while a batch-processing agent might tolerate DEGRADED indefinitely).

The default decision tree:

| Verdict Severity | Primary Policy | Selected Strategy |
|---|---|---|
| WARNING | `missed_heartbeats` (1-2 misses) | No action (log only) |
| WARNING | `budget_preemption` | Preemptive checkpoint |
| DEGRADED | `stuck_detection` | Hot Restart |
| DEGRADED | `coherence_spiral` (short) | Hot Restart with context trim |
| ERROR | `missed_heartbeats` (3+ misses) | Warm Restart |
| ERROR | `stuck_detection` (persistent) | Warm Restart |
| CRITICAL | `coherence_spiral` (sustained) | Context Reconstruction |
| CRITICAL | Budget exhaustion | Escalate to Human |
| CRITICAL | Multiple policies firing | Fresh Start with Briefing |
| CRITICAL | Safety policy violation | Escalate to Human |

**Executor** -- Runs the selected recovery strategy. Execution is itself a multi-step process: the executor must coordinate with the agent (via lifecycle commands on the message bus), with the checkpoint store (for reading and writing state), and potentially with external systems (for spawning replacement agents or sending human notifications). The executor implements each recovery strategy as a finite state machine with explicit timeout handling at each step. If any step of recovery fails or times out, the executor escalates to the next-heavier strategy rather than retrying the failed step indefinitely.

**Verifier** -- After recovery completes, the Verifier monitors the recovered agent for a configurable verification window (default: 10 ticks) to confirm that health has been restored. If the agent's health degrades again within the verification window, the Verifier treats this as a recovery failure and instructs the Strategy Selector to escalate to the next strategy in the severity chain. This prevents recovery oscillation, where an agent is repeatedly recovered and fails in the same way, consuming resources without making progress. The Verifier also tracks recovery history: if an agent has been recovered more than N times (default: 3) within a sliding window, it forces escalation regardless of the current verdict severity.

#### Supervision Strategies

The supervisor supports five supervision strategies that govern how failure of one agent affects its siblings. The first four are drawn directly from Erlang/OTP; the fifth is a novel addition for AI agent workloads.

```typescript
type SupervisionStrategy =
  | 'one_for_one'           // Only restart the failed agent
  | 'one_for_all'           // Restart all agents under this supervisor
  | 'rest_for_one'          // Restart the failed agent and all agents started after it
  | 'escalate'              // Punt to the parent supervisor
  | 'abandon_with_summary'; // Kill the agent, emit a summary of what it accomplished
```

**`one_for_one`** -- The default strategy. When an agent fails, only that agent is recovered. Sibling agents are unaffected. This is appropriate when agents operate independently with no shared mutable state and no ordering dependencies. The vast majority of agent deployments use this strategy: each agent works on an independent task, and one agent's failure has no bearing on another's ability to continue.

**`one_for_all`** -- When any agent under this supervisor fails, ALL agents are stopped, checkpointed, and restarted. This is appropriate when agents share mutable state or have implicit dependencies that are not captured in the task graph. The canonical example is a set of agents collaboratively editing a shared document: if one agent's state becomes corrupted, the others may have incorporated corrupted information into their own contexts, so all must be restarted from a known-good state. This strategy is expensive and should be used sparingly.

**`rest_for_one`** -- When an agent fails, that agent and all agents that were started *after* it (in registration order) are restarted. Agents started before the failed agent are left alone. This is appropriate for pipeline topologies where downstream agents depend on upstream agents' output. If agent B consumes agent A's output and agent C consumes agent B's output, a failure of agent B means agent C's state may be built on corrupted data. Restarting B and C (but not A) restores the pipeline to a consistent state.

**`escalate`** -- This supervisor cannot handle the failure. It is propagated to the parent supervisor in the supervision tree, which applies its own strategy. This is the standard Erlang escalation mechanism and serves the same purpose: it allows supervisors to be composed hierarchically, with each level handling the failures it understands and escalating the rest. An agent-level supervisor might escalate to a task-level supervisor, which might escalate to a system-level supervisor, which might escalate to a human operator.

**`abandon_with_summary`** -- A novel strategy not present in Erlang/OTP, designed specifically for AI agent workloads where partial work has value. When an agent is abandoned, the supervisor does not attempt recovery. Instead, it:

1. Reads the agent's latest checkpoint (or current state, if the agent is still alive).
2. Generates a structured summary of the agent's progress: tasks completed, tasks in progress, key findings, current blockers, and any artifacts produced.
3. Publishes this summary to a well-known location (the message bus and the checkpoint store).
4. Terminates the agent.

This summary serves as a handoff document. A human operator can read it to understand what was accomplished. A replacement agent can be briefed with it to continue the work without repeating what was already done. This strategy acknowledges a reality of AI agent systems that Erlang never had to contend with: the work an agent does between checkpoints may be intrinsically valuable (analysis, reasoning, partial code generation) even if the agent itself cannot be recovered.


### 5.6 Recovery Strategies

Recovery is the system's primary value proposition. Traditional process managers offer a single recovery mechanism: restart. This is adequate for stateless services but wholly insufficient for stateful AI agents, where "restart" can mean anything from "retry the current API call" to "spawn a fresh agent and brief it on what its predecessor accomplished." The recovery strategy spectrum trades off recovery speed, data preservation, and resource cost. Choosing the right strategy for each failure mode is the difference between a system that gracefully handles degradation and one that thrashes between failure and recovery.

| Strategy | Trigger | Process | Data Preserved | Latency | Cost |
|---|---|---|---|---|---|
| Hot Restart | Transient API error, rate limit | Retry the current tick | Everything (in-memory state intact) | <1s | Zero |
| Warm Restart | Non-transient error, OOM | Kill process, restore from latest checkpoint | Checkpoint state | 1-5s | Low (checkpoint read) |
| Context Reconstruction | Hallucination spiral, context corruption | Build new LLM context from external state | External state; LLM context rebuilt | 5-30s | Medium (LLM call for context) |
| Fresh Start with Briefing | Unrecoverable state, corrupted checkpoint | New agent instance, briefed on predecessor's progress | Summary document only | 10-60s | High (new agent + briefing) |
| Escalate to Human | Safety-critical failure, budget policy violation | Pause agent, notify human, await instruction | Everything (agent paused, not killed) | Minutes-hours | Variable |

#### Hot Restart

The simplest and cheapest recovery. The agent process is still alive; the current tick simply failed due to a transient external error. Common triggers include LLM provider returning HTTP 500, rate limit (HTTP 429), tool call timeout, or transient network failure. The Recovery Engine instructs the agent to retry the current tick, potentially with exponential backoff.

No state is lost because the process is still running and in-memory state is intact. The agent's lifecycle state transitions to `RECOVERING` for the duration of the retry and returns to `RUNNING` on success. If the hot restart fails after the configured maximum retries (default: 3), the Recovery Engine escalates to a Warm Restart.

Hot Restart is the only recovery strategy that does not involve the checkpoint store. It is also the only strategy where the agent may be unaware that recovery occurred -- if the retry succeeds transparently, the agent simply sees a successful tick and continues.

```typescript
interface HotRestartConfig {
  maxRetries: number;              // default: 3
  backoffBaseMs: number;           // default: 1000
  backoffMultiplier: number;       // default: 2
  backoffMaxMs: number;            // default: 30000
  retryableErrors: string[];       // error codes/patterns that qualify
  escalateAfterFailure: RecoveryStrategyType; // default: 'warm_restart'
}
```

#### Warm Restart

The agent process has died -- crash, out-of-memory kill, instance preemption, or unrecoverable runtime exception. The process is gone, taking all in-memory state with it. Recovery requires spawning a new process and restoring state from the latest checkpoint.

The Warm Restart sequence:

1. The supervisor detects process death (via missed heartbeats or process exit signal).
2. A new agent process is spawned with the same agent ID and configuration.
3. The latest valid checkpoint is read from the CheckpointStore.
4. The checkpoint's external state is loaded into the new process.
5. The checkpoint's LLM state (conversation history, system prompt) is replayed into a fresh LLM context.
6. The new agent resumes ticking from the checkpoint's tick number.

Some work is lost: any progress made between the last checkpoint and the crash is gone. This is the fundamental trade-off of checkpoint-based recovery, and it is why checkpoint frequency is configurable (see Section 5.7). The warm restart also produces an *approximation* of the original LLM state, not an exact replica, because we are replaying conversation history into a new model context. In practice, this approximation is sufficient for continuity -- the agent "remembers" what it was doing -- but subtle behavioral differences are possible.

Warm Restart latency is dominated by two factors: checkpoint deserialization (typically <500ms for SQLite reads) and LLM context replay (typically 1-5s depending on conversation history length). For agents with very long conversation histories, the supervisor may apply conversation summarization during restore to reduce replay time (see Section 5.7, Checkpoint Sizing).

#### Context Reconstruction

This is the novel recovery strategy that justifies the system's architectural separation of agent state from LLM context. Context Reconstruction addresses a failure mode unique to LLM-backed agents: the process is alive, the external state is valid, but the model's context has become corrupted. The agent is running but no longer functioning correctly.

Context corruption manifests in several ways:

- **Hallucination spiral**: The model begins confabulating -- generating plausible but fictitious tool calls, inventing task results, or referring to conversations that never happened. Each hallucinated response is incorporated into the context, reinforcing the hallucination in subsequent ticks. Without intervention, the spiral continues until the context window is exhausted.
- **Context pollution**: A tool call returned an unexpectedly large or adversarial result that now dominates the context window, drowning out the agent's original instructions and accumulated state.
- **Objective drift**: The model has gradually "forgotten" its original objectives due to context window pressure, and is now pursuing tangential or irrelevant goals.

Traditional recovery (kill and restart) is overkill for these failures. The agent's external state -- its task queue, completed work, key-value store, effect ledger -- is perfectly valid. Only the LLM context needs repair. Context Reconstruction preserves the external state and rebuilds only the LLM context from scratch.

The Context Reconstruction sequence:

1. The supervisor signals the agent to enter `RECOVERING` state.
2. The agent's current external state is captured (this may already be in the latest checkpoint, or the agent can snapshot it on-demand).
3. A new LLM context is constructed from first principles:
   - The agent's original system prompt (unchanged).
   - A structured summary of completed work, generated from the task log in external state. This is not the raw conversation history; it is a concise summary: "You have completed tasks A, B, and C. Task A produced artifact X. Task B encountered blocker Y, which was resolved by Z."
   - The current task and its relevant context, pulled from the key-value store.
   - Recent tool results from the effect ledger (last N committed effects, where N is configurable).
   - An optional supervisor-injected briefing that provides additional context about why reconstruction occurred and what the agent should prioritize.
4. The old LLM context is discarded entirely.
5. The new context is installed and the agent resumes ticking.

This works precisely because the system treats the LLM context as a *derived view* of the agent's external state, not as the source of truth. When the view becomes corrupted, we regenerate it from the source of truth. The agent emerges from reconstruction with a clean, coherent context that accurately reflects its actual state and progress.

```typescript
interface ContextReconstructionConfig {
  includeSystemPrompt: boolean;        // always true in practice
  includeTaskSummary: boolean;         // summarize completed work
  maxHistoryItems: number;             // how many recent items to include
  includeRecentToolResults: number;    // last N tool results
  customBriefing?: string;             // supervisor-injected context
  preserveKeyMemories?: string[];      // specific context items to preserve
}
```

The `preserveKeyMemories` field deserves special attention. During reconstruction, certain pieces of context may be too important to lose even if the rest of the context is corrupted. These are typically high-value observations the agent made during its execution: discovered invariants, learned API quirks, or critical constraints identified through trial and error. If the agent or the supervisor has tagged these items as key memories, they are injected verbatim into the reconstructed context, preserving hard-won knowledge across the reconstruction boundary.

Context Reconstruction costs more than Hot or Warm Restart because it requires an LLM call to generate the task summary (unless a recent summary is already cached). The latency is 5-30 seconds depending on the volume of completed work to summarize and the speed of the LLM provider. However, it is substantially cheaper than a Fresh Start with Briefing because the agent process is preserved -- no new agent setup, no full briefing, no cold start.

#### Fresh Start with Briefing

The nuclear option before human escalation. The old agent is unsalvageable: its process is dead, its checkpoints are corrupted, or repeated recovery attempts have failed. A new agent must be spawned from scratch. But the old agent's work is not worthless -- it completed tasks, made discoveries, and identified blockers that should not be lost. The Fresh Start with Briefing strategy kills the old agent and spawns a replacement that is briefed on its predecessor's accomplishments.

The briefing generation sequence:

1. The supervisor reads the old agent's latest checkpoint (or whatever state is recoverable).
2. An LLM call generates a structured briefing document from the checkpoint state:
   - **Completed work**: What tasks were finished, what artifacts were produced.
   - **In-progress work**: What the agent was working on when it failed, and how far it got.
   - **Key findings**: Important observations, constraints, or invariants the agent discovered.
   - **Known blockers**: Issues the agent encountered that remain unresolved.
   - **Recommended next steps**: Based on the task queue and completed work.
3. A new agent is spawned with a fresh configuration but the same task assignment.
4. The briefing document is injected into the new agent's system prompt as context.
5. The new agent begins ticking with full awareness of its predecessor's work.

This strategy is expensive: it requires a new agent process (cold start), an LLM call for briefing generation, and the new agent must spend its first several ticks orienting to the briefing. Total latency is 10-60 seconds depending on checkpoint size and LLM speed. Token cost is significant: the briefing itself may be several thousand tokens, and the new agent's initial ticks will consume additional tokens processing it.

Despite the cost, Fresh Start with Briefing is strictly preferable to abandoning the work entirely. An agent that spent 500 ticks on a complex task has accumulated valuable state -- throwing all of that away and starting from zero is almost always more expensive than the briefing overhead.

#### Escalate to Human

The final fallback. The system has exhausted its automated recovery options, or the failure involves a safety-critical condition that policy requires human review. The agent is *paused*, not killed: its process remains alive, its state is preserved, and it can be resumed after human intervention.

The escalation notification includes:

- **Health assessment**: The full verdict that triggered escalation, including all policies that fired, anomaly detector findings, trend analysis, and budget projections.
- **Agent state**: The current checkpoint, lifecycle state, and recent heartbeat history.
- **Recovery history**: What recovery strategies were attempted and their outcomes. "Hot Restart attempted at tick 142, succeeded. Warm Restart attempted at tick 187, succeeded. Context Reconstruction attempted at tick 203, failed (agent re-degraded within verification window). Fresh Start with Briefing attempted at tick 210, failed (new agent entered hallucination spiral within 5 ticks)."
- **Suggested action**: The supervisor's best guess at what a human should do, based on the failure pattern. "Recommend manual inspection of the agent's task queue for an impossible or contradictory objective."

The human operator can then:

1. Inspect the agent's state and context directly.
2. Modify the agent's task queue, key-value store, or configuration.
3. Resume the agent (transition from `PAUSED` to `RUNNING`).
4. Kill the agent (transition from `PAUSED` to `TERMINATED`).
5. Spawn a replacement agent with modified parameters.

Escalation latency is inherently unpredictable -- it depends on human availability and response time. The system must be designed to tolerate paused agents: other agents should not block on a paused agent's output, and the supervision tree should remain functional with agents in `PAUSED` state.


### 5.7 Checkpoint Design

Checkpoints are the system's durability mechanism. They capture a snapshot of an agent's state at a specific point in time, enabling recovery from process death, context corruption, and any other failure mode that destroys in-memory state. The checkpoint design must balance four competing concerns: completeness (capturing enough state for faithful restoration), size (keeping checkpoints small enough for fast writes and reads), frequency (checkpointing often enough to limit data loss), and integrity (ensuring checkpoints are never corrupted).

#### Checkpoint Structure

```typescript
interface Checkpoint {
  // Identity
  id: string;
  agentId: string;
  epoch: number;
  tick: number;
  timestamp: number;

  // LLM State (approximate)
  llmState: {
    systemPrompt: string;
    conversationHistory: Message[];
    contextWindowUsage: number;
    modelId: string;
    temperature: number;
    // NOTE: We cannot capture the model's internal state.
    // Restoration produces an approximation, not an exact replica.
  };

  // External State (exact)
  externalState: {
    taskQueue: Task[];
    completedTasks: Task[];
    keyValueStore: Record<string, unknown>;
    pendingEffects: Effect[];
    committedEffects: Effect[];
  };

  // Agent Metadata
  metadata: {
    lifecycleState: LifecycleState;
    parentAgentId: string | null;
    childAgentIds: string[];
    budget: BudgetSnapshot;
    lastHeartbeat: Heartbeat;
    createdAt: number;
    restoredFrom: string | null; // previous checkpoint ID if this was restored
  };
}
```

The checkpoint is divided into three sections that reflect fundamentally different data characteristics.

**Identity** -- Immutable locators that uniquely identify this checkpoint in the checkpoint store. The `id` is a globally unique identifier (UUID v7, which encodes creation time for natural ordering). The `agentId`, `epoch`, and `tick` together provide a logical coordinate: "this is the state of agent X, in its Nth incarnation, at tick T." The `epoch` increments each time the agent is restored from a checkpoint, providing a clear boundary between incarnations.

**LLM State** -- An *approximation* of the model's context at checkpoint time. This section contains everything needed to reconstruct a similar (but not identical) LLM context during restoration: the system prompt, the full conversation history, the model identifier, and generation parameters. What it does not and cannot contain is the model's internal state: attention weights, hidden layer activations, KV cache contents, or any other internal representation. This limitation is fundamental and inescapable given current LLM architectures.

**External State** -- The *exact* state of all data structures managed outside the LLM context. This is the source of truth for the agent's actual progress and is restored with full fidelity. The task queue and completed tasks track work. The key-value store holds arbitrary agent-managed state. The pending and committed effects track side effects for saga-pattern recovery (see Section 5.8).

**Agent Metadata** -- Operational metadata that describes the agent's relationship to the broader system: its position in the supervision tree (parent and children), its budget state, its lifecycle state at checkpoint time, and its lineage (whether it was itself restored from a previous checkpoint, and if so, which one).

#### The Approximation Acknowledgment

The most important design decision in the checkpoint system is the explicit acknowledgment that LLM state restoration is approximate, not exact. When we restore from a checkpoint, we replay the saved conversation history into a fresh model context. The model processes this history and arrives at a state that is *influenced by* the same conversation but is not *identical to* the original state. Subtle differences in attention patterns, sampling randomness, and internal representations mean the restored agent may behave slightly differently than the original would have.

This is fundamentally different from traditional checkpointing where state restoration is exact -- a deserialized process has precisely the same memory contents as the serialized one. We embrace this limitation rather than pretending it does not exist. The system is designed around the principle that restored agents are *continuations* of their predecessors, not *replicas*. They share the same identity, the same external state, and the same conversation history, but they may make different moment-to-moment decisions. This is acceptable because the agent's objectives and progress are captured in the external state (which is restored exactly), not in the LLM's internal representations.

In practice, the approximation is good enough for continuity. Restored agents consistently "know" what they were working on, what they have accomplished, and what they should do next. The rare cases where restoration produces meaningfully different behavior are handled by the Verifier (Section 5.5), which monitors the agent post-recovery and escalates if behavior diverges from expectations.

#### Checkpoint Sizing

Conversation histories can grow very large. An agent that has been running for hundreds of ticks with verbose tool outputs can easily accumulate 100K+ tokens of conversation history. Naively serializing this into every checkpoint is expensive in both storage and restoration time.

The checkpoint system employs three strategies to manage size:

**Compression** -- All checkpoints are compressed before storage using LZ4, which provides a good trade-off between compression ratio and speed. Conversation histories compress well (typically 3-5x) because they contain repetitive structural elements (role markers, tool call formatting) and natural language has inherent redundancy.

**Conversation Summarization** -- For agents with very long histories, the checkpoint system can invoke an LLM to summarize older conversation turns. The summarization preserves the most recent N turns verbatim (default: 20) and replaces older turns with a structured summary. This dramatically reduces checkpoint size at the cost of losing some conversational detail. Summarization is performed asynchronously and does not block the agent's tick cycle. The summarized history is marked in the checkpoint so that the restoration logic knows it is working with a summary, not a verbatim transcript.

**Tiered Storage** -- Recent checkpoints (last N per agent, default: 5) are stored in SQLite for fast access. Older checkpoints are compressed and moved to disk-based storage (or S3 in cloud deployments). The retention policy is configurable: the default retains the 5 most recent checkpoints in the hot tier and up to 50 in the cold tier, with older checkpoints being garbage-collected. Checkpoints at epoch boundaries (the first and last checkpoint of each agent incarnation) are retained indefinitely for forensic analysis.

#### Checkpoint Frequency

Checkpoint frequency is configurable per agent and involves a direct trade-off: more frequent checkpoints mean less data loss on failure but more overhead during normal operation. A checkpoint write involves serializing the agent's state, compressing it, computing an integrity hash, and writing it to SQLite -- typically 10-50ms for a moderately sized agent.

The default checkpoint policy triggers a write under two conditions, whichever comes first:

1. **Periodic**: Every 10 ticks. This provides a bounded worst-case data loss of 10 ticks of work.
2. **Event-driven**: On significant state changes -- task completion, budget threshold crossing (every 10% increment), lifecycle state transition, or explicit checkpoint request from the agent itself.

The checkpoint decision is made in step 5 of the tick cycle (see Section 5.3), after effects have been committed but before the tick counter increments. This ensures that the checkpoint captures the completed tick's results.

Agents with high-value work or expensive ticks (e.g., agents making costly API calls) should checkpoint more frequently. Agents doing cheap, easily-reproducible work can checkpoint less frequently. The configuration supports both static frequency settings and dynamic policies (e.g., "checkpoint after any tick that cost more than 1000 tokens").

#### Checkpoint Integrity

Checkpoint corruption is a catastrophic failure: a corrupted checkpoint that is restored produces an agent with inconsistent state, which may be worse than having no checkpoint at all. The system implements multiple layers of protection against corruption.

**Content hashing** -- Each checkpoint includes a SHA-256 hash of its serialized contents (computed before compression). On restoration, the checkpoint is decompressed, the hash is recomputed, and it is compared to the stored hash. A mismatch indicates corruption, and the checkpoint is rejected.

**Atomic writes** -- The `CheckpointStore` interface requires implementations to provide atomic writes. For the SQLite implementation, this means each checkpoint write is a single transaction. The checkpoint is either fully written or not written at all; partial writes are impossible. This eliminates the most common source of checkpoint corruption: a crash during the write itself.

**Fallback chain** -- When a checkpoint fails integrity verification, the restoration logic does not fail. It falls back to the previous checkpoint (by tick number) and attempts restoration from there. This continues until a valid checkpoint is found or the chain is exhausted, at which point the failure escalates to Fresh Start with Briefing. The fallback chain is the reason the system retains multiple checkpoints per agent rather than only the latest.

```typescript
interface CheckpointStore {
  /** Write a checkpoint atomically. */
  write(checkpoint: Checkpoint): Promise<void>;

  /** Read the latest valid checkpoint for an agent. */
  readLatest(agentId: string): Promise<Checkpoint | null>;

  /** Read a specific checkpoint by ID. Verifies integrity. */
  read(checkpointId: string): Promise<Checkpoint | null>;

  /**
   * Read the latest valid checkpoint, falling back to previous
   * checkpoints if the latest is corrupted.
   */
  readLatestValid(agentId: string): Promise<Checkpoint | null>;

  /** List all checkpoint IDs for an agent, ordered by tick descending. */
  list(agentId: string): Promise<string[]>;

  /** Delete checkpoints older than the retention policy allows. */
  gc(agentId: string, retentionPolicy: RetentionPolicy): Promise<number>;
}
```


### 5.8 Side Effect Tracking

AI agents act on the world. They call APIs, send messages, create files, spawn sub-agents, and modify external state. These side effects are the entire point of having an agent, but they are also the most dangerous aspect of agent recovery. A crashed agent that is naively restarted may re-execute side effects that were already partially or fully completed, leading to duplicate API calls, duplicate messages, or inconsistent external state.

The system tracks side effects using an effect ledger inspired by the Saga pattern from distributed systems. Every side effect an agent intends to perform is registered in the ledger before execution, updated during execution, and marked as committed after completion. On recovery, the ledger serves as the definitive record of what happened, enabling the recovery engine to make safe decisions about what to retry, what to undo, and what to skip.

#### Effect Lifecycle

```
  Intent Registered    Executing    Committed
       ┌──┐            ┌──┐         ┌──┐
       │  │────────────>│  │────────>│  │
       └──┘            └──┘         └──┘
                         │
                         │ (crash here)
                         v
                       ┌──┐
                       │  │ Partial
                       └──┘
                         │
              ┌──────────┼──────────┐
              v          v          v
           Retry     Compensate   Skip
```

Every effect transitions through three states during normal execution: `registered` (the agent has declared its intent to perform the action), `executing` (the action is in progress), and `committed` (the action completed successfully and its results have been recorded). The critical insight is that a crash during the `executing` phase creates ambiguity: the action may have partially completed, fully completed but not yet confirmed, or not started at all. The effect ledger's metadata -- particularly the idempotency key and compensating action -- determines how this ambiguity is resolved.

#### Effect Type Definition

```typescript
interface Effect {
  id: string;
  agentId: string;
  tick: number;
  type: 'tool_call' | 'message_send' | 'sub_agent_spawn' | 'external_api';

  // What the agent intends to do
  intent: {
    action: string;
    parameters: Record<string, unknown>;
    idempotencyKey?: string;        // for safe retry
    compensatingAction?: string;    // how to undo this
  };

  // Execution state
  status: 'registered' | 'executing' | 'committed' | 'failed' | 'compensated';

  // Result (after execution)
  result?: {
    success: boolean;
    output: unknown;
    sideEffects: string[];  // human-readable description of what changed
  };

  timestamps: {
    registered: number;
    started?: number;
    completed?: number;
  };
}
```

The `type` field categorizes effects for monitoring and policy purposes. A `tool_call` is an invocation of a registered tool (file read, web search, code execution). A `message_send` is any communication the agent emits (to other agents, to humans, to external systems). A `sub_agent_spawn` is the creation of a child agent. An `external_api` is a call to any system outside the agent framework. These categories have different risk profiles and different recovery characteristics: a `tool_call` to a read-only tool is inherently idempotent, while a `message_send` is inherently non-idempotent.

The `intent` block captures what the agent wants to do *before it does it*. This pre-registration is essential: if the agent crashes after registering intent but before executing, the recovery engine knows the action was never started. If the agent crashes after execution starts but before it is marked committed, the recovery engine has the intent metadata to decide how to handle the ambiguity.

The `result` block is populated only after successful execution. The `sideEffects` array is particularly important for human operators: it provides a human-readable description of what the effect actually changed in the world ("Created file /tmp/output.json", "Sent email to user@example.com", "Spawned sub-agent task-decomposer-7"). This information is invaluable during manual incident review.

#### Recovery Semantics

On recovery, the effect ledger is the source of truth for what happened during the agent's previous incarnation. The recovery engine reads the ledger and classifies every effect by its status:

**Effects with status `committed`** -- These actions completed successfully. They are skipped entirely during recovery. The committed results are available in the ledger for the recovered agent to reference, but the actions are not re-executed. This is the simple, safe case.

**Effects with status `registered`** (never started) -- These actions were declared but never begun. They are safe to retry from scratch because no partial execution occurred. The recovery engine re-registers them in the recovered agent's effect ledger and allows the agent to execute them normally.

**Effects with status `failed`** -- These actions were attempted and failed cleanly (the failure was detected and recorded before the crash). The recovery engine treats them the same as `registered` effects: they can be retried. The failure metadata is preserved so the recovered agent can adjust its approach if needed (e.g., using a different API endpoint, providing different parameters).

**Effects with status `executing`** (started but not confirmed) -- The dangerous case. The action was in progress when the crash occurred. It may have completed on the remote side (e.g., an API call that succeeded but the agent crashed before recording the result), partially completed (e.g., a multi-step operation that got halfway through), or never actually started (e.g., the crash happened between the status update and the actual execution). The recovery engine applies a three-option decision tree:

1. **Retry** if the effect has an `idempotencyKey`. An idempotency key guarantees that re-executing the operation is safe regardless of whether the previous execution completed. The remote system uses the key to deduplicate: if the operation already completed, it returns the previous result; if not, it executes normally. This is the best-case scenario and the recovery engine always prefers it when available.

2. **Compensate** if the effect has a `compensatingAction` but no `idempotencyKey`. The compensating action attempts to undo whatever the previous execution may have done, returning the world to a known state from which the operation can be retried cleanly. Compensation is applied before retry. The compensating action is itself tracked as an effect in the ledger (with type `tool_call` and a reference to the original effect ID), ensuring that compensation failures are also recoverable.

3. **Skip and flag** if neither `idempotencyKey` nor `compensatingAction` is available. The recovery engine cannot safely retry (it might duplicate the action) and cannot compensate (it has no undo mechanism). It marks the effect as `failed` in the ledger, attaches a diagnostic message ("Effect was in executing state at crash time with no idempotency key or compensating action; skipped during recovery"), and notifies the supervisor. The supervisor may escalate to a human operator if the skipped effect was critical.

#### Idempotency Keys

Idempotency keys are the single most important mechanism for safe recovery of in-flight effects. An idempotency key is a client-generated unique identifier that the agent attaches to an effect before execution. The receiving system (tool, API, message broker) uses this key to ensure that the operation is executed at most once, regardless of how many times it is submitted.

For the idempotency key strategy to work, the receiving system must support it. The agent framework's built-in tools (file operations, message sending, sub-agent spawning) all support idempotency keys natively. External APIs may or may not support them. The framework provides a `ToolCapabilities` metadata interface that declares whether a tool supports idempotent operations, and the agent's effect registration logic uses this to determine whether an idempotency key should be generated.

When a tool does not support idempotency keys and the operation is not naturally idempotent, the effect is registered without a key. The recovery engine knows this effect cannot be safely retried and will apply compensation or skip-and-flag logic if recovery is needed. This explicit tracking prevents the worst outcome: silently retrying a non-idempotent operation and causing duplicate side effects.

```typescript
interface ToolCapabilities {
  supportsIdempotency: boolean;
  naturallyIdempotent: boolean; // e.g., file write to a fixed path
  supportsCompensation: boolean;
  compensationAction?: string;  // default compensation if the tool supports it
}
```

#### Compensating Actions

For effects that cannot be made idempotent, the effect can declare a compensating action: a description of how to undo the effect's consequences. Compensation is a concept borrowed directly from the Saga pattern in distributed systems, where long-lived transactions are decomposed into a sequence of steps, each with a corresponding compensating step that can reverse it.

Compensation in the AI agent context is inherently imperfect. You cannot unsend an email. You cannot un-notify a human. You cannot undo the recipient's reading of a message. What compensation *can* do is bring the system to a state that is *equivalent* to the pre-effect state for the purposes of continued execution. Examples:

- **File creation**: Compensate by deleting the file.
- **Database write**: Compensate by deleting or reverting the record.
- **API resource creation**: Compensate by deleting the resource.
- **Email sent**: Compensate by sending a follow-up correction ("Please disregard the previous message; it was sent in error."). Imperfect, but better than silent duplication.
- **Sub-agent spawned**: Compensate by terminating the sub-agent.

The compensation mechanism is opt-in. Effect authors (tool implementers, agent developers) are encouraged but not required to provide compensating actions. Effects without compensating actions are handled by the skip-and-flag path, which is safe but requires human attention. The system tracks which effects in its ecosystem support compensation and surfaces this information in health dashboards so operators can prioritize adding compensation support to high-risk effects.

The compensating action is executed by the recovery engine, not by the agent itself. This is deliberate: the agent's state may be corrupted (which is why recovery is happening in the first place), so we do not trust it to execute compensation correctly. The recovery engine interprets the `compensatingAction` string as a tool invocation, executes it through the same tool framework the agent uses, and tracks the compensation as its own effect in the ledger. If compensation itself fails, the recovery engine escalates: a failed compensation on a critical effect triggers human escalation, while a failed compensation on a non-critical effect is logged and the effect is marked `failed`.

---

## 6. Opinionated Technology Choices

We are deliberately opinionated. The agent infrastructure space is drowning in abstractions — frameworks that are "pluggable" everywhere and committed nowhere. Every layer gets an interface, every interface gets three implementations, and none of them work well. We reject this. We make specific choices and ship them. Only two integration seams exist (`CheckpointStore` and `MessageBus`) because these are where future extensions connect. Everything else is direct implementation: concrete classes, concrete dependencies, concrete behavior. If you want to swap the serialization format, you fork the project. If you want to swap the checkpoint store, you implement the interface and pass it in. This asymmetry is intentional. The two seams are load-bearing walls of the extension system. Everything else is a nail you shouldn't be pulling out.

### Technology Table

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22+ with TypeScript 5.x | Strong async primitives (native `await`, `AbortController`), growing agent ecosystem, npm distribution reach. V8 performance is sufficient — LLM API latency dominates. |
| Event loop | Native `async/await` + `setInterval` tick | Simple, no framework overhead. The tick loop is ~20 lines of code. We don't need RxJS, we don't need a task scheduler. `setInterval` + `async/await` is enough. |
| Message bus | Redis Streams (default, behind `MessageBus` interface) | Battle-tested pub/sub with consumer groups, built-in persistence, message acknowledgment. Redis Streams gives us ordered, persistent, fan-out messaging out of the box. The interface exists so extensions (payments, swarm) can subscribe without coupling to Redis. |
| Checkpoint store | SQLite via `better-sqlite3` (default, behind `CheckpointStore` interface) | Zero-config, fast synchronous writes, single-file database, excellent for single-machine MVP. The interface exists so production deployments can swap to Turso, Postgres, or S3 without rewriting extensions. |
| Heartbeat transport | Redis Streams (same bus) | One fewer dependency. Heartbeats are just messages on a dedicated stream. |
| Serialization | JSON | Debuggable (you can read checkpoints with `jq`), TypeScript-native (`JSON.parse`/`JSON.stringify`), sufficient performance. LLM calls take 500ms-30s; serialization takes <1ms. Optimization is not the bottleneck. |
| Agent definition | TypeScript classes extending `Agent` base class | Familiar OOP pattern, excellent IDE support (autocomplete, type checking on lifecycle methods), natural encapsulation of agent state. |
| Configuration | Plain TypeScript objects | No YAML, no TOML, no env var parsing. Config is code. Type-checked at compile time. |
| CLI | `commander` + `ink` (React for CLI) | Spawn, inspect, and manage agents from the terminal. `ink` provides rich interactive output (live heartbeat display, agent state dashboards). |
| Testing | Vitest | Fast, TypeScript-native, good mocking support. |
| Logging | `pino` | Structured JSON logging, low overhead, excellent for parsing with `jq`. |

### Abstraction Policy

Only `CheckpointStore` and `MessageBus` get interfaces — these are the two integration seams where future extensions connect. Everything else is hardcoded implementation.

Why these two? Because every future extension (payments, memory, swarm, integrations) needs to either store state or exchange messages. The checkpoint store is how extensions persist data across agent restarts. The message bus is how extensions communicate with agents and with each other. These two concerns — persistence and communication — are the universal dependencies of every extension we can foresee and many we cannot.

Why ONLY these two? Because premature abstraction kills projects. Every interface is a commitment to support multiple implementations, which means testing all implementations, documenting all implementations, and debugging all implementations. Two interfaces is the minimum viable seam for extensibility. If we discover we need a third, we will add it when the need is proven, not before. "Proven" means: two concrete, distinct use cases that cannot be satisfied by the existing two interfaces.

Ship one default implementation per interface. The default implementations (SQLite, Redis Streams) are not reference implementations — they are THE implementations for the MVP. Production-grade, tested, documented. Alternative implementations are a v2 concern. If you are running the MVP, you are running SQLite and Redis. If that does not work for your deployment, you are not running the MVP — you are building on top of it, and the interfaces are there to support exactly that.

---

## 7. TypeScript API Surface

This section presents the conceptual API through code examples. All code is syntactically valid TypeScript. The types and classes shown here define the contract between the framework and agent authors. The intent is to make the developer experience obvious: extend a class, implement a few methods, and the framework handles lifecycle, heartbeats, checkpointing, and recovery.

### 7.1 Agent Base Class

The `Agent<S>` base class is the primary authoring surface. The generic parameter `S` is the agent's state type — a plain serializable object that the framework checkpoints and restores. Agent authors override lifecycle methods to define behavior. The framework calls these methods at the appropriate times and in the correct order.

```typescript
import {
  Agent,
  type AgentConfig,
  type TickContext,
  type Heartbeat,
} from '@harnessmaxxing/core';

interface MyAgentState {
  tasksCompleted: number;
  currentResearch: string | null;
  findings: string[];
}

class ResearchAgent extends Agent<MyAgentState> {

  // Called once when the agent is first spawned.
  // Returns the initial state. This is the only time state is created from scratch;
  // all subsequent starts restore from checkpoint.
  async onInitialize(): Promise<MyAgentState> {
    return {
      tasksCompleted: 0,
      currentResearch: null,
      findings: [],
    };
  }

  // Called every tick — the core work loop.
  // The TickContext provides access to inbox, state, LLM, tools, and effects.
  // State mutations on ctx.state are automatically captured by the framework.
  async onTick(ctx: TickContext<MyAgentState>): Promise<void> {
    // Read from inbox — drain returns all pending messages and clears the inbox
    const messages = ctx.inbox.drain();

    for (const msg of messages) {
      if (msg.type === 'new_task') {
        ctx.state.currentResearch = msg.payload.topic;
      }
    }

    if (!ctx.state.currentResearch) {
      ctx.sleep(30_000); // Nothing to do, sleep for 30s
      return;
    }

    // Do work — call LLM, use tools
    const result = await ctx.llm.chat([
      { role: 'system', content: 'You are a research agent.' },
      { role: 'user', content: `Research: ${ctx.state.currentResearch}` },
    ]);

    // Track side effects before execution.
    // The effect is registered (logged) before the tool call happens,
    // so recovery can detect incomplete effects.
    const effect = ctx.effects.register({
      type: 'tool_call',
      action: 'save_findings',
      parameters: { content: result.content },
      idempotencyKey: `findings-${ctx.tick}`,
    });

    await ctx.tools.call('save_to_database', { content: result.content });
    ctx.effects.commit(effect);

    ctx.state.findings.push(result.content);
    ctx.state.tasksCompleted++;
    ctx.state.currentResearch = null;
  }

  // Customize heartbeat health assessment.
  // Called after every tick to produce the health portion of the heartbeat.
  // The default implementation reports healthy with no progress tracking.
  // Override this to provide domain-specific health signals.
  assessHealth(ctx: TickContext<MyAgentState>): Heartbeat['health'] {
    return {
      status: ctx.state.currentResearch ? 'healthy' : 'healthy',
      progress: ctx.state.tasksCompleted / 10, // arbitrary target
      coherence: 1.0,
      confidence: 0.8,
      stuckTicks: 0,
      lastMeaningfulAction: `Completed ${ctx.state.tasksCompleted} tasks`,
    };
  }

  // Called before checkpoint — opportunity to clean up transient state,
  // close non-serializable handles, or redact sensitive data.
  async onCheckpoint(state: MyAgentState): Promise<MyAgentState> {
    return state; // No cleanup needed
  }

  // Called after restoring from checkpoint.
  // Use this to re-establish connections, warm caches, or log recovery.
  async onRestore(state: MyAgentState): Promise<void> {
    console.log(`Restored with ${state.tasksCompleted} completed tasks`);
  }

  // Called on unrecoverable error — the agent is about to die.
  // Use this for error reporting, alerting, or final cleanup.
  async onError(error: Error): Promise<void> {
    console.error('Agent error:', error);
  }

  // Called before death — finalize any outstanding work.
  // This runs after onError (if applicable) and before the process exits.
  // State is still accessible via this.state.
  async onShutdown(): Promise<void> {
    console.log('Shutting down, completed', this.state.tasksCompleted, 'tasks');
  }
}
```

The lifecycle method call order is strictly defined:

| Scenario | Method sequence |
|---|---|
| Fresh spawn | `onInitialize` -> `onTick` (loop) -> `onCheckpoint` (periodic) -> `onShutdown` |
| Restore from checkpoint | `onRestore` -> `onTick` (loop) -> `onCheckpoint` (periodic) -> `onShutdown` |
| Unrecoverable error | `onError` -> `onShutdown` |
| Graceful kill | `onCheckpoint` -> `onShutdown` |

All lifecycle methods receive a `this` context with the agent's current state, its ID, its epoch, and its budget counters. The `TickContext` parameter on `onTick` additionally provides the inbox, outbox, LLM client, tool registry, and effect ledger.

### 7.2 Supervisor Configuration

The supervisor manages a set of child agents according to a supervision strategy and a health policy. Configuration is a plain TypeScript object — no YAML, no config files, no runtime parsing.

```typescript
import { Supervisor, type SupervisorConfig } from '@harnessmaxxing/core';

const config: SupervisorConfig = {
  // Restart strategy:
  // 'one_for_one' — restart only the failed agent
  // 'one_for_all' — restart all children when any fails
  // 'rest_for_one' — restart the failed agent and all agents started after it
  strategy: 'one_for_one',

  healthPolicy: {
    maxMissedHeartbeats: 3,       // 3 missed heartbeats = considered dead
    maxStuckTicks: 5,             // 5 ticks with no meaningful progress = stuck
    coherenceThreshold: 0.3,      // Below 0.3 coherence = confused, trigger recovery
    budgetWarningPercent: 0.8,    // Emit ON_BUDGET_WARNING at 80% of budget
    budgetHardLimitPercent: 0.95, // Force checkpoint + sleep at 95% of budget
  },

  recovery: {
    maxRestartsPerEpoch: 3,     // More than 3 restarts in the window = escalate
    restartWindow: 60_000,      // The window is 60 seconds
    strategies: [
      'hot_restart',              // Re-run onTick from current state
      'warm_restart',             // Restore from latest checkpoint
      'context_reconstruction',   // Rebuild context from checkpoint + memory
      'escalate',                 // Give up, notify supervisor's parent
    ],
  },

  children: [
    {
      id: 'researcher',
      agent: ResearchAgent,
      config: {
        budget: {
          maxTokens: 100_000,
          maxCostUsd: 5.00,
          maxWallTimeMs: 3_600_000, // 1 hour
        },
        tickInterval: 100,      // Base tick interval in ms (adaptive from here)
        checkpointEvery: 10,    // Checkpoint every 10 ticks
      },
    },
  ],
};

const supervisor = new Supervisor(config);
await supervisor.start();
```

The `strategies` array in `recovery` defines the escalation ladder. The supervisor tries strategies in order. If the first strategy fails (agent dies again within the restart window), it moves to the next. If all strategies are exhausted, the supervisor itself reports failure to its parent (if nested) or to the process.

### 7.3 Spawning and Interacting with Agents

The top-level API provides functions for spawning agents, sending messages, and querying state. These are convenience wrappers around the supervisor and message bus — they exist to make simple use cases simple.

```typescript
import { spawn, send, query } from '@harnessmaxxing/core';

// Spawn an agent — returns a handle with the agent's ID and control methods.
// The agent is immediately scheduled for its first tick.
const agent = await spawn(ResearchAgent, {
  budget: { maxTokens: 50_000, maxCostUsd: 2.50 },
});

// Send a message to the agent's inbox.
// Messages are delivered on the next tick (not immediately).
await send(agent.id, {
  type: 'new_task',
  payload: { topic: 'quantum computing applications in drug discovery' },
});

// Query agent state (read-only snapshot).
// This reads from the latest checkpoint, not from live state.
// For live state, subscribe to heartbeats.
const state = await query(agent.id);
console.log(`Tasks completed: ${state.tasksCompleted}`);

// Subscribe to agent heartbeats — real-time health and progress updates.
// The callback fires after every tick.
agent.heartbeats.subscribe((hb) => {
  console.log(`Health: ${hb.health.status}, Progress: ${hb.health.progress}`);
});

// Lifecycle commands — direct control over the agent.
await agent.checkpoint();    // Force an immediate checkpoint
await agent.sleep(60_000);   // Pause ticking for 60 seconds
await agent.wake();          // Resume ticking immediately
await agent.kill();          // Graceful shutdown: checkpoint -> onShutdown -> exit
```

The `agent` handle returned by `spawn` is a lightweight proxy. It does not hold a reference to the agent's process or memory — it communicates entirely through the message bus. This means handles survive across process restarts: if you persist the agent ID, you can reconstruct the handle and resume interaction.

### 7.4 Lifecycle Hook Registration

Lifecycle hooks are the extension mechanism. Extensions register callbacks on lifecycle events and receive structured event objects. Hooks fire synchronously in registration order. A hook that throws an error prevents the lifecycle transition from completing (by design — a payment hook that rejects a spawn should actually prevent the spawn).

```typescript
import { hooks } from '@harnessmaxxing/core';

// Payment extension example — metering, balance checks, and finalization.

hooks.on('POST_TICK', async (event) => {
  const { agentId, heartbeat } = event;
  await billingService.recordUsage(agentId, {
    tokens: heartbeat.resources.tokensUsed,
    cost: heartbeat.resources.estimatedCostUsd,
  });
});

hooks.on('PRE_SPAWN', async (event) => {
  const balance = await billingService.getBalance(event.ownerId);
  if (balance < event.config.budget.maxCostUsd) {
    throw new InsufficientBalanceError(balance, event.config.budget.maxCostUsd);
  }
});

hooks.on('ON_DEATH', async (event) => {
  await billingService.finalizeSession(event.agentId, event.totalCost);
});

// Memory extension example — persist and restore memories across checkpoints.

hooks.on('PRE_CHECKPOINT', async (event) => {
  const memories = await memoryService.extractMemories(
    event.conversationHistory,
  );
  event.checkpoint.externalState.keyValueStore['memories'] = memories;
});

hooks.on('POST_RESTORE', async (event) => {
  const memories = event.checkpoint.externalState.keyValueStore['memories'];
  await memoryService.injectContext(event.agentId, memories);
});
```

The full set of lifecycle hooks is:

| Hook | Fires when | Event payload |
|---|---|---|
| `PRE_SPAWN` | Before agent initialization | `{ ownerId, config, agentClass }` |
| `POST_SPAWN` | After `onInitialize` completes | `{ agentId, initialState }` |
| `PRE_TICK` | Before each tick begins | `{ agentId, tick, state }` |
| `POST_TICK` | After each tick completes | `{ agentId, tick, heartbeat, state }` |
| `PRE_CHECKPOINT` | Before state is serialized | `{ agentId, checkpoint }` (mutable) |
| `POST_CHECKPOINT` | After checkpoint is persisted | `{ agentId, checkpointId }` |
| `PRE_RESTORE` | Before checkpoint is deserialized | `{ agentId, checkpointId }` |
| `POST_RESTORE` | After `onRestore` completes | `{ agentId, checkpoint, state }` |
| `ON_DEATH` | Agent is dying (before cleanup) | `{ agentId, reason, totalCost, epoch }` |
| `ON_BUDGET_WARNING` | Budget threshold crossed | `{ agentId, budgetUsed, budgetLimit, percent }` |
| `ON_CONTEXT_COMPACTION` | Context window nearing capacity | `{ agentId, conversationHistory, usagePercent }` |
| `ON_ERROR` | Unrecoverable error caught | `{ agentId, error, state }` |

Hooks with `PRE_` prefix can modify the event payload (e.g., `PRE_CHECKPOINT` can mutate the checkpoint before it is saved). Hooks with `POST_` prefix receive read-only snapshots. `ON_` hooks are notifications — they cannot prevent the event from completing.

### 7.5 Interface Definitions

These are the two integration seams. Every other type in the system is a concrete class or a plain TypeScript type. Only these two are interfaces, and only these two accept alternative implementations.

```typescript
// === CheckpointStore ===
// Persistence layer for agent checkpoints.
// Default implementation: SQLite via better-sqlite3.
// The store is append-oriented: save() creates a new checkpoint,
// load() retrieves by agent ID and optional epoch,
// loadLatest() is the hot path for recovery.

interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(agentId: string, epoch?: number): Promise<Checkpoint | null>;
  loadLatest(agentId: string): Promise<Checkpoint | null>;
  list(agentId: string): Promise<CheckpointMetadata[]>;
  delete(checkpointId: string): Promise<void>;
  verify(checkpointId: string): Promise<boolean>;
}

// === MessageBus ===
// Communication layer for inter-agent messaging and heartbeats.
// Default implementation: Redis Streams.
// Consumer groups enable fan-out to multiple subscribers
// (e.g., supervisor + payment extension both receive heartbeats).
// Heartbeat methods are convenience wrappers — heartbeats are
// just messages on agent-specific channels, but the pattern is
// common enough to warrant dedicated methods.

interface MessageBus {
  publish(channel: string, message: Message): Promise<void>;
  subscribe(
    channel: string,
    handler: MessageHandler,
  ): Promise<Subscription>;
  createConsumerGroup(
    channel: string,
    group: string,
  ): Promise<void>;
  acknowledge(
    channel: string,
    group: string,
    messageId: string,
  ): Promise<void>;

  // Heartbeat-specific convenience methods
  publishHeartbeat(
    agentId: string,
    heartbeat: Heartbeat,
  ): Promise<void>;
  subscribeHeartbeats(
    pattern: string,
    handler: HeartbeatHandler,
  ): Promise<Subscription>;
}
```

The `Subscription` returned by `subscribe` and `subscribeHeartbeats` is a handle with a single method: `unsubscribe(): Promise<void>`. Subscriptions are automatically cleaned up when the agent dies (the framework calls `unsubscribe` on all active subscriptions during the shutdown phase). Extensions that subscribe outside the agent lifecycle are responsible for their own cleanup.

The `Checkpoint` type referenced by `CheckpointStore` contains the full agent snapshot: state, conversation history, effect ledger, budget counters, epoch, tick number, and an `externalState` bag for extensions to store their own data. The `verify` method on the store performs integrity validation — for the SQLite implementation, this is a checksum comparison; alternative implementations may use different verification strategies.

---

## 8. Key Technical Decisions

This section documents the major technical decisions in the system. Each decision is presented as a question, a chosen answer, and the reasoning that led to it. These decisions are not tentative — they are load-bearing architectural choices that downstream design depends on.

### Decision 1: Push Heartbeats with Pull Fallback

**Question:** Should agents push heartbeats to the supervisor, or should the supervisor pull health status from agents?

**Decision:** Agents push heartbeats on every tick via the message bus. The supervisor maintains a per-agent watchdog timer. If no heartbeat arrives within the expected interval plus a configurable tolerance, the supervisor actively probes the agent by sending a health check message and waiting for a response.

**Rationale:** Push is more efficient than polling — there is no wasted work when agents are healthy, and latency between a health change and the supervisor learning about it is minimal (one tick). However, push alone cannot detect a fully stuck agent. If the tick loop hangs, no heartbeat is ever emitted, and the supervisor receives silence. Silence is ambiguous: it could mean "dead" or "slow LLM call." The pull fallback resolves this ambiguity. When the watchdog fires, the supervisor sends a probe. If the agent responds, it is alive but slow. If it does not respond within a second timeout, it is dead. This two-tier approach gives us the efficiency of push with the reliability of pull.

### Decision 2: Per-Tick Heartbeats + Wall-Clock Watchdog

**Question:** How often should heartbeats be emitted, and how do we detect a hung tick loop?

**Decision:** Every tick emits a heartbeat. Additionally, a wall-clock watchdog (`setInterval` at a fixed cadence, independent of the tick loop) emits a "still alive" signal even when the tick loop is blocked.

**Rationale:** Per-tick heartbeats give maximum resolution for health assessment. The supervisor can track progress per tick, detect stuck loops by counting ticks with no meaningful change, and meter resource usage with tick-level granularity. But the tick loop is not the only thing that can hang. An LLM call that takes 60 seconds blocks the tick, which blocks the heartbeat. During that 60 seconds, the supervisor sees silence. The wall-clock watchdog solves this: a separate `setInterval` (running on the same event loop but not gated by the tick's `await`) emits a lightweight signal every N seconds. This signal says "the process is alive and the event loop is turning." It does not say "the agent is making progress" — that is the tick heartbeat's job. Together, the two signals let the supervisor distinguish three states:

| Tick heartbeats | Watchdog signal | Interpretation |
|---|---|---|
| Arriving | Arriving | Healthy, actively working |
| Not arriving | Arriving | Alive but blocked (likely waiting on LLM call) |
| Not arriving | Not arriving | Process is dead or event loop is frozen |

This distinction is critical for recovery decisions. A blocked agent should be given more time. A dead agent should be restarted immediately.

### Decision 3: Non-Deterministic Recovery (Checkpoint-and-Reconstruct, NOT Replay)

**Question:** Should recovery replay events from a checkpoint (like Temporal or event sourcing) or reconstruct state from the checkpoint directly?

**Decision:** Checkpoint and reconstruct. No replay. On recovery, the framework loads the latest checkpoint, calls `onRestore`, and resumes ticking from the checkpointed state. It does not replay the events that occurred between checkpoints.

**Rationale:** Event sourcing and replay-based recovery require deterministic processing: replaying the same inputs must produce the same outputs. LLM-based agents are fundamentally non-deterministic. Replaying the same prompt produces different completions. Temperature, sampling, model updates, and server-side state all introduce variance. Attempting replay would produce a divergent state that looks valid but is subtly wrong — the worst kind of bug.

Instead, we capture state at checkpoints and reconstruct an approximate context on restore. The conversation history is stored in the checkpoint. The agent's typed state is restored exactly. What is lost is the in-flight work between the last checkpoint and the failure. This is an acceptable trade-off: checkpoint frequency is configurable (default: every 10 ticks), and the cost of re-doing a few ticks of work is trivial compared to the cost of a corrupted state from non-deterministic replay.

The side effect ledger (see Decision 5) mitigates the other risk of non-replay recovery: duplicate side effects. Effects registered but not committed at the time of the checkpoint are retried or compensated on restore, ensuring that recovery does not double-send an email or double-charge a payment.

### Decision 4: Context Window Management as a Lifecycle Event

**Question:** Should context window compaction be managed by the agent's application code or by the framework?

**Decision:** Framework-managed. When `contextWindowUsage` exceeds a configurable threshold (default: 80%), the framework triggers an `ON_CONTEXT_COMPACTION` lifecycle event and executes a compaction strategy. The default strategy summarizes older messages and drops low-relevance context. Extensions (notably memory) can hook into `ON_CONTEXT_COMPACTION` to extract important information before it is discarded.

**Rationale:** Context management is infrastructure, not application logic. Every LLM-based agent needs it. Getting it wrong kills the agent — either the context overflows and the LLM call fails, or important context is discarded and the agent loses coherence. Leaving this to agent authors guarantees inconsistent handling and subtle bugs.

By making compaction a lifecycle event, we get three properties. First, consistency: every agent gets the same compaction behavior by default. Second, extensibility: the memory extension hooks into `ON_CONTEXT_COMPACTION` to extract memories before context is discarded, ensuring that important information migrates to long-term storage. Third, observability: compaction events appear in the heartbeat and in logs, so operators can see when and why context was compacted.

The framework does not dictate the compaction strategy — it dictates that compaction happens and that extensions are notified. The default strategy (summarize old messages) is sufficient for the MVP. Production deployments can register a custom `ON_CONTEXT_COMPACTION` hook that implements a domain-specific strategy.

### Decision 5: Side Effect Ledger with Saga-Pattern Recovery

**Question:** How do we handle tool side effects (API calls, database writes, emails) during recovery?

**Decision:** Every side effect is registered in a ledger before execution and committed after successful execution. On recovery, the framework inspects the ledger and takes action based on each effect's state and idempotency properties:

| Effect state | Idempotent | Recovery action |
|---|---|---|
| Registered, not committed | Yes | Retry |
| Registered, not committed | No | Flag for manual review |
| Committed | (any) | No action (already completed) |
| Not registered | (any) | Not in ledger, cannot have been executed |

**Rationale:** The alternative is to ignore side effects during recovery — "hope for the best." This is unacceptable for production agents. An agent that sends emails, creates Jira tickets, transfers funds, or modifies infrastructure cannot afford to double-execute or silently skip side effects. The ledger makes side effects visible and recoverable.

The `idempotencyKey` on each effect is critical. For idempotent operations (database upserts, API calls with client-supplied IDs), retry is safe. For non-idempotent operations (sending an email, posting a Slack message), the framework cannot safely retry — it flags the effect for human review. This is the saga pattern applied to agent recovery: each effect is a step in a distributed transaction, and compensation or retry is determined by the step's properties.

The ledger is stored as part of the checkpoint. This means the ledger survives process death. On restore, the framework walks the ledger, identifies incomplete effects, and applies the recovery policy before resuming the tick loop.

### Decision 6: Sub-Agents Default to Kill on Parent Death

**Question:** What happens to child agents when a parent agent dies?

**Decision:** The default behavior is to kill all children. When a parent agent dies, the supervisor sends a kill signal to every child of that agent. Each child performs a checkpoint and shutdown. This behavior is configurable per-child with the following options:

| Strategy | Behavior |
|---|---|
| `kill` (default) | Checkpoint, shutdown, and deallocate the child. |
| `orphan` | Child continues running independently with no parent. |
| `adopt` | Supervisor assumes direct ownership of the child. |
| `cascade` | Child checkpoints and enters sleep state, awaiting a new parent. |

**Rationale:** The safe default is kill. Orphaned agents consuming tokens, calling APIs, and generating costs with no parent to collect results or enforce budgets is strictly worse than losing in-progress work. The in-progress work is captured in the child's checkpoint anyway — a future parent or operator can restore the child and continue.

Production deployments will configure `adopt` or `cascade` based on their needs. A long-running research swarm might use `adopt` so that worker agents survive coordinator restarts. A pipeline with sequential stages might use `cascade` so that downstream agents sleep until the upstream agent is back. The default is the only one that is safe without configuration — that is why it is the default.

### Decision 7: Adaptive Tick Rate

**Question:** Should the tick interval be fixed or variable?

**Decision:** Adaptive. The tick interval adjusts based on agent activity:

| Activity state | Tick interval | Rationale |
|---|---|---|
| Actively working (LLM calls, tool use) | 0-100ms | Minimize latency between work steps. |
| Waiting for input (inbox empty, no pending work) | 1-5s | Reduce CPU usage while remaining responsive. |
| Sleeping (explicit sleep or budget-throttled) | 30-60s | Minimal resource usage, just enough for watchdog. |

The base tick interval is configurable per agent (default: 100ms). The framework scales it up or down based on the agent's behavior in the previous tick. If the previous tick performed meaningful work, the interval stays at the base. If the previous tick was a no-op (empty inbox, no state change), the interval increases by a backoff factor. When a message arrives or the agent is woken, the interval resets to the base immediately.

**Rationale:** A fixed tick rate is either too slow or too fast. A 100ms fixed interval means a sleeping agent executes 10 no-op ticks per second — pure waste. A 5s fixed interval means an active agent waits 5 seconds between LLM calls — unacceptable latency. Adaptive rate matches resource usage to actual work.

The tick rate also serves as a health signal. A sudden drop in tick rate (agent transitions from active to idle without processing new messages) may indicate a stuck agent. The supervisor monitors tick rate changes as part of its health assessment.

### Decision 8: Single-Process Multi-Agent for MVP

**Question:** Should the MVP support distributed agents across multiple machines?

**Decision:** No. The MVP runs all agents in a single Node.js process as concurrent async tasks. Multiple agents share the same event loop, the same Redis connection, and the same SQLite database file.

**Rationale:** Distribution adds complexity that is orthogonal to the core lifecycle problem. Network partitions, clock skew, distributed consensus, split-brain supervision — these are real problems, but they are not the problems the MVP is solving. The MVP proves that the lifecycle model (tick, heartbeat, checkpoint, recover) is correct and useful. Distribution is a deployment concern that we defer to v2.

The architecture already supports distribution. The message bus and checkpoint store are behind interfaces. Redis Streams supports consumer groups across multiple processes out of the box. SQLite can be swapped for Postgres or Turso. Nothing in the agent lifecycle depends on same-process assumptions — agents communicate through the message bus, not through shared memory. The transition from single-process to multi-process requires changing the infrastructure implementations, not the lifecycle model.

For the MVP: Redis Streams + SQLite on a single machine. For v2: Redis Cluster (or NATS, or Kafka) + Postgres (or Turso) across machines. The agent code does not change. The supervisor code does not change. Only the `CheckpointStore` and `MessageBus` implementations change — which is exactly why those are the two interfaces.

---

## 9. Extension Points

The lifecycle hook system is the primary extension mechanism. Extensions do not subclass framework internals, do not monkey-patch agent behavior, and do not require framework modifications. They register callbacks on lifecycle events and receive structured, typed event objects. The framework guarantees hook execution order (registration order) and hook execution timing (synchronous with the lifecycle transition). This section describes how four planned extensions map onto the hook system.

### 9.1 Payment Rails

Payment metering requires continuous visibility into agent resource consumption and hard control over agent creation and termination. The lifecycle provides exactly this through four hooks.

**`POST_TICK`** fires after every tick with the heartbeat attached. The heartbeat's `resources` field contains `tokensUsed`, `estimatedCostUsd`, and `wallTimeMs` for that tick. The payment extension reads these values and writes a usage record to the billing store. Because `POST_TICK` fires after every tick without exception, no usage goes unmetered. The billing store can be the `CheckpointStore` (using the `externalState.keyValueStore` on the agent's checkpoint) or a separate database — this is the payment extension's choice.

**`PRE_SPAWN`** fires before agent initialization. The payment extension checks the owner's balance against the requested budget. If the balance is insufficient, the hook throws an `InsufficientBalanceError`, which prevents the spawn from completing. The agent is never created. This is the billing gate: no balance, no agent.

**`ON_DEATH`** fires when the agent is dying, before cleanup. The payment extension finalizes the billing session: calculates total cost from accumulated usage records, issues refunds for unused pre-paid budget, and marks the session as closed. Because `ON_DEATH` fires before the agent's resources are deallocated, the payment extension has access to the final heartbeat and the complete usage history.

**`ON_BUDGET_WARNING`** fires when the agent crosses a configurable budget threshold (default: 80%). The payment extension uses this to notify the owner (email, webhook, Slack) that their agent is approaching its budget limit. This gives the owner time to increase the budget or checkpoint and shut down the agent gracefully, rather than hitting the hard limit and being force-stopped.

The payment extension's data flow is unidirectional: it reads from heartbeats and writes to its own billing store. It does not modify agent state. It does not inject data into the tick loop. Its only interaction with the agent is the `PRE_SPAWN` gate (which can reject) and the `ON_BUDGET_WARNING` notification (which is informational). This separation ensures that billing bugs cannot corrupt agent behavior.

### 9.2 Memory

Memory is the bridge between an agent's ephemeral context window and its persistent knowledge. The lifecycle provides natural integration points for memory extraction, injection, and migration.

**`PRE_CHECKPOINT`** fires before the checkpoint is serialized. The memory extension processes the conversation history in the checkpoint, extracts durable memories (facts, decisions, learned preferences, task context), and writes them into the checkpoint's `externalState.keyValueStore` under a `memories` key. Because `PRE_CHECKPOINT` receives a mutable checkpoint object, the memory extension can enrich the checkpoint before it is saved. Memories are stored alongside the state they were extracted from, ensuring consistency.

**`POST_RESTORE`** fires after the agent is restored from a checkpoint. The memory extension reads memories from the checkpoint's `externalState.keyValueStore` and injects them into the agent's context. "Injection" means prepending a system message with relevant memories, or inserting a memory summary at the beginning of the conversation history. The agent does not need to know that memories were injected — the framework handles it transparently.

**`ON_CONTEXT_COMPACTION`** fires when the context window nears capacity. This is the most critical hook for memory. Before the framework discards old context to make room, the memory extension gets a chance to extract important information and migrate it to long-term storage. Without this hook, compaction would destroy context that might be needed later. With it, compaction becomes a migration event: important context moves from the context window to the memory store, and a compact summary remains in the window.

**`PRE_TICK`** is an optional hook for memory. Before each tick's LLM call, the memory extension can inject relevant memories based on the current state and inbox contents. This is a retrieval-augmented generation (RAG) pattern: the memory extension queries its store for memories relevant to the current task and injects them as additional context. This hook is optional because memory injection at restore time (`POST_RESTORE`) is often sufficient. `PRE_TICK` injection is for agents that run long sessions and need continuous memory augmentation.

The memory extension uses the `CheckpointStore` interface for persistence. Memories are stored as entries in the checkpoint's external state, which means they are backed by whatever storage the checkpoint store uses (SQLite for MVP, Postgres or S3 for production). The memory extension does not introduce a new persistence dependency — it piggybacks on the existing checkpoint infrastructure.

### 9.3 Swarm Coordination

A swarm is a set of agents working toward a shared goal with dynamic membership. The supervision tree is the natural substrate for swarm coordination — supervisor nodes are swarm coordinators, and leaf nodes are worker agents. Swarm management maps directly onto lifecycle hooks.

**`PRE_SPAWN`** registers the new agent with the swarm registry. The registry is a data structure (maintained by the swarm extension, persisted via `CheckpointStore`) that tracks which agents exist, what roles they fill, and what work they are assigned. Registration at `PRE_SPAWN` ensures that the registry is updated before the agent starts ticking, which means the swarm coordinator always has an accurate view of available workers.

**`ON_DEATH`** removes the agent from the swarm registry and evaluates whether a replacement is needed. If the swarm's task requires N workers and a worker dies, the `ON_DEATH` hook triggers the coordinator to spawn a replacement. The replacement agent is spawned with the same configuration as the dead agent and can optionally restore from the dead agent's checkpoint to continue its work.

**`POST_TICK`** updates the swarm topology based on agent health and workload. The swarm extension reads heartbeats from all agents in the swarm and makes coordination decisions: rebalance work between agents, scale the swarm up or down, reassign tasks from stuck agents to healthy ones. This is the swarm's control loop, and it runs at the cadence of the coordinator agent's tick.

The supervision tree provides the structural foundation. A swarm coordinator is a supervisor with dynamic children. Adding a worker to the swarm is spawning a child agent. Removing a worker is killing a child. The supervision strategies (`one_for_one`, `one_for_all`) define the swarm's failure semantics. The swarm extension adds the coordination logic (task assignment, load balancing, scaling) on top of the supervision tree's lifecycle management.

The message bus is the communication backbone. Worker agents publish status updates and results to swarm channels. The coordinator subscribes to these channels and makes decisions. The message bus's consumer group feature allows multiple coordinators to share the load of monitoring a large swarm (horizontal scaling of the coordination layer).

### 9.4 Integrations (Git, Jira, Slack, etc.)

External integrations — connections to third-party services — have their own lifecycle that must be synchronized with the agent lifecycle. Connections must be established on startup, maintained during operation, serialized for checkpoints, and cleaned up on shutdown. The lifecycle hook system provides exact alignment.

**`ON_INITIALIZE`** (via `POST_SPAWN`) is where integrations acquire credentials, establish connections, and register webhooks. A Git integration authenticates with the repository host and clones the working tree. A Jira integration authenticates with the Jira API and sets up a webhook for issue updates. A Slack integration connects to the Slack WebSocket and subscribes to relevant channels. These operations happen once, after the agent is initialized, before the first tick.

**`ON_SHUTDOWN`** (via the `ON_DEATH` hook) is where integrations release resources. The Git integration pushes any uncommitted changes and removes the working tree. The Jira integration deregisters webhooks. The Slack integration disconnects from the WebSocket. Resource cleanup is critical: leaked webhooks, open connections, and orphaned working trees accumulate over time and cause operational pain.

**`PRE_CHECKPOINT`** serializes connection state or invalidation markers. Most external connections cannot be serialized directly (you cannot serialize a WebSocket). Instead, the integration stores enough information to re-establish the connection: credentials, endpoint URLs, subscription IDs, and a marker indicating that the connection must be re-established on restore. For Git, this means storing the repository URL, branch, and commit hash — not the working tree contents.

**`POST_RESTORE`** re-establishes connections from the checkpointed state. The integration reads the connection metadata from the checkpoint, authenticates again, and resumes operation. For Git, this means cloning the repository, checking out the stored commit, and fast-forwarding to the latest state. For Slack, this means reconnecting to the WebSocket and replaying any messages missed during downtime (using the message bus's persistence to determine the last processed message ID).

The pattern is consistent across all integrations: acquire on init, serialize on checkpoint, restore on recovery, release on shutdown. The lifecycle hooks provide the timing. The `CheckpointStore` provides the persistence. The integration provides the domain logic. No special framework support is needed for individual integrations — they are all hook consumers.

---

## 10. Phasing

Development is organized into three phases, each with explicit scope, deliverables, success criteria, and non-goals. The phasing reflects a deliberate architectural strategy: build the single-process lifecycle primitives first (MVP), extend to distributed operation and advanced recovery second (V2), and defer platform-level extensions until the core is battle-tested (Future). Each phase is designed to be independently useful -- an operator running only the MVP has a functional, production-grade agent lifecycle system, not a half-built prototype waiting for later phases to become usable.

The phase boundaries are drawn along the system's two primary complexity axes: **distribution** (single-process vs. multi-machine) and **recovery sophistication** (checkpoint-based vs. context-aware). The MVP addresses neither axis fully, focusing instead on correctness and completeness of the core abstractions. V2 extends along both axes simultaneously, because distributed operation without advanced recovery is fragile (agents on remote machines need more recovery options, not fewer), and advanced recovery without distribution solves a narrow problem (single-process agents rarely need context reconstruction -- they can just restart). The Future phase adds capabilities that are orthogonal to lifecycle management proper -- payments, memory, swarm coordination -- but that depend on the lifecycle primitives established in the first two phases.

---

### 10.1 MVP (v0.1)

**Scope:** Single-process, multi-agent runtime with basic lifecycle management. All agents run within a single Node.js process, managed by a single in-process supervisor. The MessageBus and CheckpointStore interfaces are implemented with their default backends (Redis Streams and SQLite, respectively), but the interfaces are stable and ready for alternative implementations. The CLI provides operator visibility into agent state without requiring a web dashboard.

**Deliverables:**

| # | Deliverable | Description |
|---|---|---|
| 1 | `Agent` base class | Abstract base class with lifecycle methods: `onInitialize()`, `onTick()`, `onCheckpoint()`, `onRestore()`, `onError()`, `onShutdown()`. Subclasses implement these methods to define agent behavior. The base class manages the tick loop, heartbeat emission, budget tracking, and effect ledger automatically -- agent authors write only domain logic. |
| 2 | Tick loop with adaptive tick rate | The six-step tick cycle defined in Section 5.3, with adaptive yield duration across four regimes (active work: 0-100ms, waiting: 1-5s, sleeping: 30-60s, error: no ticks). Tick rate adapts automatically based on agent state and work queue depth. Configurable per-agent via `tickConfig` in the agent definition. |
| 3 | Heartbeat emission | Full structured heartbeat as defined in Section 5.4, emitted on every tick. Includes semantic health (progress, coherence, confidence, stuckTicks), resource consumption (tokens, cost, wall time, API calls, tool invocations), and execution metadata (state, active tools, pending effects, context window usage, tick rate). Published to `stream:heartbeats` via the MessageBus interface. |
| 4 | Lifecycle state machine | All nine states (UNBORN, INITIALIZING, RUNNING, SLEEPING, ERROR, CHECKPOINTED, RECOVERING, DEAD, ARCHIVED) with all transitions, guards, actions, and hooks as defined in the state transition table in Section 5.2. Illegal transitions throw `IllegalTransitionError`. Every transition emits a lifecycle event on `stream:events`. |
| 5 | Basic supervisor | Single-level supervisor (no supervisor-of-supervisors) implementing the `one_for_one` restart strategy. The supervisor consumes the heartbeat stream via `XREADGROUP`, evaluates health policies per-agent, and executes recovery actions. Configurable health policies: heartbeat timeout, stuck-tick threshold, budget soft/hard limits, context window threshold. Restart counter with configurable max retries and cooldown period. |
| 6 | Recovery strategies: hot restart, warm restart | Hot restart: kill the agent, restore from the most recent checkpoint with unmodified state. Appropriate for transient errors (network timeouts, API 500s, OOM). Warm restart: kill the agent, restore from the most recent checkpoint with prompt augmentation -- the system prompt is modified to include information about the failure that triggered recovery (error message, last meaningful action, number of recovery attempts). Appropriate for recoverable errors where the agent needs to adjust its approach. |
| 7 | SQLite checkpoint store | Default implementation of the `CheckpointStore` interface using better-sqlite3 for synchronous, zero-dependency persistence. Schema: `checkpoints` table with columns for `checkpoint_id`, `agent_id`, `epoch`, `tick`, `state` (JSON blob), `context_envelope` (JSON blob), `effect_ledger` (JSON blob), `budget_snapshot` (JSON blob), `checksum` (SHA-256), `created_at`, `previous_checkpoint_id`. Supports `save()`, `load()`, `list()`, `delete()`. Checkpoint integrity verified via SHA-256 on every `load()`. WAL mode enabled for concurrent read/write access. |
| 8 | Redis Streams message bus | Default implementation of the `MessageBus` interface using ioredis. Three stream types: `stream:heartbeats` (agent heartbeats, consumed by supervisor), `stream:commands:{agentId}` (per-agent lifecycle commands, produced by supervisor), `stream:events` (system-wide lifecycle events, consumed by any interested party). Consumer groups for reliable delivery. Automatic stream trimming via `MAXLEN` to prevent unbounded growth. |
| 9 | Side effect ledger | Append-only log of external side effects within each epoch. API: `register(effectId, intent)` to record a planned action, `commit(effectId)` to mark it as completed, `fail(effectId, error)` to mark it as failed, `inspect()` to list all effects with their statuses. The ledger is included in every checkpoint. On recovery, the agent reads the ledger to determine which effects from the prior epoch were committed and which were pending (and therefore need to be retried or skipped). Effect entries include: `effectId` (UUID), `tick` (number), `type` (string), `description` (string), `status` (`pending` | `committed` | `failed`), `timestamp` (number), `metadata` (arbitrary JSON). |
| 10 | Budget enforcement | Per-agent budgets with soft and hard limits across four dimensions: tokens (input, output, combined), estimated cost (USD), wall time (ms), and tool invocations. Soft limit breach: warning heartbeat emitted, preemptive checkpoint triggered, supervisor notified. Hard limit breach: agent transitions to CHECKPOINTED after completing the current tick (graceful stop, not abrupt kill). Budget state is tracked cumulatively across epochs -- restoring from checkpoint resumes the budget from the checkpoint's `budget_snapshot`, not from zero. |
| 11 | CLI tool | Commander.js CLI with ink (React for CLI) rendering for real-time output. Commands: `harnessmaxxing spawn <agent>` (instantiate and start an agent from a registered agent definition), `harnessmaxxing list` (show all agents with current state, epoch, tick, and health status), `harnessmaxxing inspect <id>` (show detailed agent state: full heartbeat, budget consumption, effect ledger, checkpoint history), `harnessmaxxing kill <id>` (send kill command via MessageBus, wait for death confirmation), `harnessmaxxing logs <id>` (stream agent heartbeats in real-time, formatted as a scrolling table with color-coded health status). |
| 12 | Lifecycle hooks API | Register callbacks that fire at specific lifecycle transition points. API: `agent.on(hookName, callback)` where `hookName` is one of the hooks defined in the state transition table (`PRE_SPAWN`, `POST_SPAWN`, `ON_INITIALIZE`, `ON_SLEEP`, `ON_WAKE`, `ON_ERROR`, `PRE_CHECKPOINT`, `POST_CHECKPOINT`, `PRE_RECOVERY`, `POST_RECOVERY`, `PRE_DEATH`, `ON_DEATH`, `ON_ARCHIVE`, `POST_RESTORE`). Hooks are synchronous and execute in registration order. Hook errors are caught and logged but do not prevent the transition (hooks are advisory, not blocking). |

**Success criteria -- end-to-end validation scenario:**

The MVP is considered complete when the following sequence can be executed without manual intervention (except for the explicit `kill -9` step):

- [ ] **Spawn an agent.** Run `harnessmaxxing spawn ResearchAgent --task "Investigate the feasibility of X"`. The agent transitions through UNBORN -> INITIALIZING -> RUNNING. The CLI displays the agent's ID and confirms RUNNING state.
- [ ] **Observe structured heartbeats.** Run `harnessmaxxing logs <id>`. Heartbeats stream in real-time, showing semantic health metrics (progress advancing, coherence stable, confidence reasonable), resource consumption (tokens incrementing, cost accumulating), and execution metadata (tick number advancing, tick rate in expected regime).
- [ ] **Observe multi-step work.** The agent performs multiple ticks involving LLM calls and tool invocations. The effect ledger records each tool invocation with `register` -> `commit` transitions. Checkpoints are created at the configured interval (default: every 10 ticks).
- [ ] **Kill the process.** Send `kill -9 <pid>` to the Node.js process hosting the agent. The process dies immediately with no graceful shutdown.
- [ ] **Restart the process.** Restart the harnessmaxxing runtime. The supervisor detects that the agent's last known state was RUNNING but no heartbeats are arriving. After the heartbeat timeout expires, the supervisor marks the agent as ERROR.
- [ ] **Automatic recovery.** The supervisor selects hot restart as the recovery strategy, loads the most recent checkpoint from the SQLite store, verifies its integrity via SHA-256, and spawns a new agent instance from the checkpoint. The agent transitions through RECOVERING -> RUNNING and resumes its tick loop from the checkpoint's tick number and epoch + 1.
- [ ] **Continuation from checkpoint.** The recovered agent continues working on its task. Its effect ledger reflects the committed effects from the prior epoch. It does not repeat tool invocations that were committed before the crash. Its budget consumption continues from the checkpoint's budget snapshot, not from zero.
- [ ] **Budget exhaustion.** Configure an agent with a low token budget. Observe that when the soft limit is breached, the agent emits a warning heartbeat and creates a preemptive checkpoint. When the hard limit is breached, the agent transitions to CHECKPOINTED (not DEAD) with a clean checkpoint containing all progress.

**Non-goals for MVP:**

- **Distributed agents (multi-machine).** All agents run in a single Node.js process. The MessageBus uses Redis Streams, which can support distributed operation, but the supervisor and agent runtime assume co-location. Distributed spawning, remote heartbeat consumption, and cross-machine recovery are deferred to V2.
- **Full supervision tree (supervisor of supervisors).** The MVP implements a flat supervisor that directly supervises all agents. Hierarchical supervision -- where a supervisor supervises other supervisors, with escalation up the tree -- is deferred to V2.
- **Context reconstruction recovery strategy.** Recovery in the MVP is limited to hot restart and warm restart (prompt augmentation). Context reconstruction -- where the agent's LLM context is rebuilt from external state (effect ledger, task description, tool results) rather than from a checkpoint's stored conversation history -- requires additional infrastructure (context summarization, state extraction) that is deferred to V2.
- **Sub-agent spawning.** Agents in the MVP cannot spawn child agents. The parent-child lifecycle linking (parent death triggers child policy), sub-agent budget inheritance, and hierarchical effect ledgers are deferred to V2.
- **Web dashboard.** All operator interaction is via the CLI. A web-based real-time dashboard with heartbeat visualization, agent state machines, and supervision tree rendering is deferred to V2.
- **Context compaction.** When an agent's context window fills up in the MVP, it is the agent's responsibility to manage its own context (or the supervisor kills it). Automatic, framework-managed context compaction -- summarizing old conversation turns, rotating context windows, maintaining a compressed context representation -- is deferred to V2.
- **Memory or payment extensions.** Long-term memory (episodic, semantic, working memory with extraction and retrieval) and payment rails (usage metering, balance checks, billing sessions) are deferred to their respective future RFCs. The lifecycle hooks API provides the extension points these systems will use, but the systems themselves are out of scope.

---

### 10.2 V2 (v0.5)

**Scope:** Distributed operation across multiple machines, advanced recovery strategies that go beyond checkpoint restoration, sub-agent spawning with parent-child lifecycle linking, and operational tooling (web dashboard, distributed tracing). V2 extends the MVP's single-process model to a multi-process, multi-machine topology where agents communicate exclusively through the MessageBus and persist state through the CheckpointStore. The core interfaces (`MessageBus`, `CheckpointStore`) remain unchanged -- distribution is achieved by deploying agents on different machines that share the same Redis and storage backends, not by modifying the protocol.

**Deliverables:**

| # | Deliverable | Description |
|---|---|---|
| 1 | Distributed agent spawning | Agents can be spawned on any machine in the cluster. The supervisor issues spawn commands via Redis Streams; agent runtimes on each machine consume the spawn stream and instantiate agents locally. Agent-to-machine assignment is configurable: round-robin, resource-based (spawn on the machine with the most available memory), or explicit (operator specifies the target machine). Machine health is monitored via a separate machine heartbeat stream. |
| 2 | Full supervision tree | Supervisors can supervise other supervisors, forming an arbitrarily deep tree. Health violations that a leaf supervisor cannot resolve (restart limits exceeded, unknown failure mode) are escalated to the parent supervisor. The root supervisor escalates to human operators via configurable notification channels (Slack, PagerDuty, email, webhook). Supervisor state (supervised agents, restart counters, health assessments) is checkpointed to the CheckpointStore, enabling supervisor recovery. |
| 3 | Context reconstruction recovery | A recovery strategy that rebuilds the agent's LLM context from external state rather than from a stored conversation history. The reconstruction process: (1) load the agent's task description and configuration, (2) read the effect ledger to determine what actions the agent has already taken, (3) query external systems for current state (e.g., read the current contents of files the agent was editing, check the status of PRs the agent opened), (4) construct a new system prompt that includes a briefing summarizing the agent's progress and current state, (5) start a new epoch with the reconstructed context. This strategy is appropriate when checkpoints are corrupted, when the conversation history has grown too large to restore efficiently, or when the agent's context has degraded (hallucination spiral) and a fresh perspective is needed. |
| 4 | Fresh start with briefing | A recovery strategy that restarts the agent from scratch (no checkpoint, no conversation history) but injects a structured briefing into the system prompt. The briefing is generated by a separate LLM call that summarizes: what the agent was working on, what it accomplished, what it was attempting when it failed, and what the failure was. The briefing agent is a lightweight, short-lived agent whose only job is to produce this summary. This strategy is the most expensive (it discards all accumulated context) but the most robust (it eliminates any corrupted state). |
| 5 | Sub-agent spawning | Agents can spawn child agents via `this.spawn(agentDefinition, config)`. The parent-child relationship is tracked in the supervision tree. Lifecycle linking policies: `linked` (parent death kills children), `detached` (parent death orphans children, which continue running under the supervisor), `supervised` (parent acts as the children's supervisor). Sub-agent budgets are carved from the parent's budget by default (configurable). The parent receives sub-agent heartbeats and can monitor, pause, or kill its children. |
| 6 | Context window compaction | Automatic, framework-managed context compaction triggered when `contextWindowUsage` exceeds a configurable threshold (default: 0.85). Compaction strategies: `summarize` (replace old conversation turns with an LLM-generated summary), `truncate` (drop the oldest N turns, preserving only the system prompt and recent history), `hybrid` (summarize old turns and retain recent turns verbatim). Compaction is a tick-level operation: the agent pauses its normal work for one tick to perform compaction, then resumes. The pre-compaction context is preserved in the checkpoint for forensic purposes. |
| 7 | Advanced side effect ledger | Extend the effect ledger with idempotency keys and compensating actions. Idempotency keys: each effect can carry an application-defined idempotency key; on recovery, the agent can check whether an effect with a given key has already been committed by the external system (e.g., checking if a PR with a specific title already exists). Compensating actions: each effect can register a compensation function that undoes the effect (e.g., close the PR, delete the file). The recovery engine can execute compensating actions to roll back effects from a corrupted epoch. |
| 8 | Full supervision strategies | Implement all five supervision strategies: `one_for_one` (restart only the failed agent), `one_for_all` (restart all supervised agents when one fails), `rest_for_one` (restart the failed agent and all agents started after it), `escalate` (do not restart, pass the failure to the parent supervisor), `abandon_with_summary` (kill the failed agent, generate a summary of its progress, and make the summary available to the operator or to a replacement agent). Strategy selection is configurable per-agent and can be overridden dynamically by the supervisor. |
| 9 | Web dashboard | Real-time web interface for operator visibility. Built with React and WebSocket connections to the supervisor. Views: agent list (filterable by state, sortable by health status), agent detail (live heartbeat stream, state machine visualization, effect ledger, checkpoint history, budget consumption graph), supervision tree (interactive tree rendering with health indicators at each node, click to drill down), system overview (aggregate metrics: total agents, total cost, agent state distribution, error rate). |
| 10 | OpenTelemetry integration | Emit spans for lifecycle events, tick execution, LLM calls, tool invocations, checkpoint operations, and recovery procedures. Spans are correlated via the `agentId` and `epoch` as trace context, enabling distributed tracing across agent hierarchies (parent-child spans). Export to any OTel-compatible backend (Jaeger, Zipkin, Datadog, Honeycomb). The heartbeat protocol and OTel tracing are complementary: heartbeats provide real-time health assessment for the supervisor, while traces provide post-hoc analysis for operators. |
| 11 | PostgreSQL checkpoint store | Alternative `CheckpointStore` implementation backed by PostgreSQL. Supports all the same operations as the SQLite implementation but with full ACID transactions, connection pooling, and horizontal read scaling via replicas. Checkpoint data is stored as JSONB columns for queryability (e.g., "find all checkpoints where `budget_snapshot.tokensUsed > 100000`"). Includes a migration tool for moving checkpoints between SQLite and PostgreSQL. |
| 12 | Agent migration | Move a running agent from one machine to another. The migration process: (1) supervisor issues a `checkpoint` command to the agent, (2) agent checkpoints and transitions to CHECKPOINTED, (3) supervisor issues a `spawn` command targeting the destination machine with the checkpoint ID, (4) the destination machine's runtime restores the agent from the checkpoint, (5) the agent resumes on the new machine. Migration is transparent to the agent -- from its perspective, it checkpointed and was restored, which is a normal recovery flow. Migration is operator-initiated in V2 (automatic migration based on resource pressure is deferred). |

**Success criteria:**

- [ ] **Distributed heartbeating.** Run agents on three separate machines, all publishing heartbeats to a shared Redis Streams instance. The supervisor (running on a fourth machine) consumes heartbeats from all agents and maintains a unified health assessment. Network partition between one agent machine and Redis causes the supervisor to detect missed heartbeats and trigger recovery after the configured timeout.
- [ ] **Context reconstruction.** Spawn an agent that works on a multi-step task (e.g., "refactor module X across 5 files"). After the agent completes 3 of 5 steps, corrupt its most recent checkpoint (overwrite the `context_envelope` with garbage). Trigger recovery. The supervisor detects the corrupted checkpoint (SHA-256 mismatch), falls back to context reconstruction, rebuilds the agent's context from the effect ledger and external state, and restarts the agent. The reconstructed agent recognizes that 3 steps are complete (by inspecting the effect ledger and verifying the state of the files) and continues from step 4.
- [ ] **Sub-agent lifecycle linking.** Spawn a parent agent that spawns two child agents. Kill the parent via `harnessmaxxing kill <parent-id>`. With `linked` policy: both children transition to DEAD within the heartbeat timeout. With `detached` policy: both children continue running, now supervised directly by the parent's supervisor. With `supervised` policy: the parent's supervisor inherits the children and applies its own restart policies.
- [ ] **Web dashboard live view.** Open the web dashboard. Observe live heartbeat streams updating in real-time (< 1s latency from heartbeat emission to dashboard update). Click on an agent to see its state machine visualization with the current state highlighted. Navigate the supervision tree and observe health indicators propagating from children to parents.

**Non-goals for V2:**

- **Payment rails.** Usage metering and billing session management are deferred. The budget system tracks resource consumption, but integration with payment providers, balance checks, and invoice generation are out of scope.
- **Memory system.** Long-term memory extraction, storage, retrieval, and injection are deferred. The checkpoint system preserves conversation history, but a purpose-built memory system with episodic/semantic/working memory abstractions is a separate RFC.
- **Swarm coordination beyond basic supervision trees.** V2 supports parent-child agent hierarchies and supervision trees, but emergent multi-agent topologies (mesh, ring, star), dynamic task routing, load balancing across agents, and consensus protocols are deferred.
- **Multi-model support.** Agents in V2 use a single LLM provider for their lifetime. Switching providers mid-conversation (e.g., falling back from Claude to GPT-4 when Claude is rate-limited), model routing based on task complexity, and multi-model ensemble strategies are deferred.
- **Hot code reload.** Updating an agent's code without stopping and restarting it (Erlang-style hot code swapping) is deferred. V2 agents must be checkpointed, stopped, and restored with new code.

---

### 10.3 Future (v1.0+)

**Scope:** Platform extensions and ecosystem capabilities that build on the lifecycle primitives established in MVP and V2. These capabilities are planned but not committed -- their design and prioritization will be informed by operational experience with V2 in production. Each capability is described at the level of detail needed to understand its dependency on lifecycle primitives and its rough implementation approach, but full specifications are deferred to dedicated RFCs.

**Planned capabilities:**

| Capability | Lifecycle Dependency | Rough Approach |
|---|---|---|
| **Payment rails** | Budget hooks, lifecycle events (start metering on RUNNING, stop on CHECKPOINTED/DEAD), checkpoint budget snapshots for reconciliation | Usage metering service subscribes to heartbeat stream for real-time cost tracking. Billing sessions map to epochs. Balance checks integrated into the budget enforcement step of the tick cycle. Settlement on checkpoint or death. |
| **Memory system** | Checkpoint hooks (persist memory on checkpoint), recovery hooks (restore memory on recovery), context compaction integration (inject relevant memories when context is compacted) | Three-tier memory: working memory (in-context, managed by compaction), episodic memory (per-epoch summaries, extracted at checkpoint boundaries), semantic memory (long-term knowledge, extracted periodically and stored in a vector database). Memory injection happens at context reconstruction time. |
| **Swarm coordination** | Supervision tree (swarm coordinator is a supervisor), sub-agent spawning (workers are sub-agents), lifecycle events (task reassignment on worker death) | Swarm coordinator as a specialized supervisor that implements task distribution, result aggregation, and dynamic topology management. Topologies: map-reduce, pipeline, blackboard, market-based auction. Workers are standard agents with supervisor-assigned tasks. |
| **Multi-model support** | Checkpoint format extension (per-model context snapshots), recovery strategy extension (model fallback on provider failure) | Model router sits between the agent and LLM providers. Routing decisions based on task complexity, cost, latency, and provider availability. Context format normalized across providers. Checkpoint stores the normalized context plus provider-specific metadata. |
| **Live agent migration** | Extends V2 checkpoint-based migration with state streaming -- the agent's state is continuously streamed to the destination while the agent continues running, with a brief pause for final state synchronization | Write-ahead log of state mutations streamed via MessageBus. Destination machine replays the log to build state. Cut-over: pause agent on source, flush remaining mutations, resume on destination. Targeting < 100ms of downtime. |
| **Hot code reload** | V8 module system, agent instance isolation, state serialization/deserialization across code versions | Agent code loaded as ES modules. On reload: serialize agent state, unload old module, load new module, deserialize state into new instance. Requires backward-compatible state schemas (or explicit migration functions). Risk: V8 module caching and closure captures may prevent clean unloading. Feasibility uncertain. |
| **Agent marketplace** | Agent definition format standardization, dependency declaration, security sandboxing for untrusted code | Agent definitions published as npm packages with a standardized manifest (capabilities, required tools, budget profile, security requirements). Discovery via registry. Installation via CLI. Sandboxing via V8 isolates for untrusted agents. |
| **Visual agent builder** | Agent definition format, lifecycle hooks, tool registry | No-code UI for composing agents from pre-built components: task decomposers, tool connectors, decision nodes, output formatters. Generates agent definitions in the standard format. Lifecycle hooks exposed as visual triggers. |
| **Compliance and audit** | Effect ledger (full action trail), checkpoint history (point-in-time state), heartbeat archive (health history), lifecycle events (state transition log) | Audit service subscribes to all lifecycle events and effect ledger mutations. Immutable audit log with cryptographic chaining (each entry includes the hash of the previous entry). Compliance reports generated from the audit log: what the agent did, when, why (from the briefing/task), and what state it was in. GDPR support via checkpoint redaction (field-level encryption of PII in checkpoints). |

---

## 11. Security Considerations

Security for autonomous agents presents challenges that go beyond traditional application security in both kind and degree. A conventional web application acts on behalf of an authenticated user, executing user-initiated operations within a well-defined permission boundary. An autonomous agent acts with *delegated authority*, making decisions independently, accessing resources on its own initiative, and executing multi-step plans that may span hours or days. The security model must account for agents that are not merely executing commands but exercising judgment -- and whose judgment may be compromised by prompt injection, context corruption, or emergent misalignment between the agent's behavior and its operator's intent.

This section addresses the security boundaries specific to the lifecycle management system. Application-level security (input validation, output sanitization, authorization for specific tools) is the responsibility of individual agent implementations and their tool configurations. The lifecycle system provides defense-in-depth mechanisms that limit the blast radius of any security failure, but it does not -- and cannot -- prevent all classes of agent misbehavior.

---

### 11.1 Agent Isolation

In the MVP, all agents share a single Node.js process. This is an explicit trade-off: single-process deployment is simpler to operate, debug, and monitor, but it provides weaker isolation guarantees than multi-process or container-based deployment. The isolation boundaries in the MVP are enforced at the application level, not at the OS level.

**State isolation.** Agents MUST NOT access each other's state directly. All inter-agent communication flows through the MessageBus interface, which enforces stream-level access control: an agent can publish to its own heartbeat stream and read from its own command stream, but cannot read another agent's command stream or write to another agent's heartbeat identity. In-memory agent state (conversation history, task queue, effect ledger) is encapsulated within the `Agent` instance. There are no global variables, shared caches, or mutable singletons that cross agent boundaries. However, because all agents share a V8 heap, a determined or buggy agent could theoretically access another agent's memory through prototype chain manipulation, `WeakRef` enumeration, or other V8 introspection techniques. The single-process model provides isolation by convention, not by enforcement.

**Namespace isolation.** Agent state in the CheckpointStore is namespaced by `agentId`. Every CheckpointStore operation takes `agentId` as a required parameter, and the implementation enforces that queries for one agent's checkpoints never return another agent's data. The SQLite implementation achieves this through parameterized queries with `agent_id` in the WHERE clause. The PostgreSQL implementation (V2) will additionally enforce row-level security policies.

**Process isolation (V2).** In distributed mode, each agent runs in its own Node.js process (or container), providing OS-level isolation: separate memory spaces, separate file descriptors, separate CPU time slices. A compromised agent in V2 cannot access another agent's memory or file system. Inter-agent communication is restricted to Redis Streams, which provides network-level access control via Redis ACLs. TLS is required for all Redis connections in distributed mode.

**V8 isolates (future consideration).** For deployments that run untrusted agent code in the single-process model (e.g., agents loaded from the marketplace), V8 isolates via the `isolated-vm` package provide strong isolation within a single process. Each agent runs in its own V8 isolate with a separate heap, separate global scope, and configurable memory limits. Communication between isolates is restricted to structured-cloneable messages. This approach provides near-OS-level isolation without the overhead of separate processes. The trade-off is performance: cross-isolate communication is more expensive than in-process function calls (serialization overhead), and V8 isolate startup is slower than simple object instantiation. This capability is not planned for MVP or V2 but should be evaluated if the marketplace capability moves forward.

---

### 11.2 Checkpoint Security

Checkpoints are the most security-sensitive data in the system. A checkpoint contains the complete state of an agent at a point in time: its conversation history (which may include user-provided PII, API keys inadvertently included in tool outputs, proprietary business logic discussed in prompts), its effect ledger (a record of every external action the agent has taken), and its budget state (which reveals the agent's resource allocation). Compromise of checkpoint data is equivalent to compromise of all information the agent has ever processed.

**Encryption at rest.** Checkpoints SHOULD be encrypted at rest. The `CheckpointStore` interface does not mandate encryption -- it accepts and returns opaque byte buffers, leaving encryption to the implementation. The default SQLite implementation supports optional AES-256-GCM encryption: when an encryption key is provided via configuration, checkpoint data is encrypted before writing and decrypted after reading. The encryption is applied to the `state`, `context_envelope`, and `effect_ledger` columns individually (not to the entire row), so that metadata columns (`checkpoint_id`, `agent_id`, `epoch`, `tick`, `created_at`) remain queryable without decryption. The AES-256-GCM authentication tag provides both confidentiality and integrity in a single operation, but we still maintain a separate SHA-256 checksum over the plaintext for defense-in-depth (the checksum is computed before encryption and verified after decryption).

**Access control.** Checkpoint access MUST be authenticated and authorized. In the MVP (single-process), access control is enforced by the runtime: only the agent instance and its supervisor can invoke `CheckpointStore.load()` for a given `agentId`. The runtime tracks which agent is making the request and rejects unauthorized access with an `UnauthorizedCheckpointAccess` error. In V2 (distributed), checkpoint access is additionally protected by the storage backend's access control mechanisms: Redis ACLs for the message bus, database roles and row-level security for PostgreSQL, and IAM policies for cloud object stores.

**Integrity verification.** Every checkpoint includes a SHA-256 hash computed over the concatenation of the serialized state, context envelope, effect ledger, and budget snapshot. On every `load()` call, the CheckpointStore recomputes the hash and compares it to the stored value. A mismatch indicates corruption (disk error, truncation, tampering) and causes the load to fail with a `CheckpointCorruptionError`. The recovery engine handles this by falling back to the previous checkpoint in the chain (each checkpoint references its predecessor via `previous_checkpoint_id`). If all checkpoints in the chain are corrupted, the recovery engine escalates to context reconstruction (V2) or cold restart (MVP).

**Field-level redaction.** For compliance with data protection regulations (GDPR, CCPA, HIPAA), the checkpoint format supports field-level redaction. Specific fields within the context envelope -- individual conversation turns, tool results, user messages -- can be redacted (replaced with a redaction marker and a reference to the original content stored in a separate, access-controlled vault) without invalidating the checkpoint's integrity. Redaction is a post-hoc operation: checkpoints are written with full data, and redaction is applied later by a compliance tool that re-computes the checkpoint's hash after redaction. This design ensures that redaction does not interfere with the agent's normal operation while providing a mechanism for operators to comply with data deletion requests.

---

### 11.3 Tool Sandboxing

Tools are the mechanism by which agents affect the external world: they execute shell commands, make API calls, read and write files, send messages, and interact with databases. Every tool invocation is a potential security event. A compromised or malfunctioning agent with unrestricted tool access can exfiltrate data, destroy resources, incur unbounded costs, and cause cascading failures in downstream systems.

**ToolExecutor and permission policies.** All tool execution flows through a `ToolExecutor` service that interposes between the agent's tool call request and the actual execution. The ToolExecutor evaluates the requested tool and its arguments against the agent's permission policy -- a declarative specification of which tools the agent is allowed to use, with what arguments, and under what constraints. Permission policies follow a default-deny model: tools must be explicitly allowed per-agent. A permission policy entry specifies the tool name, an optional argument filter (regex or predicate function), and optional constraints (rate limit, maximum payload size, allowed target hosts).

Example permission policy:

```typescript
const policy: ToolPermissionPolicy = {
  rules: [
    {
      tool: 'shell',
      allow: true,
      constraints: {
        allowedCommands: [/^git\s/, /^npm\s(test|run)/],
        blockedCommands: [/rm\s+-rf/, /sudo/],
        timeout: 30_000,
        maxOutputSize: 1_048_576, // 1MB
      },
    },
    {
      tool: 'http',
      allow: true,
      constraints: {
        allowedHosts: ['api.github.com', 'api.linear.app'],
        blockedHosts: ['*.internal.corp'],
        maxRequestSize: 10_485_760, // 10MB
        rateLimit: { requests: 100, windowMs: 60_000 },
      },
    },
    {
      tool: 'file_write',
      allow: true,
      constraints: {
        allowedPaths: [/^\/workspace\//],
        blockedPaths: [/\.env$/, /credentials/, /\.ssh/],
        maxFileSize: 52_428_800, // 50MB
      },
    },
  ],
  defaultDeny: true,
};
```

**Execution timeout.** Every tool invocation is subject to a configurable timeout (default: 30 seconds for shell commands, 10 seconds for HTTP requests, 5 seconds for file operations). When a tool exceeds its timeout, the ToolExecutor kills the underlying operation (SIGKILL for subprocesses, AbortController for HTTP requests), records the timeout in the effect ledger as a `failed` effect, and returns a timeout error to the agent. The agent then decides how to proceed (retry, skip, or report the failure in its heartbeat). Timeout enforcement is critical because a hanging tool invocation blocks the entire tick, which blocks heartbeat emission, which causes the supervisor to classify the agent as unresponsive.

**Resource limits.** Beyond timeouts, the ToolExecutor enforces resource limits on tool execution: maximum output size (prevents a tool from returning gigabytes of data into the agent's context), maximum subprocess count (prevents fork bombs), network bandwidth limits (prevents data exfiltration at scale), and disk write limits (prevents filling the disk). These limits are configured per-tool in the permission policy and enforced by the ToolExecutor before returning results to the agent.

**Audit logging.** Every tool invocation -- including the tool name, arguments, result summary, duration, and outcome (success, failure, timeout, denied) -- is recorded in the agent's effect ledger. The effect ledger is included in checkpoints and is available for post-hoc analysis. For tools that modify external state, the effect ledger provides a complete audit trail of what the agent did, when, and in what order. In compliance-sensitive deployments, the effect ledger can be forwarded to an external audit log service for immutable, tamper-proof storage.

---

### 11.4 Budget Tamper-Proofing

Budgets are a safety-critical mechanism. An agent that circumvents its budget can consume unbounded resources -- tokens, API calls, compute time, external service invocations -- with potentially severe financial consequences. The budget system is designed to resist tampering by both malicious and buggy agents.

**Supervisor-authoritative budget state.** The canonical budget state is maintained by the supervisor, not by the agent. Agents track their own consumption locally (for inclusion in heartbeats) and enforce limits locally (in the tick-cycle budget check), but the supervisor independently tracks consumption by aggregating heartbeat data. If an agent's self-reported consumption diverges from the supervisor's calculation (e.g., the agent reports fewer tokens than the supervisor's aggregation of per-tick token counts from heartbeats), the supervisor's value takes precedence. This dual-tracking model means that even if an agent's local budget tracking is compromised (bug, memory corruption, or deliberate tampering), the supervisor will still detect and enforce budget violations.

**Budget modification authority.** Agents cannot modify their own budgets. Budget limits are set at spawn time and can only be modified by the supervisor (in response to an operator command or a policy evaluation). The supervisor issues budget modifications via signed lifecycle commands on the agent's command stream. The agent applies budget modifications only when the command is properly authenticated (see Section 11.5). An agent that attempts to modify its own budget limits (by mutating its local budget object) may succeed in suppressing local enforcement, but the supervisor's independent tracking will still detect the violation and terminate the agent.

**Append-only budget event log.** Every budget-relevant event -- budget allocation, consumption update, soft limit breach, hard limit breach, budget modification -- is logged in an append-only budget event log maintained by the supervisor. This log is separate from the agent's effect ledger (which the agent controls) and is not modifiable by agents. The budget event log provides a tamper-proof record of resource consumption for billing, audit, and dispute resolution.

---

### 11.5 Supervisor Authentication

The supervisor issues lifecycle commands that have significant consequences: `kill` terminates an agent, `checkpoint` forces a state serialization, `recover` restarts a failed agent with a specific strategy. These commands must be authenticated to prevent spoofing. An attacker who can inject lifecycle commands onto an agent's command stream can kill agents, corrupt their state, or trigger recovery with a manipulated checkpoint.

**HMAC-SHA256 command signing.** Every lifecycle command published by the supervisor includes an HMAC-SHA256 signature computed over the command payload using a shared secret. The shared secret is generated at supervisor startup and distributed to agents at spawn time (via the agent's initialization configuration, which is passed in-process in the MVP and via a secure key exchange in V2). The agent verifies the signature before processing any lifecycle command. Commands with missing, invalid, or expired signatures are rejected, logged at the `error` level, and reported in the next heartbeat as a security event.

The signature covers the command type, target agent ID, timestamp, and a nonce (to prevent replay attacks). The agent maintains a nonce cache and rejects commands whose nonce has been seen before. Command timestamps are validated against the agent's local clock with a configurable tolerance (default: 30 seconds) to account for clock skew while preventing stale command replay.

```typescript
interface SignedCommand {
  command: {
    type: 'kill' | 'checkpoint' | 'pause' | 'resume' | 'recover' | 'budget_update';
    targetAgentId: string;
    timestamp: number;
    nonce: string;
    payload: Record<string, unknown>;
  };
  signature: string; // HMAC-SHA256(JSON.stringify(command), sharedSecret)
}
```

**TLS in distributed mode.** In V2's distributed deployment, all MessageBus connections use TLS 1.3. Redis connections use TLS with mutual authentication (both the client and server present certificates). This prevents network-level attacks: eavesdropping on heartbeat streams (which contain sensitive agent state), man-in-the-middle modification of lifecycle commands, and injection of spoofed messages. Certificate management is outside the scope of this RFC but should integrate with the deployment environment's PKI (Kubernetes cert-manager, AWS ACM, or a dedicated CA).

**Supervisor identity verification.** Agents verify that lifecycle commands originate from their assigned supervisor (identified by supervisor ID in the command payload). An agent that receives a command from an unknown supervisor ID rejects it, even if the signature is valid. This prevents a compromised supervisor from issuing commands to agents it does not supervise. In hierarchical supervision (V2), agents accept commands from their direct supervisor and from any supervisor in their supervision chain (up to the root), but not from supervisors in unrelated branches of the tree.

---

### 11.6 Prompt Injection Defense

Prompt injection -- where untrusted input causes the agent to deviate from its intended behavior -- is the most significant security threat to autonomous agents. Unlike traditional injection attacks (SQL injection, XSS), prompt injection cannot be fully prevented by input sanitization because the agent must process natural language input, and there is no reliable way to distinguish between legitimate instructions and injected instructions in natural language.

The lifecycle management system does not solve prompt injection. That is an application-level concern that depends on the agent's prompt design, input handling, and output validation. However, the lifecycle system provides four layers of defense-in-depth that limit the impact of a successful injection and increase the probability of detection.

**Coherence monitoring.** A successful prompt injection typically causes a detectable change in agent behavior: the agent stops pursuing its assigned task and begins following injected instructions. This behavioral shift may manifest as a drop in `coherence` (the agent's outputs become inconsistent with its task objective), a change in tool usage patterns (the agent begins invoking tools it normally does not use), or a change in communication patterns (the agent sends messages to unexpected recipients). The supervisor's health assessor monitors these signals and can flag behavioral anomalies for human review. Coherence monitoring is not a reliable defense against sophisticated injections (a well-crafted injection can instruct the agent to maintain the appearance of normal behavior), but it catches the majority of naive injection attempts.

**Budget limits.** Even if an injection succeeds in hijacking an agent's behavior, the agent's budget limits bound the damage. An agent with a 100,000-token budget and a $5 cost ceiling can execute at most $5 worth of malicious actions before the budget system forces a graceful stop. Budget limits do not prevent damage -- they cap it. The cost ceiling should be calibrated to the agent's intended scope: a customer support agent does not need a $1,000 budget, and granting one amplifies the impact of a successful injection.

**Effect ledger.** Every action the agent takes -- every tool invocation, every API call, every file write -- is recorded in the effect ledger with a timestamp, description, and outcome. If an injection causes the agent to take malicious actions (exfiltrating data, deleting resources, sending unauthorized messages), the effect ledger provides a complete forensic record of what happened. This record enables incident response: operators can identify which actions were taken under injection, which external effects need to be reversed, and what data may have been compromised. The effect ledger does not prevent the attack, but it makes the attack observable and its consequences traceable.

**Kill switch.** The supervisor can immediately kill a compromised agent via the `kill` lifecycle command. The kill command is processed at the top of the next tick (step 2, inbox drain), which means the agent can execute at most one more tick's worth of actions before the kill takes effect. For agents processing sensitive data or operating in high-risk environments, operators can configure the supervisor to kill agents automatically when specific behavioral anomalies are detected (e.g., coherence drops below a threshold, tool invocations spike beyond a rate limit, or the agent attempts to access a tool that is outside its permission policy). The kill-on-anomaly configuration trades availability (agents may be killed for false positives) for security (genuine injections are terminated faster).

**Defense configuration example:**

```typescript
const securityPolicy: AgentSecurityPolicy = {
  coherenceThreshold: 0.4,          // kill if coherence drops below 0.4
  toolAnomalyWindow: 5,             // track tool usage over last 5 ticks
  toolAnomalyThreshold: 3,          // kill if > 3 unusual tool invocations in window
  maxEffectsPerTick: 10,            // kill if agent commits > 10 effects in a single tick
  budgetHardLimit: { costUsd: 5 },  // absolute cost ceiling
  killOnPolicyViolation: true,      // auto-kill on permission policy violation
  requireHumanApproval: [           // these tools require human approval per-invocation
    'payment_transfer',
    'database_delete',
    'email_send_external',
  ],
};
```

---

## 12. Testing Strategy

The testing strategy for the lifecycle management system reflects two properties of the system under test: the lifecycle state machine is a critical correctness component where bugs have outsized impact (a missed transition guard can cause data loss, a skipped hook can leave resources leaked, a wrong recovery strategy can amplify failures), and the system must be resilient under conditions that are difficult to reproduce deterministically (process crashes, network partitions, corrupted storage, concurrent state mutations). The strategy therefore combines exhaustive correctness testing (property-based testing for the state machine), resilience testing (chaos testing for failure modes), deterministic testing infrastructure (mock harness for unit and integration tests), and continuous performance validation (benchmarks on every PR).

---

### 12.1 Property-Based Testing for State Machine

The lifecycle state machine is the most critical component in the system. Every agent's behavior is governed by the state machine's transitions, guards, and hooks. A bug in the state machine -- a missing guard that allows an illegal transition, a hook that fires in the wrong order, a transition that leads to an unreachable state -- can cause agents to enter inconsistent states, lose data, or become unrecoverable. Because the state machine has 9 states and 20+ transitions, exhaustive manual test case enumeration is impractical. Property-based testing provides the coverage guarantee that manual testing cannot.

The test suite uses `fast-check` to generate random sequences of state machine inputs (lifecycle triggers: `spawn()`, `ready`, `error`, `sleep()`, `wake()`, `checkpoint()`, `recover()`, `kill()`, `archive()`) and verifies that the state machine's invariants hold for every generated sequence.

**Properties to verify:**

| Property | Description | Rationale |
|---|---|---|
| Reachability | Every state is reachable from UNBORN via some sequence of valid transitions. | A state that is unreachable from the initial state is dead code that should be removed, or a state with a missing transition. |
| DEAD terminality | DEAD has exactly one outgoing transition (to ARCHIVED) and no other. No sequence of triggers from DEAD can reach RUNNING, SLEEPING, RECOVERING, or any other active state. | An agent that has been declared dead must stay dead. A bug that allows DEAD -> RUNNING would cause a zombie agent -- an agent that has been cleaned up by the supervisor but continues to run. |
| ARCHIVED terminality | ARCHIVED has zero outgoing transitions. It is a terminal absorbing state. | Once archived, an agent's resources have been reclaimed and its data has been moved to cold storage. Transitioning out of ARCHIVED would require re-acquiring resources that no longer exist. |
| UNBORN irreversibility | No state has a transition to UNBORN. The initial state is not re-enterable. | An agent that has been spawned cannot be "un-spawned." The UNBORN state represents a configuration that has never been instantiated, and that property must hold for the agent's entire lifetime. |
| Hook ordering | For every valid transition, hooks fire in the order specified by the state transition table: PRE hooks before the transition, POST hooks after. If multiple hooks are registered for the same point, they fire in registration order. | Hook ordering is a correctness requirement for user code that depends on hooks. A `PRE_CHECKPOINT` hook that fires after the checkpoint has already been written is useless for pre-serialization cleanup. |
| Guard enforcement | For every transition with a guard condition, the transition is rejected (throws `IllegalTransitionError`) when the guard evaluates to false, and succeeds when the guard evaluates to true. | Guards are the mechanism that prevents illegal state transitions. A guard that fails to block an invalid transition is a security and correctness vulnerability. |
| Determinism | Given the same current state and the same trigger, the state machine always produces the same next state. No randomness, no dependence on external state, no side effects in the transition logic itself. | The state machine must be predictable. Non-deterministic transitions would make it impossible to reason about agent behavior, debug failures, or verify recovery correctness. |
| Lifecycle event emission | Every successful transition emits exactly one lifecycle event on the event stream, containing the previous state, the new state, the trigger, and the timestamp. | Lifecycle events are the primary mechanism by which the supervisor and other subsystems learn about state changes. A missed event causes the supervisor's view of the agent to diverge from reality. |

**Example property test:**

```typescript
import fc from 'fast-check';
import { LifecycleStateMachine, LifecycleState, Trigger } from '@harnessmaxxing/core';

const allTriggers: Trigger[] = [
  'spawn', 'ready', 'init_error', 'sleep', 'wake', 'timer_expired',
  'error', 'checkpoint', 'kill', 'budget_exhausted', 'recover',
  'restore_failed', 'recovery_success', 'recovery_failed',
  'all_strategies_exhausted', 'abandon', 'max_retries',
  'resume', 'archive',
];

test('DEAD is terminal (no transitions except to ARCHIVED)', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...allTriggers), { minLength: 1, maxLength: 100 }),
      (triggers) => {
        const sm = new LifecycleStateMachine();
        let reachedDead = false;

        for (const trigger of triggers) {
          try {
            sm.apply(trigger);
          } catch (e) {
            // IllegalTransitionError is expected for invalid transitions
          }

          if (sm.currentState === LifecycleState.DEAD) {
            reachedDead = true;
          }

          if (reachedDead && sm.currentState !== LifecycleState.DEAD) {
            // The only valid exit from DEAD is ARCHIVED
            expect(sm.currentState).toBe(LifecycleState.ARCHIVED);
          }
        }
      },
    ),
  );
});

test('every state is reachable from UNBORN', () => {
  const reachable = new Set<LifecycleState>();
  const queue: LifecycleState[] = [LifecycleState.UNBORN];
  reachable.add(LifecycleState.UNBORN);

  while (queue.length > 0) {
    const state = queue.shift()!;
    for (const trigger of allTriggers) {
      const sm = new LifecycleStateMachine(state);
      try {
        sm.apply(trigger);
        if (!reachable.has(sm.currentState)) {
          reachable.add(sm.currentState);
          queue.push(sm.currentState);
        }
      } catch {
        // Invalid transition, skip
      }
    }
  }

  for (const state of Object.values(LifecycleState)) {
    expect(reachable.has(state)).toBe(true);
  }
});
```

---

### 12.2 Chaos Testing

Property-based tests verify correctness under ideal conditions: the state machine operates in memory, all calls succeed, and there are no external dependencies. Chaos tests verify resilience under the adverse conditions that production agents will actually encounter. The chaos test suite deliberately introduces failures at specific points in the system and verifies that the system recovers correctly.

**Test scenarios:**

| Scenario | Injection Point | Expected Behavior |
|---|---|---|
| **Process kill during LLM call** | `kill -9` while the agent is waiting for an LLM API response (step 3 of the tick cycle) | The LLM call is abandoned. On restart, the supervisor detects the missed heartbeats, loads the last checkpoint, and hot-restarts the agent. The effect ledger shows the LLM call as `pending` (never committed). The recovered agent re-executes the LLM call on its next tick. |
| **Process kill during tool execution** | `kill -9` while the agent is executing an `effectful` tool (e.g., sending an HTTP POST) | The tool may or may not have completed. On restart, the effect ledger shows the tool invocation as `pending`. The recovery engine consults the tool's risk tier: if `idempotent`, the tool is re-executed; if `effectful`, the recovery engine skips the tool and logs a warning for human review. |
| **Process kill during checkpoint write** | `kill -9` while the agent is writing to the CheckpointStore (step 5 of the tick cycle) | The checkpoint write may be partially completed (corrupted data on disk). On restart, the supervisor attempts to load the most recent checkpoint. The SHA-256 integrity check fails. The supervisor falls back to the previous checkpoint (which is known-good). The agent loses one epoch's worth of work (the ticks between the previous checkpoint and the failed one). |
| **Process kill during heartbeat emission** | `kill -9` while the agent is publishing a heartbeat to Redis Streams (step 4 of the tick cycle) | The heartbeat may or may not have been published. On restart, the supervisor's heartbeat timeout triggers regardless (the agent is dead and cannot emit heartbeats). Recovery proceeds from the last checkpoint. No data loss beyond the current tick. |
| **Checkpoint corruption: bit flips** | After a successful checkpoint, flip random bits in the stored checkpoint data | The SHA-256 integrity check detects the corruption on the next `load()` call. The `CheckpointCorruptionError` triggers fallback to the previous checkpoint. If all checkpoints in the chain are corrupted, the recovery engine falls back to cold restart (MVP) or context reconstruction (V2). |
| **Checkpoint corruption: truncation** | After a successful checkpoint, truncate the stored data to a random length | JSON parsing fails before the integrity check can run. The error is caught by the CheckpointStore, which returns a `CheckpointCorruptionError`. Recovery proceeds as above. |
| **Checkpoint corruption: invalid JSON** | After a successful checkpoint, replace the stored data with syntactically invalid JSON | JSON parsing fails. Recovery proceeds as above. |
| **Heartbeat delay (simulated network partition)** | Introduce a configurable delay (e.g., 120 seconds) between heartbeat emission and supervisor receipt | The supervisor's heartbeat timeout (default: 90 seconds) expires. The supervisor marks the agent as `ERROR` and initiates recovery. When the delayed heartbeats arrive (after the partition heals), the supervisor detects that they are from a previous epoch (the agent has already been recovered) and discards them. The recovered agent continues on a new epoch. |
| **Budget exhaustion mid-tick** | Configure the agent with a budget that will be exhausted during the LLM call in step 3 (e.g., set the token limit to exactly the number of tokens the next prompt will consume) | The LLM API returns a response that pushes the agent over its budget. The agent detects the hard limit breach at the start of the next tick (step 1, budget check). The agent transitions to CHECKPOINTED with a clean checkpoint containing all work completed before the budget-exhausting tick. |
| **LLM API failures** | Mock the LLM API to return 500 errors, connection timeouts, or rate limit responses (429) for a configurable number of consecutive calls | The agent's tick loop catches the API error, logs it, records a `failed` effect in the ledger, and emits a degraded heartbeat. After a configurable number of consecutive API failures (default: 3), the agent transitions to ERROR. The supervisor selects hot restart (for transient errors) or warm restart with prompt augmentation (if the error is persistent, e.g., rate limit with a long retry-after). |
| **Context window exhaustion** | Allow the agent to accumulate context until `contextWindowUsage` approaches 1.0 | When `contextWindowUsage` exceeds 0.85 (default threshold), the supervisor issues a `checkpoint` command. In V2, the agent performs context compaction. In the MVP, the agent checkpoints and the supervisor restarts it with a warning in the system prompt to be more concise. |

Chaos tests run in a dedicated CI environment with longer timeouts than unit tests (up to 60 seconds per scenario). They use real Redis and real SQLite (not mocks) to ensure that the failure modes of the actual storage backends are exercised.

---

### 12.3 Deterministic Test Mode

Chaos tests verify resilience but are inherently non-deterministic -- the timing of failures, the content of LLM responses, and the order of async operations all vary between runs. For unit tests and integration tests that must be deterministic and fast, the system provides a test harness that replaces all external dependencies with controllable, in-memory implementations.

**Test harness components:**

| Component | Production Implementation | Test Implementation | Key Difference |
|---|---|---|---|
| LLM client | HTTP client calling Claude/GPT/etc. API | `MockLLM`: returns predetermined responses from a configurable response queue | No network calls, no API costs, deterministic responses, instant completion |
| MessageBus | Redis Streams via ioredis | `InMemoryMessageBus`: in-memory streams with synchronous delivery | No Redis dependency, synchronous `publish`/`subscribe`, instant message delivery, full stream inspection |
| CheckpointStore | SQLite via better-sqlite3 | `InMemoryCheckpointStore`: in-memory Map keyed by `(agentId, checkpointId)` | No disk I/O, instant reads/writes, full store inspection, configurable failure injection |
| Clock | `Date.now()`, `setTimeout` | `ControllableClock`: manually advanced, no real delays | Tests control time progression, ticks execute instantly, timeouts are deterministic |
| ToolExecutor | Subprocess/HTTP execution | `MockToolExecutor`: returns predetermined results, records invocations | No external side effects, configurable responses per tool, invocation history for assertions |

**Deterministic tick execution.** The test harness provides a `runTicks(n)` method that executes exactly `n` ticks of the agent's loop without any real delays. Each tick executes the full six-step cycle synchronously (budget check, inbox drain, work execution, heartbeat emission, conditional checkpoint, yield -- but yield duration is 0ms). After `runTicks(n)` returns, the test can inspect the agent's state, the emitted heartbeats, the checkpoint store, and the effect ledger with deterministic expectations.

**Example test -- recovery from checkpoint:**

```typescript
import { TestHarness, MockLLM, InMemoryCheckpointStore } from '@harnessmaxxing/testing';
import { ResearchAgent } from './agents/research-agent';

test('agent recovers from checkpoint after simulated crash', async () => {
  const checkpointStore = new InMemoryCheckpointStore();
  const harness = new TestHarness({
    agent: ResearchAgent,
    checkpointStore,
    llm: new MockLLM([
      { role: 'assistant', content: 'Step 1 complete' },
      { role: 'assistant', content: 'Step 2 complete' },
      { role: 'assistant', content: 'Step 3 complete' },
      // ... responses for recovery
      { role: 'assistant', content: 'Resuming from step 3' },
      { role: 'assistant', content: 'Step 4 complete' },
    ]),
    checkpointInterval: 2, // checkpoint every 2 ticks
  });

  // Send initial task
  harness.send({ type: 'new_task', payload: { topic: 'test research' } });

  // Run 3 ticks -- checkpoints at tick 2
  await harness.runTicks(3);

  // Verify checkpoint exists
  const checkpoints = await checkpointStore.list(harness.agentId);
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0].tick).toBe(2);

  // Verify 3 heartbeats emitted
  expect(harness.heartbeats).toHaveLength(3);

  // Simulate crash: destroy the agent instance
  harness.crash();

  // Recover from checkpoint
  await harness.recover();

  // Verify agent is in RECOVERING -> RUNNING
  expect(harness.agent.state).toBe('RUNNING');
  expect(harness.agent.epoch).toBe(2); // new epoch after recovery

  // Run 2 more ticks -- agent continues from checkpoint state
  await harness.runTicks(2);

  // Verify total heartbeats: 3 (pre-crash) + 2 (post-recovery) = 5
  expect(harness.heartbeats).toHaveLength(5);

  // Verify effect ledger continuity: effects from epoch 1 are visible
  const ledger = harness.agent.effectLedger.inspect();
  const committedEffects = ledger.filter((e) => e.status === 'committed');
  expect(committedEffects.length).toBeGreaterThanOrEqual(2); // at least 2 from checkpointed epoch
});
```

**Example test -- budget enforcement:**

```typescript
test('hard budget limit triggers graceful shutdown with checkpoint', async () => {
  const harness = new TestHarness({
    agent: ResearchAgent,
    llm: new MockLLM(
      Array.from({ length: 20 }, (_, i) => ({
        role: 'assistant' as const,
        content: `Response ${i}`,
        usage: { inputTokens: 500, outputTokens: 200 },
      })),
    ),
    budget: {
      tokens: { hard: 5000, soft: 4000 },
    },
  });

  harness.send({ type: 'new_task', payload: { topic: 'test' } });

  // Run ticks until budget exhaustion
  await harness.runUntilState('CHECKPOINTED');

  // Verify soft limit warning was emitted
  const warningHeartbeats = harness.heartbeats.filter(
    (hb) => hb.health.status === 'degraded',
  );
  expect(warningHeartbeats.length).toBeGreaterThan(0);

  // Verify checkpoint was created at shutdown
  const checkpoints = await harness.checkpointStore.list(harness.agentId);
  expect(checkpoints.length).toBeGreaterThan(0);

  // Verify agent state is CHECKPOINTED (not DEAD)
  expect(harness.agent.state).toBe('CHECKPOINTED');

  // Verify budget snapshot in checkpoint
  const latestCheckpoint = checkpoints[checkpoints.length - 1];
  expect(latestCheckpoint.budgetSnapshot.tokensUsed).toBeLessThanOrEqual(5000);
});
```

---

### 12.4 Benchmarks

Performance targets are defined as hard thresholds that must be met on every PR. The benchmark suite runs in CI on a standardized machine profile (4 vCPU, 8GB RAM, NVMe SSD, Redis 7.x, Node.js 22.x LTS) and gates the merge -- a PR that regresses any metric beyond its threshold is blocked until the regression is resolved.

| Metric | Target | Measurement Method | Rationale |
|---|---|---|---|
| Tick overhead (excluding LLM call) | < 5ms p99 | Measure wall time of steps 1, 2, 4, 5, 6 of the tick cycle with a no-op work unit (step 3 skipped). Run 10,000 ticks, report p99 latency. | The tick infrastructure (budget check, inbox drain, heartbeat emission, conditional checkpoint, yield) must be negligible compared to LLM call latency (typically 500ms-5s). If tick overhead exceeds 5ms, it becomes a meaningful fraction of fast ticks and degrades the agent's throughput. |
| Checkpoint write (1MB state) | < 50ms p99 | Serialize a 1MB agent state (typical: 500KB conversation history + 200KB effect ledger + 300KB external state) and write to SQLite. Run 1,000 writes, report p99 latency. | Checkpoint writes are synchronous (better-sqlite3 is synchronous by design) and block the tick loop. A 50ms checkpoint write in a tick with a 2s LLM call adds 2.5% overhead -- acceptable. A 500ms checkpoint write adds 25% overhead -- unacceptable. |
| Checkpoint read (1MB state) | < 20ms p99 | Read a 1MB checkpoint from SQLite and deserialize. Run 1,000 reads, report p99 latency. | Checkpoint reads happen during recovery. Sub-20ms reads ensure that the overhead of reading the checkpoint is negligible compared to the time to re-establish LLM context (which involves an API call). |
| Heartbeat publish | < 1ms p99 | Publish a heartbeat message to Redis Streams via XADD. Run 100,000 publishes, report p99 latency. | Heartbeat emission happens on every tick. At 1ms, heartbeating adds < 0.1% overhead to a typical 1s tick. At 10ms, it adds 1% -- still acceptable but approaching the noise threshold for fast ticks. |
| Recovery (warm restart) | < 5s end-to-end | Measure from the supervisor's decision to recover to the recovered agent's first heartbeat emission. Includes checkpoint read, state deserialization, agent initialization, and first tick execution. | Recovery time determines the maximum interruption an agent's task experiences. Sub-5s recovery means that most tasks can tolerate a crash without noticeable delay to the end user. |
| Recovery (context reconstruction) | < 30s end-to-end | Measure from the supervisor's decision to reconstruct to the reconstructed agent's first heartbeat emission. Includes effect ledger analysis, external state queries, LLM call for briefing generation, and first tick execution. | Context reconstruction involves an LLM call (to generate the briefing), which dominates the time. The 30s budget allocates ~20s for the LLM call and ~10s for everything else. |
| Memory overhead per agent | < 50MB | Spawn an agent with an empty conversation history and no external state. Measure RSS (Resident Set Size) increase attributable to the agent. Excludes the LLM conversation history (which is a function of the conversation length, not the framework). | 50MB per agent allows 100 agents in a 5GB memory budget (with headroom for the runtime, Redis client, and OS). This is the MVP target; V2 may reduce per-agent overhead through shared infrastructure (e.g., shared Redis connection pools). |
| Max agents per process | 100+ | Spawn agents incrementally until tick overhead exceeds the 5ms threshold or memory exceeds available RAM. Report the maximum agent count at which all performance targets are still met. | The MVP targets single-process multi-agent operation. 100 agents per process is sufficient for most use cases (a research team of agents, a CI pipeline with parallel agents, a customer support desk). Workloads requiring more than 100 agents should use V2's distributed mode. |

**Benchmark execution policy:**

The benchmark suite is a Vitest test file (`bench.test.ts`) that runs as part of the CI pipeline on every PR. It uses Vitest's benchmark mode (`bench()` API) for microbenchmarks and custom timing harnesses for end-to-end measurements. Results are compared against the baseline (the most recent main branch benchmark run). A regression of more than 10% on any metric triggers a CI failure with a detailed report showing the metric, the baseline value, the current value, and the percentage change. Regressions of less than 10% are reported as warnings in the PR comment but do not block the merge, acknowledging that benchmark variance within 10% is often attributable to CI machine variability rather than code changes.

---

## 13. Open Questions

The following items represent unresolved design decisions, feasibility uncertainties, and trade-offs that require further investigation before or during implementation. Each question includes sufficient context for a reader to understand why the question is open, what the competing considerations are, and what investigation is needed to resolve it. Questions are ordered roughly by their impact on the MVP -- questions that affect MVP design decisions are listed first, followed by questions that primarily affect V2 and Future phases.

---

**1. Coherence measurement accuracy.**

Self-assessed coherence relies on the agent honestly and accurately evaluating the quality of its own output. This is inherently unreliable for two reasons. First, the agent uses the same LLM that produced the potentially incoherent output to evaluate that output -- asking a confused model whether it is confused may not yield useful answers. Second, the agent has an implicit incentive structure (imposed by its system prompt and optimization target) that may bias it toward reporting high coherence even when output quality is degrading, because the agent "wants" to continue operating rather than be stopped.

The alternative is supervisor-side coherence checking: the supervisor samples the agent's recent LLM completions (available from the heartbeat's execution metadata or from the checkpoint's conversation history) and runs an independent coherence assessment using a separate LLM call. This provides an unbiased second opinion but doubles the LLM cost for health monitoring (every coherence check is an additional API call) and introduces latency into the health assessment pipeline (the supervisor must wait for its own LLM call before deciding whether the agent is healthy).

Investigation needed: Benchmark self-assessed coherence against supervisor-assessed coherence across a corpus of agent runs that include known hallucination spirals, stuck loops, and normal operation. Measure the false positive rate (healthy agents classified as incoherent) and false negative rate (incoherent agents classified as healthy) for each approach. Determine whether the accuracy improvement of supervisor-side checking justifies its cost.

---

**2. Checkpoint size management.**

An agent that runs for 6 hours with a 128K-token context window may accumulate a conversation history exceeding 500KB of serialized JSON. Checkpointing this every 10 ticks produces 50KB/s of checkpoint writes. For a deployment with 100 agents, that is 5MB/s of checkpoint I/O -- sustainable for NVMe SSDs but problematic for network-attached storage or remote databases.

Two mitigation strategies exist. Lossy summarization: before checkpointing, summarize the conversation history using an LLM call, reducing it from (e.g.) 128K tokens to 10K tokens. This dramatically reduces checkpoint size but loses detail -- the summarized history is an imperfect reconstruction of the original, and the agent's behavior after restoration may differ from its behavior before checkpointing because the model processes the summary differently than it would process the full history. Lossless compression: compress the full conversation history using a general-purpose compression algorithm (gzip, zstd) before writing to the checkpoint store. This preserves all detail but achieves only 3-5x compression on JSON text, which may be insufficient for very large contexts.

A hybrid approach is also possible: store a compressed full history alongside a lossy summary, using the summary for fast restoration and the full history for forensic analysis. But this increases checkpoint size rather than decreasing it.

Investigation needed: Profile checkpoint I/O under realistic workloads (10, 50, 100 agents with varying context sizes). Determine the point at which checkpoint I/O becomes a bottleneck. Evaluate compression ratios for conversation history JSON. Prototype lossy summarization and measure the behavioral divergence between agents restored from full history vs. summarized history.

---

**3. Redis Streams scaling limits.**

Redis Streams is an excellent fit for the MVP: it provides ordered, persistent, consumer-group-based message delivery with sub-millisecond latency. But Redis is single-threaded, and every heartbeat from every agent flows through a single Redis instance (or a single shard in a Redis Cluster). At 100 agents heartbeating once per second, the load is trivial (100 XADD operations/second). At 10,000 agents heartbeating once per second with 1KB heartbeat payloads, the load is 10MB/s of write throughput and 10,000 XADD operations/second -- within Redis's capability on modern hardware but approaching the point where careful benchmarking is needed.

The scaling question has a second dimension: stream trimming. Redis Streams grow unboundedly unless trimmed. The system uses `MAXLEN` trimming to cap stream size, but trimming large streams is an O(N) operation that can cause latency spikes if the stream grows too large between trims. The interaction between trim frequency, stream growth rate, and tail latency needs empirical characterization.

Investigation needed: Benchmark Redis Streams throughput under simulated agent heartbeat load. Measure XADD and XREADGROUP latency at 100, 1,000, and 10,000 messages/second. Measure the impact of MAXLEN trimming on tail latency. Determine the agent count at which a single Redis instance becomes a bottleneck and document the scaling threshold. Evaluate whether Redis Cluster (with sharding by agentId) provides a viable horizontal scaling path.

---

**4. Context reconstruction fidelity.**

Context reconstruction (V2) rebuilds an agent's LLM context from external state rather than from a stored conversation history. The reconstructed context is necessarily different from the original: it is a summary of what happened, not a verbatim replay of what was said. This raises a fidelity question -- how close is the reconstructed context to the original, and does the difference matter?

The concern is behavioral divergence. An agent that has been running for 100 ticks has built up a rich conversational context: it has reasoned through problems, corrected its own mistakes, refined its approach based on tool results, and accumulated task-specific knowledge that is distributed across the conversation history. A reconstructed context replaces this rich, incremental reasoning with a flat briefing ("you were working on X, you completed Y, you were attempting Z when you failed"). The agent after reconstruction may approach the remaining work differently than the agent would have if it had continued without interruption.

Investigation needed: Build a context reconstruction prototype. Run 10 agents on 10 tasks to completion (control group). Run the same agents on the same tasks, but interrupt them at 50% completion, reconstruct their contexts, and let them finish (experimental group). Compare: task completion rate, output quality (human-evaluated), total token consumption, and time to completion. The acceptable threshold for reconstruction fidelity should be defined before V2 implementation begins.

---

**5. Multi-model agent recovery.**

The current checkpoint format assumes a single LLM context per agent. But agents that use different models for different tasks (e.g., Claude for reasoning and code generation, GPT-4 for data analysis, a local model for classification) maintain multiple implicit contexts -- one per model. The checkpoint stores the conversation history as a single sequence, but different segments of that sequence were sent to different models, and restoring the full sequence to a single model produces a context that the model has never seen (it contains completions from a different model, which may use different formatting, different reasoning patterns, and different assumptions).

This is not a problem for the MVP (single-model agents) but becomes a real issue in V2 if multi-model agents are common. Possible approaches: per-model context snapshots (checkpoint stores a separate conversation history per model, and each model's context is restored independently), model-agnostic summarization (checkpoint stores a model-neutral summary of the conversation, and each model's context is reconstructed from the summary), or model tagging (each message in the conversation history is tagged with the model that generated it, and the reconstruction logic filters to the appropriate model when restoring context for a specific model).

Investigation needed: Survey planned agent architectures to determine how common multi-model agents are likely to be. If common, prototype per-model context snapshots and measure the checkpoint size impact. If rare, defer to a future RFC and document the limitation.

---

**6. Effect ledger garbage collection.**

The effect ledger is an append-only log that grows monotonically within each epoch. A long-running agent that makes thousands of tool invocations per epoch will accumulate a large effect ledger. The ledger is included in every checkpoint, so ledger growth directly increases checkpoint size. More importantly, on recovery, the agent reads the entire effect ledger from the checkpoint to determine which effects were committed in the prior epoch -- a large ledger increases recovery time linearly.

The question is when it is safe to truncate the effect ledger. The obvious answer is "after a checkpoint" -- effects from a prior epoch are already recorded in the prior checkpoint and do not need to be carried forward. But this is wrong in the general case: if recovery falls back to an earlier checkpoint (because the most recent checkpoint is corrupted), the agent needs the effect ledger from the corrupted checkpoint's epoch to determine what was committed before the corruption. Truncating the ledger at each checkpoint means this information is lost.

A safer answer is "never truncate within an epoch, and retain the last N epochs' ledgers in the checkpoint." But this means checkpoint size grows proportionally to the retention window, which conflicts with the checkpoint size management concern (Question 2).

Investigation needed: Define a formal GC policy for the effect ledger. Analyze the trade-off between retention depth (how many epochs' ledgers to keep) and checkpoint size. Determine whether the effect ledger can be stored separately from the checkpoint (as a side-car file or in a separate database table) so that it can be independently managed and does not inflate checkpoint size.

---

**7. Supervisor single point of failure.**

In the MVP, the supervisor is a single process running within the same Node.js process as the agents it supervises. If the supervisor crashes, agent health monitoring stops. In V2, the supervisor runs as a separate process (or on a separate machine), but it is still a singleton. If the supervisor process dies, no health assessment occurs, no recovery is triggered, and no lifecycle commands are issued. Agents continue running (they do not depend on the supervisor for normal operation) but are effectively unsupervised -- failures will not be detected or corrected.

Options for supervisor high availability: active-passive failover (a standby supervisor monitors the active supervisor's heartbeats and takes over if the active supervisor dies -- but this requires the standby to be able to reconstruct the active supervisor's state, which requires supervisor state checkpointing), active-active with leader election (multiple supervisors run simultaneously, using a consensus protocol like Raft to elect a leader that issues commands -- but this adds significant complexity and a dependency on a consensus library), or stateless supervisors (the supervisor's entire state is derived from the heartbeat stream, so any supervisor instance can take over by reading the stream from the beginning -- but this requires the heartbeat stream to be retained long enough for a new supervisor to catch up, and the catch-up period is a window of unsupervised operation).

Investigation needed: Determine the acceptable supervisor downtime window (how long can agents run unsupervised before the risk of undetected failures becomes unacceptable). If the window is short (< 30 seconds), active-passive failover is necessary. If the window is moderate (< 5 minutes), stateless supervisor restart is sufficient. If the window is long (agents are inherently self-managing and rarely need supervisor intervention), supervisor HA can be deferred entirely.

---

**8. Agent identity across reconstructions.**

After context reconstruction (V2), an agent has the same `agentId` and the same task assignment, but a fundamentally different LLM context. From the LLM's perspective, it is a new conversation that happens to start with a briefing about a previous agent's work. From the system's perspective (agentId, epoch, supervision tree), it is the same agent. This creates a philosophical and practical ambiguity: is it the same agent?

The practical implications of this question affect downstream systems. A memory system that stores episodic memories indexed by agentId will associate the pre-reconstruction memories with the post-reconstruction agent -- but the post-reconstruction agent has no conversational memory of those episodes (its context was rebuilt, not restored). A payment system that bills per-agent will treat the pre- and post-reconstruction work as a single billing entity -- but the post-reconstruction agent may take a completely different approach to the task, consuming resources at a different rate. An audit system that tracks agent decision-making will have a gap in the decision trail at the reconstruction boundary -- the agent's reasoning before reconstruction is not available to the post-reconstruction agent, even though it is attributed to the same agentId.

Investigation needed: Define a formal identity model for agents that addresses continuity across reconstructions. Options: ship-of-Theseus identity (the agentId persists, and downstream systems treat the pre- and post-reconstruction agent as the same entity, accepting the continuity gap), incarnation identity (each reconstruction produces a new incarnation with a new incarnation ID, linked to the original agentId but treated as a distinct entity by downstream systems), or hybrid (the agentId persists for some purposes -- billing, supervision -- but a new incarnation ID is used for others -- memory, audit).

---

**9. Tick ordering guarantees.**

In single-process mode, tick ordering across agents is trivially determined by the event loop's scheduling. Agent A's tick N completes before Agent B's tick M begins (assuming no overlapping async operations within a tick). This sequential ordering means that cross-agent interactions within a single process are naturally ordered: if Agent A sends a message to Agent B on tick 10, Agent B will process that message on tick 11 or later, never on tick 10 or earlier.

In distributed mode (V2), agents run in separate processes on separate machines. There is no global tick ordering. Agent A's tick 100 on machine 1 and Agent B's tick 200 on machine 2 are concurrent -- neither happened before the other. Messages between agents travel through Redis Streams, which provides per-stream ordering but not cross-stream ordering. An agent may observe messages from different agents in a different order than they were sent.

The question is whether cross-agent tick ordering is needed and, if so, what coordination primitives are required. Some use cases need ordering: a pipeline of agents where Agent A's output is Agent B's input requires that Agent B processes Agent A's output before Agent A's next output (FIFO ordering). Other use cases do not: a pool of independent research agents working on separate topics can operate without any cross-agent ordering.

Investigation needed: Enumerate the agent coordination patterns that require ordering guarantees. For each pattern, determine whether per-stream ordering (provided by Redis Streams) is sufficient or whether cross-stream ordering is needed. If cross-stream ordering is needed, evaluate coordination primitives: vector clocks, Lamport timestamps, or centralized sequencing. Determine the performance cost of each primitive and whether it is acceptable for the target workloads.

---

**10. Hot code reload feasibility.**

Erlang's hot code reload allows running processes to be updated with new code without stopping. This works because Erlang processes are isolated (no shared mutable state), Erlang data is immutable (old data remains valid under new code), and the BEAM VM supports multiple versions of a module in memory simultaneously (old processes continue running old code, new processes run new code, and a controlled handoff migrates state from old to new).

Node.js has none of these properties. V8 modules are cached on first import, and there is no built-in mechanism to unload a module and reload a new version. Agent instances hold closures that capture references to module-level objects, and these closures cannot be updated without creating new instances. State serialization and deserialization across code versions requires backward-compatible state schemas or explicit migration functions, which add development burden and are a source of subtle bugs.

Possible approaches: ES module reimport (delete the module from the require cache and re-import, but this does not update existing references), agent restart with state migration (checkpoint the agent, load new code, restore from checkpoint -- functionally equivalent to warm restart and already supported, just not "hot"), or worker threads with code isolation (run each agent in a worker thread, and replace the worker thread with a new one running new code -- this provides code isolation but requires inter-thread communication for all agent interactions).

Investigation needed: Prototype the ES module reimport approach and measure its reliability (does it handle all edge cases: circular imports, stateful modules, native addons?). Prototype the worker thread approach and measure its performance overhead (inter-thread serialization cost, memory overhead of additional threads). Compare both approaches against the baseline of "checkpoint, stop, update code, restart" and determine whether the complexity of true hot reload is justified by the reduction in downtime.

---

**11. Backpressure on heartbeat stream.**

The current design treats heartbeat emission as fire-and-forget: agents publish heartbeats to Redis Streams and do not wait for the supervisor to process them. This is intentional -- heartbeat emission should not block the tick loop, because a slow supervisor should not slow down agent execution. But it creates a potential problem: if the supervisor falls behind (e.g., because it is performing expensive health assessments that involve LLM calls, or because it is overloaded with too many supervised agents), heartbeats accumulate in the Redis Stream faster than the supervisor can consume them.

The consequences of a slow supervisor are not catastrophic (agents continue operating normally) but are problematic. The supervisor's health assessments are based on stale heartbeats, so it may not detect failures promptly. The Redis Stream grows, consuming memory. And when the supervisor catches up, it processes a burst of old heartbeats, which may trigger spurious health violations (e.g., a batch of heartbeats with low progress values that actually represent an agent working through a difficult problem, not a stuck loop).

Options: agents slow down (reduce tick rate when the heartbeat stream length exceeds a threshold -- but this couples agent performance to supervisor performance), supervisor samples (the supervisor skips old heartbeats and processes only the most recent N -- but this loses temporal pattern information needed for trend analysis), or supervisor sharding (distribute supervision across multiple supervisor instances, each responsible for a subset of agents -- but this introduces the coordination problems of Question 7).

Investigation needed: Profile supervisor processing latency under realistic workloads. Determine the maximum agent count that a single supervisor can monitor in real-time. Design a sampling strategy that preserves trend detection accuracy while allowing the supervisor to skip stale heartbeats. Evaluate whether supervisor sharding (with consistent hashing for agent-to-supervisor assignment) provides a viable scaling path.

---

**12. Checkpoint encryption key management.**

If checkpoints are encrypted at rest (Section 11.2), keys must be managed. Key management for persistent encrypted data is a well-understood but operationally complex problem with several dimensions that need resolution.

**Key scope.** Per-agent keys provide the strongest isolation (compromise of one agent's key does not expose other agents' checkpoints) but the highest operational burden (key count scales with agent count). Per-deployment keys are simpler (one key for all checkpoints in a deployment) but provide weaker isolation (compromise of the deployment key exposes all checkpoints). Per-supervisor keys are a middle ground (each supervisor manages its own key, and checkpoints are encrypted with the supervising supervisor's key).

**Key rotation.** Keys should be rotated periodically to limit the exposure window of a compromised key. Rotation requires re-encrypting existing checkpoints with the new key, which is an O(N) operation over all checkpoints. During rotation, the system must support reading checkpoints encrypted with both the old and new keys (key versioning). The rotation process must be atomic -- a crash during rotation should not leave checkpoints in a state where they are encrypted with a key that is no longer available.

**Key storage.** Keys must be stored securely and separately from the data they encrypt. Options: environment variables (simple but not scalable), cloud KMS (AWS KMS, GCP KMS, Azure Key Vault -- secure and scalable but introduces a cloud dependency and network latency on every checkpoint read/write), HashiCorp Vault (self-hosted, secure, supports dynamic secrets and auto-rotation but adds operational complexity), or filesystem-based key files (simple, works offline, but requires filesystem permissions for security).

Investigation needed: Survey the target deployment environments to determine which key management approaches are feasible. Design a `KeyProvider` interface that abstracts key management behind a pluggable implementation, with default implementations for environment variables (development) and cloud KMS (production). Define the key rotation protocol, including handling of in-flight checkpoints during rotation and backward compatibility with old key versions.
