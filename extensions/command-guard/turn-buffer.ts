/**
 * Tracks the user's messages for the current agent run.
 *
 * A run is everything from a prompt until the agent settles, so it includes
 * steering messages delivered mid-run. Only user messages are kept: assistant
 * text and tool results are the channels through which injected instructions
 * arrive, and the authorization judge must never see them.
 */

export interface TurnBufferOptions {
	maxMessageChars?: number;
	maxTotalChars?: number;
}

export interface TurnBuffer {
	/** Feed every finished message; non-user messages are ignored */
	onMessage(message: unknown): void;
	/** The agent run ended; the next user message starts a new run */
	onAgentEnd(): void;
	/** User messages of the current (or most recent) run, oldest first */
	messages(): string[];
	reset(): void;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

export function createTurnBuffer(options: TurnBufferOptions = {}): TurnBuffer {
	// Generous on purpose: dropping the user's words only ever makes the authorization
	// judge more suspicious, but classifiers have large contexts and the action needs room too
	const maxMessageChars = options.maxMessageChars ?? 16_000;
	const maxTotalChars = options.maxTotalChars ?? 32_000;

	let idle = true;
	let collected: string[] = [];

	return {
		onMessage(message) {
			if (typeof message !== "object" || message === null) return;
			const m = message as { role?: unknown; content?: unknown };
			if (m.role !== "user") return;
			const text = textOf(m.content).trim();
			if (!text) return;

			if (idle) {
				collected = [];
				idle = false;
			}
			collected.push(
				text.length > maxMessageChars
					? `${text.slice(0, maxMessageChars)}\n[truncated ${text.length - maxMessageChars} chars]`
					: text,
			);
		},

		onAgentEnd() {
			idle = true;
		},

		messages() {
			let total = collected.reduce((n, m) => n + m.length, 0);
			if (total <= maxTotalChars || collected.length <= 1) return [...collected];

			// Keep the first message (the original request) and as many recent ones as fit
			const first = collected[0];
			total = first.length;
			const tail: string[] = [];
			for (let i = collected.length - 1; i > 0; i--) {
				if (total + collected[i].length > maxTotalChars) break;
				total += collected[i].length;
				tail.unshift(collected[i]);
			}
			return [first, ...tail];
		},

		reset() {
			idle = true;
			collected = [];
		},
	};
}
