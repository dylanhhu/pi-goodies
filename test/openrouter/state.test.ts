import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	clearStateCache,
	clearTurnMixCache,
	loadState,
	peekTurnMix,
	resolveTurnMix,
	setFlexBinding,
	setPinBinding,
	stateHealth,
} from "../../extensions/openrouter/state.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-openrouter-state-"));
	clearStateCache();
	clearTurnMixCache();
});

afterEach(() => {
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Already removed.
	}
	rmSync(dir, { recursive: true });
	clearStateCache();
});

const file = (name: string): string => join(dir, name);
const stateFile = (): string => file("openrouter.json");

const LEGACY_FLEX = JSON.stringify({
	models: { "openrouter:legacy/model": { endpoint: "deepinfra/fp8/flex" } },
});
const LEGACY_PIN = JSON.stringify({
	models: { "openrouter:legacy/model": { providers: ["a", "b"], mode: "prefer" } },
});

describe("legacy migration", () => {
	test("imports legacy files only when the unified file is absent, then persists", () => {
		writeFileSync(file("flex.json"), LEGACY_FLEX);
		writeFileSync(file("openrouter-pin.json"), LEGACY_PIN);
		const state = loadState(dir);
		assert.equal(state.models["openrouter:legacy/model"]?.flex?.endpoint, "deepinfra/fp8/flex");
		assert.deepEqual(state.models["openrouter:legacy/model"]?.pin?.providers, ["a", "b"]);
		assert.equal(JSON.parse(readFileSync(stateFile(), "utf8")).version, 1);
	});

	test("a corrupt unified file is not treated as absent and is never overwritten", () => {
		writeFileSync(file("flex.json"), LEGACY_FLEX);
		writeFileSync(file("openrouter-pin.json"), LEGACY_PIN);
		writeFileSync(stateFile(), '{"version":1,"models":{');
		const state = loadState(dir);
		assert.deepEqual(state.models, {});
		assert.equal(readFileSync(stateFile(), "utf8"), '{"version":1,"models":{');
		const health = stateHealth(dir);
		assert.equal(health?.problem, "invalid");
		assert.equal(health?.usingLastGood, false);
		assert.ok(
			health?.backupPath && readFileSync(health.backupPath, "utf8").startsWith('{"version"'),
		);
	});

	test("a state file that turns invalid keeps the last good state in force", () => {
		setPinBinding(dir, "openrouter:m", {
			providers: ["decart"],
			mode: "only",
			allowFallbacks: false,
			updatedAt: 1,
		});
		assert.deepEqual(loadState(dir).models["openrouter:m"]?.pin?.providers, ["decart"]);
		writeFileSync(stateFile(), "{ not json");
		assert.deepEqual(loadState(dir).models["openrouter:m"]?.pin?.providers, ["decart"]);
		assert.equal(stateHealth(dir)?.usingLastGood, true);
	});

	test("a top-level non-object is invalid, not empty", () => {
		writeFileSync(stateFile(), "[]");
		loadState(dir);
		assert.equal(stateHealth(dir)?.problem, "invalid");
	});
});

describe("binding validation", () => {
	test("a flex entry must name an endpoint or say null; anything else is dropped", () => {
		writeFileSync(
			stateFile(),
			JSON.stringify({
				version: 1,
				models: {
					"openrouter:empty": { flex: {} },
					"openrouter:number": { flex: { endpoint: 3 } },
					"openrouter:blank": { flex: { endpoint: "  " } },
					"openrouter:auto": { flex: { endpoint: null } },
					"openrouter:named": { flex: { endpoint: "x/flex" } },
				},
			}),
		);
		const models = loadState(dir).models;
		assert.equal(models["openrouter:empty"], undefined);
		assert.equal(models["openrouter:number"], undefined);
		assert.equal(models["openrouter:blank"], undefined);
		assert.equal(models["openrouter:auto"]?.flex?.endpoint, null);
		assert.equal(models["openrouter:named"]?.flex?.endpoint, "x/flex");
	});

	test("pins are normalised and an `only` pin can never allow fallbacks", () => {
		writeFileSync(
			stateFile(),
			JSON.stringify({
				version: 1,
				models: {
					"openrouter:m": {
						pin: { providers: [" Decart ", "decart", "", 7], mode: "only", allowFallbacks: true },
					},
					"openrouter:empty": { pin: { providers: ["", 1] } },
				},
			}),
		);
		const models = loadState(dir).models;
		assert.deepEqual(models["openrouter:m"]?.pin?.providers, ["decart"]);
		assert.equal(models["openrouter:m"]?.pin?.allowFallbacks, false);
		assert.equal(models["openrouter:empty"], undefined);
	});
});

