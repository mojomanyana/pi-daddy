# SOURCE INPUT — Architecture Handoff (verbatim)

> **Status:** Source input, received 2026-08-08. This document is preserved as-received and is **not yet validated**.
> It is the starting hypothesis for the Dynamic Tool & Context Management initiative — not a decided design.
> Disagreements with it are recorded in `02-assumptions.md`, `03-risks.md`, and `06-decisions/` — never edited into this file.

---

# SYSTEM ARCHITECTURE HANDOFF: DYNAMIC TOOL & CONTEXT MANAGEMENT

**To the Development Agent:**
You are receiving a comprehensive architectural blueprint for a custom LLM Agent system (a fork of the Pi Dev Agent). Your objective is to ingest this conceptual design, translate it into concrete technical specifications (API contracts, database schemas, state machines), and prepare the project scaffolding. Do not generate the final implementation code yet; focus on system design and architectural mapping based on the parameters below.

---

## 1. Executive Summary & Core Concept

**The Problem (Context Bloat):**
Modern LLM agents suffer from context saturation. By loading the definitions, descriptions, and JSON/OpenAPI schemas of *all* available skills and sub-agents into the initial system prompt, the system consumes excessive tokens, dilutes the model's focus (increasing hallucination rates), and fundamentally fails to scale to hundreds of tools.

**The Solution (Just-In-Time Architecture):**
An "Agentic OS" approach utilizing a **Dual-Layer Architecture with Dynamic Tool Retrieval**. Instead of overloading the Top Agent, an intermediary **Orchestrator** dynamically "mounts" and "unmounts" tools into the context only when strictly necessary. The Orchestrator also handles two-way context flow, aggregating sub-agent responses to protect the Top Agent's context window.

---

## 2. High-Level System Architecture

The architecture relies on four strictly decoupled modules.

### Module A: The Top Agent (The Brain & Communicator)
* **Role:** The primary user-facing interface. Handles high-level reasoning, intent recognition, and dialogue management.
* **State:** Operates with a minimal, static System Prompt. It is completely unaware of the underlying tool schemas.
* **Behavior:** Instructed to delegate actions, data fetching, or tool utilization to the Orchestrator via natural language or explicit commands.

### Module B: The Orchestrator / Context Manager (The Heart)
* **Role:** The central middleware. Intercepts requests from the Top Agent, resolves required tools, executes them, and manages the Top Agent's active context.
* **Responsibilities:**
  * **Routing:** Determines if a request is a direct command (e.g., `/git_clone`) or requires a semantic search.
  * **Mounting/Unmounting:** Dynamically injects the required tool schemas into the Top Agent's context for the current turn.
  * **Aggregation:** Asynchronously triggers multiple tools/sub-agents, collects raw data, summarizes it using a lightweight LLM, and returns only the aggregated payload to the Top Agent.

### Module C: Registry & Vector Store (The Database)
* **Role:** The persistence layer for skills, sub-agent instructions, and tool schemas.
* **Storage Paradigm:** A hybrid approach using a Vector Database (for semantic discovery) and a Key-Value Store (for exact tag/command matching).

### Module D: Lifecycle Configuration (Eviction Strategy)
* **Role:** A configuration engine nested within the Orchestrator that dictates when a mounted tool is removed from the Top Agent's context.

---

## 3. Component Specifications & Constraints

### 3.1. Hybrid Registry Implementation
* **Infrastructure:** Containerized (Docker).
* **Semantic Layer:** Qdrant or ChromaDB for natural language discovery (e.g., "I need a way to read databases" -> maps to `sqlite_query`).
* **Exact Match Layer:** Redis or SQLite for explicit tag/command mapping (e.g., `/fs_manager` -> maps to a bundle: `file_read`, `file_write`, `file_list`).
* **Data Structure:** Every tool must contain: `Unique ID`, `Name`, `Explicit Tags`, `Semantic Description`, and `OpenAPI/JSON Schema`.

### 3.2. Context Mounting Logic (Just-In-Time Injection)
* **Injection Strategy:** Do not rewrite the core System Prompt dynamically. Use **System Message Injection** or **Tool Messages** in the conversational history array.
* **Flow:** Orchestrator injects a message (e.g., *"Tool [Name] is now available. Schema: [Schema]"*). The Top Agent processes this in the next inference cycle, utilizes the tool, and awaits the aggregated result.

### 3.3. Configurable Lifecycle & Eviction Policies
The Orchestrator must support the following eviction modes:

| Eviction Mode | Description | Ideal Use Case |
| :--- | :--- | :--- |
| **TURN_BASED** | Hard limit. All tools unmount after the Top Agent replies to the user. | Q&A, short distinct tasks. |
| **AUTONOMOUS** | Top Agent or Orchestrator explicitly calls `unmount(skill_name)`. | Long-running coding sessions. |
| **TIMEOUT** | Sliding window. Tools are evicted if unused for *N* user turns. | Exploratory research tasks. |

---

## 4. Advanced Concepts to Integrate
* **Contextual Tool Bundles:** Group highly correlated tools. Requesting Git operations should mount a `git_bundle` (pull, commit, push, status) due to sequential dependency.
* **Aggregator Flow Execution:** Sub-agents must run in isolated execution environments. Their raw outputs (potentially tens of thousands of tokens) must never reach the Top Agent directly. An Aggregator LLM must compile them into a concise, structured report first.
* **Observability:** Strict logging within the Orchestrator to track mounted tools, lifecycle duration, and token savings.

---

## 5. Developer Directives (Immediate Next Steps)
Based on this blueprint, please execute the following steps sequentially:

1. **API Contracts:** Draft the strict JSON interfaces/schemas for communication between the Top Agent and the Orchestrator.
2. **Database Schema:** Design the data models for the Hybrid Registry (Vector + Key-Value).
3. **State Machine:** Map out the exact logic flow for the Lifecycle Management (Eviction Strategies).
4. **Scaffolding Proposal:** Recommend the directory structure and technology stack (e.g., Python, LangGraph/LlamaIndex, FastAPI, Docker) required to build this.

---

> **Initiative note:** Directive 5's steps 1–4 are **gated behind Phase D0 (discovery)** — see `docs/ROADMAP.md`.
> They execute in Phase D1 only after gate **G0** passes, and their outputs land in `docs/specs/` following repo convention.
