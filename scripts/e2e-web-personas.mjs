import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const repo = resolve(new URL("..", import.meta.url).pathname);

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

const provider = createServer((req, res) => {
	if (req.method === "GET" && req.url === "/v1/models") {
		json(res, 200, { object: "list", data: [{ id: "e2e-model", owned_by: "e2e" }] });
		return;
	}
	if (req.method === "POST" && req.url === "/v1/chat/completions") {
		json(res, 200, {
			id: "e2e-completion",
			object: "chat.completion",
			choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
		});
		return;
	}
	json(res, 404, { error: { message: "not found" } });
});

let home;
let cast;
let browser;
try {
	await new Promise((resolvePromise) => provider.listen(0, "127.0.0.1", resolvePromise));
	const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
	home = await mkdtemp(join(tmpdir(), "cast-settings-personas-e2e-"));
	await mkdir(join(home, ".cast", "cache"), { recursive: true });
	await writeFile(join(home, ".cast", "cache", "models-dev.json"), "{}");
	await writeFile(
		join(home, ".cast", "settings.json"),
		JSON.stringify({
			model: "e2e-model",
			modelProvider: "primary",
			providerUrl,
			apiKey: "e2e-key",
			persona: "senior",
			serverToken: "e2e-password",
			providers: [{ name: "primary", url: providerUrl, apiKey: "e2e-key", reasoningFormat: "openai-compatible" }],
		}),
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
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.setDefaultTimeout(60_000);
	await page.goto(`http://127.0.0.1:${port}/login`);
	await page.getByLabel("Username").fill("cast");
	await page.getByLabel("Password").fill("e2e-password");
	await page.getByRole("button", { name: "Sign in" }).click();
	await page.waitForURL(`http://127.0.0.1:${port}/`);
	await page.getByRole("button", { name: "Settings" }).click();

	const modal = page.getByRole("dialog", { name: "Settings" });
	await modal.getByRole("button", { name: "Personas", exact: true }).click();
	const groups = modal.locator(".settings-group");
	const rows = modal.locator(".settings-item-row");
	assert((await groups.count()) >= 1, "expected grouped personas");
	assert((await groups.first().getByText("Built-in", { exact: true }).count()) === 1, "expected Built-in persona group");
	assert((await rows.count()) >= 2, "expected at least two personas");
	const firstRow = rows.first();
	const descriptionButton = firstRow.locator('button[title="Description"]');
	const bookButton = firstRow.locator('button[title="Read full content"]');
	await descriptionButton.click();
	const infoPopover = page.locator(".info-popover");
	await infoPopover.waitFor({ state: "visible" });
	assert((await infoPopover.innerText()).length > 10, "persona description popover is empty");
	await infoPopover.locator("button").click();
	await bookButton.click();
	const contentDialog = page.getByRole("dialog", { name: "Persona content" });
	await contentDialog.waitFor({ state: "visible" });
	await page.waitForFunction(
		() => {
			const body = document.querySelector(".fs-preview-body");
			return body && !body.textContent?.includes("Loading") && (body.textContent?.length ?? 0) > 30;
		},
		undefined,
		{ timeout: 30_000 },
	);
	assert((await contentDialog.locator(".fs-preview-body").innerText()).length > 30, "persona full content is empty");
	await contentDialog.getByRole("button", { name: "Close" }).click();
	await page.mouse.move(1100, 800);
	await page.screenshot({ path: "/tmp/cast-settings-personas.png", fullPage: true });

	await page.setViewportSize({ width: 390, height: 844 });
	assert.equal(await rows.first().isVisible(), true, "persona rows should remain visible on mobile");
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		true,
		"mobile Settings should not overflow horizontally",
	);
	await page.screenshot({ path: "/tmp/cast-settings-personas-mobile.png", fullPage: true });
	console.log(`PASS: Settings > Personas renders ${await rows.count()} grouped profiles with description and full-content views`);
} finally {
	if (browser) await browser.close();
	if (cast) {
		cast.kill("SIGTERM");
		await new Promise((resolvePromise) => cast.once("exit", resolvePromise));
	}
	await new Promise((resolvePromise) => provider.close(resolvePromise));
	if (home) await rm(home, { recursive: true, force: true });
}
