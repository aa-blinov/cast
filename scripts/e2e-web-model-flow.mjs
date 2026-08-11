import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const repo = resolve(new URL("..", import.meta.url).pathname);
const fakeModels = {
	"primary-key": [
		{
			id: "alpha-model",
			owned_by: "e2e",
			reasoning: {
				mandatory: false,
				default_enabled: true,
				supported_efforts: ["low", "high"],
				default_effort: "high",
			},
		},
	],
	"secondary-key": [
		{
			id: "beta-model",
			owned_by: "e2e",
			reasoning: {
				mandatory: false,
				default_enabled: true,
				supported_efforts: ["low"],
				default_effort: "low",
			},
		},
	],
};

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function waitForOutput(child, pattern) {
	return new Promise((resolvePromise, reject) => {
		let output = "";
		const onData = (chunk) => {
			output += chunk.toString();
			const match = output.match(pattern);
			if (match) {
				child.stdout.off("data", onData);
				resolvePromise(match);
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.once("exit", (code) => reject(new Error(`cast web exited before startup (${code})\n${output}`)));
	});
}

async function expectValue(locator, expected, label) {
	await locator.waitFor({ state: "visible" });
	const actual = await locator.inputValue();
	assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

async function waitForValue(locator, expected, label) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if ((await locator.inputValue()) === expected) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error(`${label}: timed out waiting for ${expected}; got ${await locator.inputValue()}`);
}

async function expectOption(locator, optionValue, label) {
	await locator.waitFor({ state: "visible" });
	await locator.locator(`option[value="${optionValue}"]`).waitFor({ state: "attached" });
	const values = await locator.locator("option").evaluateAll((options) => options.map((option) => option.value));
	assert(values.includes(optionValue), `${label}: ${optionValue} not found in ${values.join(", ")}`);
}

function playwrightExecutable() {
	if (process.env.CAST_PLAYWRIGHT_EXECUTABLE) return process.env.CAST_PLAYWRIGHT_EXECUTABLE;
	if (process.platform === "linux") {
		const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
		try {
			const shell = readdirSync(browserRoot)
				.filter((entry) => entry.startsWith("chromium_headless_shell-"))
				.sort()
				.reverse()
				.map((entry) => join(browserRoot, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"))
				.find((candidate) => existsSync(candidate));
			if (shell) return shell;
		} catch {
			// Fall back to Playwright's regular Chromium binary below.
		}
	}
	return chromium.executablePath();
}

const provider = createServer(async (req, res) => {
	const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
	if (key !== "primary-key" && key !== "secondary-key") {
		json(res, 401, { error: { message: "invalid test key" } });
		return;
	}
	if (req.method === "GET" && req.url === "/v1/models") {
		json(res, 200, { object: "list", data: fakeModels[key] });
		return;
	}
	if (req.method === "POST" && req.url === "/v1/chat/completions") {
		let requestBody = "";
		for await (const chunk of req) requestBody += chunk;
		const request = JSON.parse(requestBody);
		if (request.stream) {
			res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
			res.write(
				`data: ${JSON.stringify({
					id: "e2e-completion",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "e2e-completion",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		} else {
			json(res, 200, {
				id: "e2e-completion",
				object: "chat.completion",
				choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		return;
	}
	json(res, 404, { error: { message: "not found" } });
});

let home;
let cast;
let browser;
try {
	await new Promise((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
	const providerPort = provider.address().port;
	const providerUrl = `http://127.0.0.1:${providerPort}/v1`;
	home = await mkdtemp(join(tmpdir(), "cast-web-model-e2e-"));
	await mkdir(join(home, ".cast"), { recursive: true });
	await mkdir(join(home, ".cast", "cache"), { recursive: true });
	await writeFile(join(home, ".cast", "cache", "models-dev.json"), "{}");
	await writeFile(
		join(home, ".cast", "settings.json"),
		JSON.stringify(
			{
				model: "alpha-model",
				modelProvider: "primary",
				providerUrl,
				apiKey: "primary-key",
				reasoningLevel: "high",
				persona: "senior",
				serverToken: "e2e-password",
				providers: [
					{ name: "primary", url: providerUrl, apiKey: "primary-key", reasoningFormat: "openai-compatible" },
					{ name: "secondary", url: providerUrl, apiKey: "secondary-key", reasoningFormat: "generic" },
				],
			},
			null,
			2,
		),
	);

	cast = spawn(process.execPath, ["--import", "tsx", "./src/server/index.ts", "--port", "0"], {
		cwd: repo,
		env: { ...process.env, HOME: home, CAST_CWD: home, CAST_VERSION: "e2e" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const listening = await waitForOutput(cast, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
	const port = Number(listening[1]);
	browser = await chromium.launch({
		headless: true,
		executablePath: playwrightExecutable(),
		args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
	});
	const page = await browser.newPage();
	page.setDefaultTimeout(60_000);
	await page.goto(`http://127.0.0.1:${port}/login`);
	await page.getByLabel("Username").fill("cast");
	await page.getByLabel("Password").fill("e2e-password");
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.waitForURL(`http://127.0.0.1:${port}/`);

	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Model", exact: true }).click();

	const modal = page.getByRole("dialog", { name: "Settings" });
	const selects = modal.locator("select");
	const mainProvider = selects.nth(0);
	const mainModel = selects.nth(1);
	const reasoning = selects.nth(2);
	const mainApply = modal.locator('button[title="Apply"]').nth(0);

	await waitForValue(mainProvider, "primary", "initial provider");
	await waitForValue(mainModel, "alpha-model", "initial model");
	await waitForValue(reasoning, "high", "initial reasoning");

	// A provider change is a draft until the user picks a model and applies it.
	await mainProvider.selectOption("secondary");
	await expectOption(mainModel, "beta-model", "secondary models");
	assert.equal(await mainModel.inputValue(), "", "changing provider clears the draft model");
	await modal.getByRole("button", { name: "Close" }).click();
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Model", exact: true }).click();
	await expectValue(modal.locator("select").nth(0), "primary", "cancelled provider change");
	await expectValue(modal.locator("select").nth(1), "alpha-model", "cancelled model change");

	// Applying provider + model is one transition; the unsupported old level is
	// replaced by the selected model's independent default.
	await modal.locator("select").nth(0).selectOption("secondary");
	await expectOption(modal.locator("select").nth(1), "beta-model", "secondary models after reopen");
	await modal.locator("select").nth(1).selectOption("beta-model");
	await mainApply.click();
	await waitForValue(modal.locator("select").nth(0), "secondary", "applied provider");
	await waitForValue(modal.locator("select").nth(1), "beta-model", "applied model");
	await waitForValue(modal.locator("select").nth(2), "low", "model default reasoning");

	// Reasoning is independently editable and returns to the saved value after
	// Apply; the button is disabled again, so the UI exposes no stale draft.
	await modal.locator("select").nth(2).selectOption("off");
	const reasoningApply = modal.locator('button[title="Apply reasoning"]');
	assert.equal(await reasoningApply.isDisabled(), false, "reasoning Apply enables for a changed value");
	await reasoningApply.click();
	await waitForValue(modal.locator("select").nth(2), "off", "applied reasoning");
	assert.equal(await reasoningApply.isDisabled(), true, "reasoning Apply resets after save");

	// Selecting another model clears a pending reasoning draft; it cannot leak
	// into the next model's reasoning state.
	await modal.locator("select").nth(2).selectOption("low");
	await modal.locator("select").nth(0).selectOption("primary");
	await modal.locator("select").nth(1).selectOption("alpha-model");
	await mainApply.click();
	await waitForValue(modal.locator("select").nth(0), "primary", "second provider apply");
	await waitForValue(modal.locator("select").nth(1), "alpha-model", "second model apply");
	await waitForValue(modal.locator("select").nth(2), "off", "saved reasoning after stale draft reset");

	// A full browser reload must reconstruct the same saved state, not just the
	// in-memory settings modal state.
	await page.reload();
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Model", exact: true }).click();
	const reloadedSelects = page.getByRole("dialog", { name: "Settings" }).locator("select");
	await waitForValue(reloadedSelects.nth(0), "primary", "reloaded provider");
	await waitForValue(reloadedSelects.nth(1), "alpha-model", "reloaded model");
	await waitForValue(reloadedSelects.nth(2), "off", "reloaded reasoning");
	await page.close();

	// The first message in a local draft must wait for the active SSE stream.
	// This used to race the stream and could leave the reply visible only after
	// a manual reload; the fake provider responds immediately to make that
	// window deterministic. Use a fresh page so this scenario cannot inherit
	// the already-open session stream from the model-settings flow above.
	const chatPage = await browser.newPage();
	chatPage.setDefaultTimeout(60_000);
	let activeSseReleasedAt = 0;
	let chatSentAt = 0;
	await chatPage.route("**/api/sessions/*/events", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (/^\/api\/sessions\/[^/]+\/events$/.test(pathname) && activeSseReleasedAt === 0) {
			// Reproduce the real-world window where the browser has created the
			// session but the active EventSource is still negotiating.
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
			activeSseReleasedAt = Date.now();
		}
		await route.continue();
	});
	chatPage.on("request", (request) => {
		if (new URL(request.url()).pathname.endsWith("/chat")) chatSentAt = Date.now();
	});
	await chatPage.goto(`http://127.0.0.1:${port}/login`);
	if (new URL(chatPage.url()).pathname === "/login") {
		await chatPage.getByLabel("Username").fill("cast");
		await chatPage.getByLabel("Password").fill("e2e-password");
		await chatPage.getByRole("button", { name: "Sign in" }).click();
	}
	await chatPage.waitForURL(`http://127.0.0.1:${port}/`);
	const composer = chatPage.locator("textarea");
	await composer.waitFor({ state: "visible" });
	await chatPage.waitForFunction(() => {
		const textarea = document.querySelector("textarea");
		return textarea instanceof HTMLTextAreaElement && !textarea.disabled;
	});
	await composer.fill("first message");
	await composer.press("Enter");
	await chatPage.getByText("ok", { exact: true }).waitFor({ state: "visible" });
	assert(activeSseReleasedAt > 0, "active session SSE was never opened");
	assert(chatSentAt >= activeSseReleasedAt, "chat POST raced ahead of the active SSE connection");

	console.log("PASS: browser provider/model/reasoning flow");
} finally {
	if (browser) await browser.close();
	if (cast) {
		cast.kill("SIGTERM");
		await new Promise((resolvePromise) => cast.once("exit", resolvePromise));
	}
	await new Promise((resolvePromise) => provider.close(resolvePromise));
	if (home) await rm(home, { recursive: true, force: true });
}
