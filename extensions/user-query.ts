import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const questionSchema = Type.Object({
	question: Type.String({ description: "Question to ask the user." }),
	options: Type.Array(Type.String(), {
		description: "Pickable options to show for this question.",
		minItems: 1,
	}),
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_questions",
		label: "Ask User Questions",
		description: "Ask the user a series of questions. Each question has any number of pickable options plus a custom response choice.",
		promptSnippet: "Ask the user one or more multiple-choice questions with an optional custom response.",
		promptGuidelines: [
			"Use ask_user_questions when you need the user's preference, clarification, or choice before proceeding.",
			"For ask_user_questions, provide at least one clear option for each question.",
		],
		parameters: askUserQuestionsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					isError: true,
					content: [{ type: "text", text: "ask_user_questions requires an interactive UI." }],
					details: { answers: [] },
				};
			}

			const result = await ctx.ui.custom<{ answers: Answer[]; cancelled: boolean }>((tui, theme, _kb, done) => {
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
					done({ answers: answers.filter((answer): answer is Answer => answer !== undefined), cancelled });
				}

				function selectedAnswerIndex() {
					const answer = answers[questionIndex];
					if (!answer) return 0;
					return answer.type === "custom" ? params.questions[questionIndex]!.options.length : (answer.optionIndex ?? 0);
				}

				function moveToQuestion(nextIndex: number) {
					questionIndex = Math.max(0, Math.min(params.questions.length - 1, nextIndex));
					optionIndex = selectedAnswerIndex();
					inputMode = false;
					editor.setText(answers[questionIndex]?.type === "custom" ? answers[questionIndex]!.answer : "");
					refresh();
				}

				function saveAnswer(answer: Answer) {
					answers[questionIndex] = answer;
				}

				editor.onSubmit = (value) => {
					const item = params.questions[questionIndex]!;
					const custom = value.trim() || "(no response)";
					saveAnswer({ question: item.question, answer: custom, type: "custom" });
					inputMode = false;
					if (questionIndex === params.questions.length - 1) submit(false);
					else moveToQuestion(questionIndex + 1);
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

					const item = params.questions[questionIndex]!;
					const choices = [...item.options, "Custom response…"];

					if (matchesKey(data, Key.left)) {
						moveToQuestion(questionIndex - 1);
						return;
					}
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
					if (matchesKey(data, Key.escape)) {
						submit(true);
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const choice = choices[optionIndex]!;
						if (optionIndex === item.options.length) {
							inputMode = true;
							editor.setText(answers[questionIndex]?.type === "custom" ? answers[questionIndex]!.answer : "");
							refresh();
							return;
						}
						saveAnswer({ question: item.question, answer: choice, type: "option", optionIndex });
						if (questionIndex === params.questions.length - 1) submit(false);
						else moveToQuestion(questionIndex + 1);
					}
				}

				function render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					const item = params.questions[questionIndex]!;
					const choices = [...item.options, "Custom response…"];
					const lines: string[] = [];
					const add = (s: string) => lines.push(...wrapTextWithAnsi(s, Math.max(1, width)));
					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("text", ` Question ${questionIndex + 1}/${params.questions.length}: ${item.question}`));
					lines.push("");
					choices.forEach((choice, i) => {
						const selected = i === optionIndex;
						const current = answers[questionIndex]?.type === "custom" ? i === item.options.length : answers[questionIndex]?.optionIndex === i;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";
						const suffix = current ? theme.fg("success", " ✓") : "";
						add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${choice}`) + suffix);
					});
					if (inputMode) {
						lines.push("");
						add(theme.fg("muted", " Custom answer:"));
						for (const line of editor.render(width - 2)) add(` ${line}`);
					}
					lines.push("");
					add(theme.fg("dim", " ←→ previous/next question • ↑↓ select • Enter answer/submit last • Esc cancel"));
					add(theme.fg("accent", "─".repeat(width)));
					cachedWidth = width;
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
					content: [{ type: "text", text: "User cancelled the question dialog." }],
					details: { answers: result.answers, cancelled: true },
				};
			}

			const answers = result.answers;
			const text = answers
				.map((answer, i) => `${i + 1}. ${answer.question}\nAnswer: ${answer.answer}${answer.type === "custom" ? " (custom)" : ""}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { answers },
			};
		},
	});
}