describe("writes", () => {
	test("are atomic: no temp files are left and the file is complete JSON", () => {
		for (let index = 0; index < 20; index += 1) {
			setFlexBinding(dir, `openrouter:m${index}`, { endpoint: null, updatedAt: index });
		}
		assert.deepEqual(
			readdirSync(dir).filter((name) => name.includes(".tmp")),
			[],
		);
		const parsed = JSON.parse(readFileSync(stateFile(), "utf8"));
		assert.equal(Object.keys(parsed.models).length, 20);
	});

	test("start from the file on disk, so another process's change is not lost", () => {
		setFlexBinding(dir, "openrouter:a", { endpoint: null, updatedAt: 1 });
		loadState(dir);
		// A second Pi session writes a different model while this one holds a cached copy.
		writeFileSync(
			stateFile(),
			JSON.stringify({
				version: 1,
				models: {
					"openrouter:a": { flex: { endpoint: null } },
					"openrouter:b": {
						pin: { providers: ["wafer"], mode: "only", allowFallbacks: false },
					},
				},
			}),
		);
		// Force a distinct mtime even on coarse clocks.
		const future = new Date(Date.now() + 5_000);
		utimesSync(stateFile(), future, future);

		setFlexBinding(dir, "openrouter:a", null);
		const models = JSON.parse(readFileSync(stateFile(), "utf8")).models;
		assert.equal(models["openrouter:a"], undefined);
		assert.deepEqual(models["openrouter:b"].pin.providers, ["wafer"]);
	});

	test("reload when the file changes on disk, including hand edits", () => {
		setFlexBinding(dir, "openrouter:a", { endpoint: null, updatedAt: 1 });
		assert.ok(loadState(dir).models["openrouter:a"]);
		writeFileSync(stateFile(), JSON.stringify({ version: 1, models: {} }));
		const future = new Date(Date.now() + 5_000);
		utimesSync(stateFile(), future, future);
		assert.equal(loadState(dir).models["openrouter:a"], undefined);
	});

	test("a failed write is returned and the session still follows the change", (t) => {
		if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
		setFlexBinding(dir, "openrouter:a", { endpoint: null, updatedAt: 1 });
		chmodSync(dir, 0o500);
		const error = setFlexBinding(dir, "openrouter:a", null);
		assert.ok(error, "the write error is reported");
		assert.equal(loadState(dir).models["openrouter:a"], undefined);
		assert.equal(
			JSON.parse(readFileSync(stateFile(), "utf8")).models["openrouter:a"] !== undefined,
			true,
		);
	});
});

describe("turn mix", () => {
	test("peek needs no scan once an override exists", () => {
		writeFileSync(
			stateFile(),
			JSON.stringify({
				version: 1,
				models: {},
				turnMix: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 },
			}),
		);
		assert.deepEqual(peekTurnMix(dir)?.mix, { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
	});

	test("without history it resolves to the default, caches it, and never blocks", async () => {
		assert.equal(peekTurnMix(dir), undefined);
		const first = await resolveTurnMix(dir);
		assert.equal(first.source, "built-in default");
		assert.equal(peekTurnMix(dir)?.source, "built-in default");
	});
});
