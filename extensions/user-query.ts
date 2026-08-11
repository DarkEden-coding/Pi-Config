import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const questionSchema = Type.Object({
  question: Type.String({ description: "Question to ask the user." }),
  options: Type.Array(Type.String(), {
    description: "Pickable options to show for this question.",
    minItems: 1,
  }),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional image file paths shown as context above the options. Absolute, or relative to the working directory. PNG/JPEG/GIF/WebP. Rendered only in GUI hosts such as Swath; terminal sessions list the filenames instead.",
      maxItems: 32,
    }),
  ),
});

const askUserQuestionsSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    description: "One or more questions to ask the user, in order.",
    minItems: 1,
    maxItems: 20,
  }),
});

export type AskUserQuestionsInput = Static<typeof askUserQuestionsSchema>;

type Answer = {
  question: string;
  answer: string;
  type: "option" | "custom";
  optionIndex?: number;
};

type AskResult = { answers: Answer[]; cancelled: boolean };

/**
 * Sentinel handed to a GUI host through `ctx.ui.select`.
 *
 * pi's RPC dialog protocol only offers select/confirm/input/editor — `ctx.ui.custom` is
 * TUI-only — so there is no way to declare a real questionnaire method. A host that
 * understands the prefix (Swath) parses the payload out of the title, renders the whole
 * question set at once, and replies with a JSON `AskResult`. Any other RPC client just sees
 * a one-option select and echoes the fallback marker back, which drops us into the
 * sequential loop below.
 */
const SWATH_ASK_PREFIX = "SWATH_ASK_V1:";
const FALLBACK_MARKER = "__swath_ask_fallback__";

