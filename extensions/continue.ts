import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function continueExtension(pi: ExtensionAPI): void {
	pi.registerCommand("continue", {
		description: "Restart the agent loop without sending a user message",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is already running.", "info");
				return;
			}

			pi.sendMessage({
				customType: "continue-command",
				content: "Continue from where you left off. If the previous agent loop stopped due to an error or interruption, resume the normal agent loop and proceed with the next appropriate step.",
				display: false,
			}, {
				triggerTurn: true,
				deliverAs: "followUp",
			});
		},
	});
}
