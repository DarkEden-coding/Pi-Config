---
name: grill-me
description: Stress-tests a request, plan, decision, or idea through rounds of questions until there is a detailed shared understanding. Use for "grill" requests, requirement clarification, or decisions that should not be guessed.
---

# Grill Me

Use this skill to build a rigorous shared understanding before doing any implementation or final planning.

## Writing

Before drafting restatements, questions, or the final summary, load and apply the `unslop` skill. Use it as the source of truth for user-facing prose instead of duplicating its writing rules here.

## Goal

Build a shared understanding before implementation or final planning. Cover the objective, success criteria, relevant existing behavior, constraints, edge cases, non-goals, tradeoffs, risks, and decisions that should not be guessed.

This skill is discovery-only by default.

## Design tree

Map the request as a tree of decisions. A decision becomes part of the **frontier** when all decisions and facts it depends on are settled.

Work in rounds:

1. Build or update the design tree from the request and known context. Do not restate the request unless a correction or clarification would help.
2. Resolve environmental facts needed by frontier questions. Inspect the repository, docs, tests, configuration, or tools directly. Use a sub-agent only when the investigation is substantial and independent.
3. Ask the entire frontier in one round with `ask_user_questions`. Do not include questions that depend on another answer still open in that round.
4. Use the answers to settle decisions, reshape the tree, and compute the next frontier.
5. Repeat until the frontier is empty or the user asks to stop.

Explore only when a fact affects a current or likely question. Do not force repository exploration or repeat it between rounds without a reason.

## Questions

- Ask the user for decisions. Find facts yourself whenever the environment can answer them.
- Number every question. Keep the question text to the question itself. Do not put the recommendation or its rationale in the question.
- Give selectable options when they make the decision easier, while allowing a custom answer. When recommending an answer, put it first in the options and include the recommendation and brief rationale in that option.
- Ask all independent frontier questions together, but exclude irrelevant or speculative branches.
- Ask rather than guess about consequential product, architecture, security, UX, data-model, migration, compatibility, and tradeoff decisions.

## Completion

When the frontier is empty, provide a detailed shared-understanding summary and ask the user to confirm it. Do not implement or commit to a final design until the user confirms the summary and gives post-discovery instructions.