const CUSTOM_OPTION = "Custom response…";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_questions",
    label: "Ask User Questions",
    description:
      "Ask the user a series of questions. Each question has any number of pickable options plus a custom response choice, and may attach images shown as context.",
    promptSnippet:
      "Ask the user one or more multiple-choice questions, optionally with reference images, plus an optional custom response.",
    promptGuidelines: [
      "Use ask_user_questions when you need the user's preference, clarification, or choice before proceeding.",
      "For ask_user_questions, provide at least one clear option for each question.",
      "Attach `images` to a question when the choice is about something visual — screenshots, mockups, diagrams, or rendered output. The user sees them above the options.",
      "When the options correspond one-to-one with the images, list them in the same order and name them so the pairing is obvious.",
    ],
    parameters: askUserQuestionsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "ask_user_questions requires an interactive UI.",
            },
          ],
          details: { answers: [] },
        };
      }

      /** One question at a time; the only thing a generic RPC client can render. */
      async function askSequentially(): Promise<AskResult> {
        const answers: Answer[] = [];

        for (const [index, question] of params.questions.entries()) {
          const imageNote = question.images?.length
            ? ` [images: ${question.images.join(", ")}]`
            : "";
          const choice = await ctx.ui.select(
            `Question ${index + 1}/${params.questions.length}: ${question.question}${imageNote}`,
            [...question.options, CUSTOM_OPTION],
          );

          if (choice === undefined) return { answers, cancelled: true };

          if (choice === CUSTOM_OPTION) {
            const custom = await ctx.ui.input(
              "Custom answer:",
              "Type your answer",
            );
            if (custom === undefined) return { answers, cancelled: true };
            answers.push({
              question: question.question,
              answer: custom.trim() || "(no response)",
              type: "custom",
            });
          } else {
            answers.push({
              question: question.question,
              answer: choice,
              type: "option",
              optionIndex: question.options.indexOf(choice),
            });
          }
        }

        return { answers, cancelled: false };
      }

      /** Offers the whole question set to a GUI host, falling back when unrecognised. */
      async function askOverRpc(): Promise<AskResult> {
        const reply = await ctx.ui.select(
          SWATH_ASK_PREFIX + JSON.stringify({ questions: params.questions }),
          [FALLBACK_MARKER],
        );
        if (reply === undefined) return { answers: [], cancelled: true };
        if (reply === FALLBACK_MARKER) return askSequentially();

        const parsed = parseAskResult(reply);
        return parsed ?? askSequentially();
      }

      const result =
        ctx.mode === "rpc"
          ? await askOverRpc()
          : await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => {
              // `questionIndex === params.questions.length` is the review page: every answer
              // listed, nothing submitted until the user confirms there.
              const reviewIndex = params.questions.length;
              let questionIndex = 0;
              let optionIndex = 0;
              let inputMode = false;
              let cachedWidth: number | undefined;
              let cachedLines: string[] | undefined;
              const answers: (Answer | undefined)[] = [];

              const editorTheme: EditorTheme = {
                borderColor: (s) => theme.fg("accent", s),
                selectList: {
                  selectedPrefix: (t) => theme.fg("accent", t),
                  selectedText: (t) => theme.fg("accent", t),
                  description: (t) => theme.fg("muted", t),
                  scrollInfo: (t) => theme.fg("dim", t),
                  noMatch: (t) => theme.fg("warning", t),
                },
              };
              const editor = new Editor(tui, editorTheme);

              function refresh() {
                cachedWidth = undefined;
                cachedLines = undefined;
                tui.requestRender();
              }

              function submit(cancelled: boolean) {
                done({
                  answers: answers.filter(
                    (answer): answer is Answer => answer !== undefined,
                  ),
                  cancelled,
                });
              }

              function selectedAnswerIndex() {
                const answer = answers[questionIndex];
                if (!answer) return 0;
                return answer.type === "custom"
                  ? params.questions[questionIndex]!.options.length
                  : (answer.optionIndex ?? 0);
              }

              function moveToQuestion(nextIndex: number) {
                questionIndex = Math.max(0, Math.min(reviewIndex, nextIndex));
                inputMode = false;
                if (questionIndex === reviewIndex) {
                  optionIndex = 0;
                  editor.setText("");
                  refresh();
                  return;
                }
                optionIndex = selectedAnswerIndex();
                editor.setText(
                  answers[questionIndex]?.type === "custom"
                    ? answers[questionIndex]!.answer
                    : "",
                );
                refresh();
              }

              function saveAnswer(answer: Answer) {
                answers[questionIndex] = answer;
              }

              editor.onSubmit = (value) => {
                const item = params.questions[questionIndex]!;
                const custom = value.trim() || "(no response)";
                saveAnswer({
                  question: item.question,
                  answer: custom,
                  type: "custom",
                });
                inputMode = false;
                moveToQuestion(questionIndex + 1);
              };

              function handleInput(data: string) {
                if (inputMode) {
                  if (matchesKey(data, Key.escape)) {
                    inputMode = false;
                    refresh();
                    return;
                  }
                  editor.handleInput(data);
                  refresh();
                  return;
                }

                if (matchesKey(data, Key.escape)) {
                  submit(true);
                  return;
                }
                if (matchesKey(data, Key.left)) {
                  moveToQuestion(questionIndex - 1);
                  return;
                }

                if (questionIndex === reviewIndex) {
                  // Only Enter (submit) and ← (go back and edit) mean anything here.
                  if (matchesKey(data, Key.enter)) submit(false);
                  return;
                }

                const item = params.questions[questionIndex]!;
                const choices = [...item.options, CUSTOM_OPTION];

                if (matchesKey(data, Key.right)) {
                  moveToQuestion(questionIndex + 1);
                  return;
                }
                if (matchesKey(data, Key.up)) {
                  optionIndex = Math.max(0, optionIndex - 1);
                  refresh();
                  return;
                }
                if (matchesKey(data, Key.down)) {
                  optionIndex = Math.min(choices.length - 1, optionIndex + 1);
                  refresh();
                  return;
                }
                if (matchesKey(data, Key.enter)) {
                  const choice = choices[optionIndex]!;
                  if (optionIndex === item.options.length) {
                    inputMode = true;
                    editor.setText(
                      answers[questionIndex]?.type === "custom"
                        ? answers[questionIndex]!.answer
                        : "",
                    );
                    refresh();
                    return;
                  }
                  saveAnswer({
                    question: item.question,
                    answer: choice,
                    type: "option",
                    optionIndex,
                  });
                  moveToQuestion(questionIndex + 1);
                }
              }

              function renderReview(add: (s: string) => void, lines: string[]) {
                add(theme.fg("text", " Review your answers"));
                lines.push("");
                params.questions.forEach((item, i) => {
                  const answer = answers[i];
                  add(theme.fg("muted", ` ${i + 1}. ${item.question}`));
                  add(
                    answer
                      ? theme.fg("success", `    ${answer.answer}`)
                      : theme.fg("warning", "    (unanswered)"),
                  );
                });
                lines.push("");
                add(
                  theme.fg(
                    "dim",
                    " Enter submit • ← back to edit • Esc cancel",
                  ),
                );
              }

              function renderQuestion(
                add: (s: string) => void,
                lines: string[],
                width: number,
              ) {
                const item = params.questions[questionIndex]!;
                const choices = [...item.options, CUSTOM_OPTION];
                add(
                  theme.fg(
                    "text",
                    ` Question ${questionIndex + 1}/${params.questions.length}: ${item.question}`,
                  ),
                );
                if (item.images?.length) {
                  lines.push("");
                  // Terminals cannot show the images; name them so the user can open them.
                  add(theme.fg("muted", " Attached images:"));
                  for (const image of item.images)
                    add(theme.fg("dim", `   • ${image}`));
                }
                lines.push("");
                choices.forEach((choice, i) => {
                  const selected = i === optionIndex;
                  const current =
                    answers[questionIndex]?.type === "custom"
                      ? i === item.options.length
                      : answers[questionIndex]?.optionIndex === i;
                  const prefix = selected ? theme.fg("accent", "> ") : "  ";
                  const suffix = current ? theme.fg("success", " ✓") : "";
                  add(
                    prefix +
                      theme.fg(
                        selected ? "accent" : "text",
                        `${i + 1}. ${choice}`,
                      ) +
                      suffix,
                  );
                });
                if (inputMode) {
                  lines.push("");
                  add(theme.fg("muted", " Custom answer:"));
                  for (const line of editor.render(width - 2)) add(` ${line}`);
                }
                lines.push("");
                add(
                  theme.fg(
                    "dim",
                    " ←→ previous/next question • ↑↓ select • Enter answer • Esc cancel",
                  ),
                );
              }

              function render(nextWidth: number): string[] {
                if (cachedLines && cachedWidth === nextWidth) return cachedLines;
                const lines: string[] = [];
                const add = (s: string) =>
                  lines.push(...wrapTextWithAnsi(s, Math.max(1, nextWidth)));
                add(theme.fg("accent", "─".repeat(nextWidth)));
                if (questionIndex === reviewIndex) renderReview(add, lines);
                else renderQuestion(add, lines, nextWidth);
                add(theme.fg("accent", "─".repeat(nextWidth)));
                cachedWidth = nextWidth;
                cachedLines = lines;
                return lines;
              }

              return {
                render,
                invalidate: () => {
                  cachedWidth = undefined;
                  cachedLines = undefined;
                },
                handleInput,
              };
            });

      if (result.cancelled) {
        return {
          isError: true,
          content: [
            { type: "text", text: "User cancelled the question dialog." },
          ],
          details: { answers: result.answers, cancelled: true },
        };
      }

      const answers = result.answers;
      const text = answers
        .map(
          (answer, i) =>
            `${i + 1}. ${answer.question}\nAnswer: ${answer.answer}${answer.type === "custom" ? " (custom)" : ""}`,
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { answers },
      };
    },
  });
}

/** Validates a GUI host's JSON reply; returns null so callers can fall back on anything odd. */
function parseAskResult(reply: string): AskResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(reply);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { answers?: unknown; cancelled?: unknown };
  if (!Array.isArray(candidate.answers)) return null;

  const answers: Answer[] = [];
  for (const entry of candidate.answers) {
    if (typeof entry !== "object" || entry === null) return null;
    const value = entry as Record<string, unknown>;
    if (typeof value.question !== "string" || typeof value.answer !== "string")
      return null;
    const type = value.type === "custom" ? "custom" : "option";
    answers.push({
      question: value.question,
      answer: value.answer,
      type,
      ...(typeof value.optionIndex === "number"
        ? { optionIndex: value.optionIndex }
        : {}),
    });
  }
  return { answers, cancelled: candidate.cancelled === true };
}
