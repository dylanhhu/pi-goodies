/**
 * Behavior of the assembled extension, driven through its real event handlers and commands.
 * Each case here pins a way the extension once misrouted a request, looped, or left the
 * user stuck.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, mock, test } from "node:test";
import {
	assistantEnd,
	chatBody,
	createHost,
	type EndpointFixture,
	type Host,
	MODEL_ID,
	stubOpenRouter,
} from "./harness.ts";

const KEY = `openrouter:${MODEL_ID}`;
const SHED_TEXT = "Flex capacity shed; continuing at standard rates";
const RATE_LIMIT = "429 Provider returned error: rate limit exceeded";

type Body = Record<string, unknown> & {
	provider?: Record<string, unknown>;
	service_tier?: string;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	mock.timers.reset();
});

function host(options?: Parameters<typeof createHost>[0]): Host {
	const created = createHost(options);
	cleanups.push(() => created.dispose());
	return created;
}

function stub(endpoints: EndpointFixture[], aliases: Record<string, string> = {}) {
	const stubbed = stubOpenRouter(endpoints, aliases);
	cleanups.push(stubbed.restore);
	return stubbed;
}

const pinOnly = (providers: string[], mode = "only", allowFallbacks = false) => ({
	pin: { providers, mode, allowFallbacks, updatedAt: 1 },
});
const flexAuto = { flex: { endpoint: null, updatedAt: 1 } };

async function plan(
	h: Host,
	body: Record<string, unknown> = chatBody(),
): Promise<Body | undefined> {
	return (await h.emit("before_provider_request", { payload: body })) as Body | undefined;
}

describe("pin-only requests are never treated as flex", () => {
	test("a 429 on a single pinned provider is an ordinary error, every time", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart"], "prefer", false) } });

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const request = await plan(h);
			assert.deepEqual(request?.provider, { order: ["decart"], allow_fallbacks: false });
			assert.equal(request?.service_tier, undefined);

			const end = await h.emit(
				"message_end",
				assistantEnd({ stopReason: "error", errorMessage: RATE_LIMIT }),
			);
			assert.equal(end, undefined, "the error is left for Pi's own retry and backoff");
			assert.equal(await h.emit("agent_before_settle", { entries: [] }), undefined);
		}
		assert.doesNotMatch(h.notified(), /flex/i);
	});

	test("the same holds for an `only` pin with several providers", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart", "wafer"]) } });
		await plan(h);
		const end = await h.emit(
			"message_end",
			assistantEnd({ stopReason: "error", errorMessage: "503 capacity overloaded" }),
		);
		assert.equal(end, undefined);
	});
});

describe("flex shed", () => {
	function shedEntry(h: Host, errorMessage = SHED_TEXT) {
		h.entries = [
			{
				type: "message",
				id: "failed",
				message: { role: "assistant", stopReason: "error", errorMessage },
			},
		];
	}

	test("a rate-limited flex request is relabelled, continued once, and then served standard", async () => {
		const h = host();
		h.writeState({ version: 1, fallback: "openrouter", models: { [KEY]: flexAuto } });

		const flex = await plan(h);
		assert.equal(flex?.service_tier, "flex");

		const end = (await h.emit(
			"message_end",
			assistantEnd({ stopReason: "error", errorMessage: RATE_LIMIT }),
		)) as { message: { errorMessage: string } };
		assert.equal(end.message.errorMessage, SHED_TEXT);

		shedEntry(h);
		const settle = (await h.emit("agent_before_settle", { entries: [] })) as {
			continue: boolean;
			entries: { targetId: string; replacement: unknown }[];
		};
		assert.equal(settle.continue, true);
		assert.deepEqual(settle.entries[0], {
			type: "context_edit",
			targetId: "failed",
			replacement: null,
		});

		const next = await plan(h);
		assert.equal(next?.service_tier, undefined, "no flex tier during the cooldown");
	});

	test("repeated sheds stop continuing by hand and defer to Pi's bounded retry", async () => {
		mock.timers.enable({ apis: ["Date"], now: Date.now() });
		const h = host();
		h.writeState({ version: 1, fallback: "openrouter", models: { [KEY]: flexAuto } });

		const rewritten: boolean[] = [];
		for (let round = 0; round < 4; round += 1) {
			const request = await plan(h);
			assert.equal(
				request?.service_tier,
				"flex",
				`round ${round} sends flex again after the cooldown`,
			);
			const end = await h.emit(
				"message_end",
				assistantEnd({ stopReason: "error", errorMessage: RATE_LIMIT }),
			);
			rewritten.push(end !== undefined);
			// The cooldown is set either way, so Pi's retry goes out at standard rates.
			assert.equal((await plan(h))?.service_tier, undefined);
			mock.timers.tick(61_000);
		}
		assert.deepEqual(rewritten, [true, true, false, false]);
		assert.match(h.notified(), /leaving the retry to Pi's backoff/);
	});

	test("/flex off while a flex request is in flight cancels the shed", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: flexAuto } });
		assert.equal((await plan(h))?.service_tier, "flex");

		await h.command("flex", "off");
		const end = await h.emit(
			"message_end",
			assistantEnd({ stopReason: "error", errorMessage: RATE_LIMIT }),
		);
		assert.equal(end, undefined);
		assert.equal(await h.emit("agent_before_settle", { entries: [] }), undefined);
		assert.equal((await plan(h))?.service_tier, undefined);
	});

	test("a non-capacity error on a flex request is left alone", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: flexAuto } });
		await plan(h);
		const end = await h.emit(
			"message_end",
			assistantEnd({ stopReason: "error", errorMessage: "401 invalid api key" }),
		);
		assert.equal(end, undefined);
	});

	test("a shed never routes outside a strict pin", async () => {
		stub([
			{
				tag: "wafer/fp8/flex",
				service_tier: "flex",
				pricing: { prompt: "0.05", completion: "0.1" },
			},
			{ tag: "wafer/fp8", pricing: { prompt: "0.2", completion: "0.4" } },
			{ tag: "decart/fp8", pricing: { prompt: "0.3", completion: "0.6" } },
		]);
		const h = host();
		h.writeState({
			version: 1,
			models: { [KEY]: { ...flexAuto, ...pinOnly(["decart"], "prefer", false) } },
		});

		await plan(h);
		await h.emit("message_end", assistantEnd({ stopReason: "error", errorMessage: RATE_LIMIT }));
		const shed = await plan(h);
		assert.deepEqual(shed?.provider, { order: ["decart"], allow_fallbacks: false });
	});

	test("the shed lookup cannot hold up the message past its timeout", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
		cleanups.push(() => {
			globalThis.fetch = original;
		});
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: flexAuto } });
		await plan(h);

		const started = Date.now();
		const end = await h.emit(
			"message_end",
			assistantEnd({ stopReason: "error", errorMessage: RATE_LIMIT }),
		);
		assert.ok(end, "still shed");
		assert.ok(Date.now() - started < 8_000, "bounded by the lookup timeout, not the 15s fetch");
	});
});

describe("request planning", () => {
	test("an explicit service_tier keeps its value but the pin still applies", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: { ...flexAuto, ...pinOnly(["decart"]) } } });
		const request = await plan(h, chatBody(MODEL_ID, { service_tier: "auto" }));
		assert.equal(request?.service_tier, "auto");
		assert.deepEqual(request?.provider, {
			only: ["decart"],
			order: ["decart"],
			allow_fallbacks: false,
		});
	});

	test("a request for another model is not routed by the selected model's binding", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart"]) } });
		assert.equal(await plan(h, chatBody("anthropic/some-other-model")), undefined);
	});

	test("stale provider.only and order never leak through, other routing keys survive", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart"]) } });
		const request = await plan(
			h,
			chatBody(MODEL_ID, { provider: { only: ["x"], order: ["y"], sort: "price" } }),
		);
		assert.deepEqual(request?.provider, {
			only: ["decart"],
			order: ["decart"],
			allow_fallbacks: false,
			sort: "price",
		});
	});

	test("a body the extension cannot route warns once instead of failing open silently", async () => {
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart"]) } });
		const responses = { model: MODEL_ID, input: [{ role: "user", content: "hi" }] };
		assert.equal(await plan(h, responses), undefined);
		assert.equal(await plan(h, responses), undefined);
		const warnings = h.notifications.filter((entry) => /NOT being applied/.test(entry.message));
		assert.equal(warnings.length, 1);
	});

	test("an unconfigured model is left untouched", async () => {
		const h = host();
		assert.equal(await plan(h), undefined);
	});

	test("a model on another provider is left untouched", async () => {
		const h = host({ model: { provider: "anthropic", id: MODEL_ID } });
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart"]) } });
		assert.equal(await plan(h), undefined);
	});

	test("flex pricing still corrects the cost of a response that took many minutes", async () => {
		mock.timers.enable({ apis: ["Date"], now: Date.now() });
		const h = host();
		h.writeState({
			version: 1,
			models: {
				[KEY]: {
					flex: {
						endpoint: "deepinfra/fp8/flex",
						pricing: { prompt: "0.000001", completion: "0.000002" },
						updatedAt: 1,
					},
				},
			},
		});
		await plan(h);
		mock.timers.tick(10 * 60_000);
		const end = (await h.emit("message_end", assistantEnd())) as {
			message: { usage: { cost: { total: number } } };
		};
		assert.equal(end.message.usage.cost.total, 0.0012);
	});
});

describe("the extension cannot break a request or the session", () => {
	test("an exception in a handler is contained and reported once", async () => {
		const h = host();
		Object.defineProperty(h.ctx, "model", {
			get() {
				throw new Error("boom");
			},
		});
		assert.equal(await plan(h), undefined);
		assert.equal(await plan(h), undefined);
		const reports = () => h.notifications.filter((entry) => /extension error/.test(entry.message));
		assert.equal(reports().length, 1, "once, not once per request");

		// A fault while handling a response is contained the same way.
		const hostile = {
			get message(): never {
				throw new Error("bad message");
			},
		};
		assert.equal(await h.emit("message_end", hostile), undefined);
		assert.equal(reports().length, 2);
	});

	test("a corrupt state file is reported, left in place, and never replaced by legacy settings", async () => {
		const h = host();
		h.writeRaw(
			"flex.json",
			JSON.stringify({ models: { [KEY]: { endpoint: "deepinfra/fp8/flex" } } }),
		);
		h.writeRaw("openrouter.json", "{ nope");
		await h.emit("session_start", {});

		assert.match(h.notified(), /openrouter\.json is invalid/);
		assert.equal(readFileSync(join(h.agentDir, "openrouter.json"), "utf8"), "{ nope");
		assert.ok(readdirSync(h.agentDir).some((name) => name.startsWith("openrouter.json.invalid-")));
		const request = await plan(h);
		assert.equal(request?.service_tier, undefined, "legacy flex was not resurrected");
	});

	test("a missing state file with no legacy files is simply empty", async () => {
		const h = host();
		await h.emit("session_start", {});
		assert.equal(h.notifications.length, 0);
		assert.equal(await plan(h), undefined);
		assert.equal(existsSync(join(h.agentDir, "openrouter.json")), false);
	});

	test("a state file that cannot be saved is reported and the change still applies", async (t) => {
		if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: flexAuto } });
		chmodSync(h.agentDir, 0o500);
		// Runs before the host's own cleanup, which needs to delete the directory.
		cleanups.unshift(() => chmodSync(h.agentDir, 0o700));
		await h.command("flex", "off");
		const failure = h.notifications.find((entry) => /Could not save/.test(entry.message));
		assert.equal(failure?.level, "error");
		assert.equal((await plan(h))?.service_tier, undefined, "flex is off for this session");
	});
});

describe("/flex and /pin consistency", () => {
	const endpoints: EndpointFixture[] = [
		{
			tag: "deepinfra/fp8/flex",
			service_tier: "flex",
			pricing: { prompt: "0.1", completion: "0.2" },
		},
		{ tag: "deepinfra/fp8", pricing: { prompt: "0.2", completion: "0.4" } },
		{ tag: "decart/fp8", pricing: { prompt: "0.3", completion: "0.6" } },
	];
	const savedFlex = (h: Host) =>
		JSON.parse(readFileSync(join(h.agentDir, "openrouter.json"), "utf8")).models[KEY]?.flex;

	test("subcommands are case-insensitive", async () => {
		stub(endpoints);
		const h = host();
		await h.command("flex", "ON");
		assert.equal(savedFlex(h).endpoint, null);
		await h.command("flex", "Off");
		assert.equal(existsSync(join(h.agentDir, "openrouter.json")), true);
		assert.equal(savedFlex(h), undefined);
	});

	test("flex auto is refused when the pin names a provider with no flex endpoint", async () => {
		stub(endpoints);
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart"]) } });
		await h.command("flex", "on");
		assert.match(h.notified(), /would break the pin/);
		assert.equal(savedFlex(h), undefined);
		assert.equal((await plan(h))?.service_tier, undefined);
	});

	test("the interactive picker enforces the same rule as /flex on", async () => {
		stub(endpoints);
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["decart"]) } });
		h.selectIndex = 0; // "flex auto" is the first option
		await h.command("flex", "");
		assert.match(h.notified(), /would break the pin/);
		assert.equal(savedFlex(h), undefined);
	});

	test("flex auto is accepted when the pin can honor it", async () => {
		stub(endpoints);
		const h = host();
		h.writeState({ version: 1, models: { [KEY]: pinOnly(["deepinfra"]) } });
		await h.command("flex", "on");
		assert.equal(savedFlex(h).endpoint, null);
		const request = await plan(h);
		assert.equal(request?.service_tier, "flex");
		assert.deepEqual(request?.provider, {
			only: ["deepinfra"],
			order: ["deepinfra"],
			allow_fallbacks: false,
		});
	});

	test("a pin whose first word looks like a keyword is still a provider slug", async () => {
		stub([{ tag: "temp-ai/fp8", pricing: { prompt: "0.1" } }]);
		const h = host();
		await h.command("pin", "temp-ai");
		const saved = JSON.parse(readFileSync(join(h.agentDir, "openrouter.json"), "utf8"));
		assert.deepEqual(saved.models[KEY].pin.providers, ["temp-ai"]);
	});
});
