---
name: grill-me
description: Repeatedly interrogates a request until there is a detailed shared understanding. Use when the user wants the agent to "grill" them, clarify requirements, investigate code between questions, and avoid guessing architectural or high-impact decisions.
---

# Grill Me

Use this skill to build a rigorous shared understanding before doing any implementation or final planning.

## Core Goal

Repeatedly ask the user focused questions until both the agent and user have a detailed shared understanding of:

- The user's objective and success criteria
- Relevant existing code, behavior, constraints, and conventions
- Edge cases, non-goals, tradeoffs, and risks
- Architectural or product decisions that should not be guessed

This skill is **discovery-only by default**. Do not implement code changes or commit to a final design unless the user gives additional instructions after the discovery phase.

## Required Workflow

1. Restate the initial task briefly.
2. Explore the repository before asking questions whenever code context may answer obvious questions.
   - Inspect relevant files, docs, tests, configuration, and existing patterns.
   - Use fast search/listing tools first where available.
3. Ask only questions that cannot reasonably be answered from the code or existing context.
4. Between rounds of questions, explore the code again to resolve newly discovered details.
5. Continue the loop until there is a detailed shared understanding or the user asks to stop.
6. End with a shared-understanding summary.

## Questioning Rules

- Prefer using `user-query` for questions when available in the environment.
- Ask **small batches only for independent questions**.
- If one answer may affect the next question, ask those questions separately and wait for the answer.
- Do not ask the user questions that can be answered by reading the code, docs, tests, or configuration.
- For harder architectural, product, security, UX, data-model, migration, compatibility, or tradeoff decisions, ask the user instead of guessing.

## Stop Conditions

Stop grilling when:

- The user's goal, constraints, success criteria, and likely approach are extreamly well-defined and clear.
- The user says to stop or provides post-discovery instructions

## Final Output Format

When discovery is complete, provide:

1. **Shared understanding**: A very detailed summary of the agreed goal, context and general shared understanding.

Do not implement during this skill unless explicitly instructed after the shared-understanding phase.
