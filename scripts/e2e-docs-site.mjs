import assert from "node:assert/strict";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const repo = resolve(new URL("..", import.meta.url).pathname);
const site = join(repo, "site");

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

function contentType(path) {
	return {
		".css": "text/css; charset=utf-8",
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
	}[extname(path)] ?? "application/octet-stream";
}

function startSiteServer() {
	const server = createServer((request, response) => {
		const requested = request.url?.split("?", 1)[0] ?? "/";
		const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
		const file = normalize(join(site, relative));
		if (!file.startsWith(`${site}/`) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
			response.writeHead(404).end("Not found");
			return;
		}
		response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
		createReadStream(file).pipe(response);
	});
	return new Promise((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise(server)));
}

execFileSync(process.execPath, ["--import", "tsx", "scripts/build-site.mjs"], { cwd: repo, stdio: "ignore" });
const server = await startSiteServer();
const port = server.address().port;
let browser;
try {
	browser = await chromium.launch({
		headless: true,
		executablePath: playwrightExecutable(),
		args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
	});

	const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	desktop.setDefaultTimeout(15_000);
	await desktop.goto(`http://127.0.0.1:${port}/getting-started.html`, { waitUntil: "networkidle" });
	const codeCheck = await desktop.locator(".content pre.code-block").first().evaluate((pre) => {
		const code = pre.querySelector("code");
		const style = getComputedStyle(pre);
		return {
			background: style.backgroundColor,
			backgroundImage: style.backgroundImage,
			borderStyle: style.borderTopStyle,
			overflowX: style.overflowX,
			language: pre.getAttribute("data-language"),
			codeClass: code?.className ?? "",
		};
	});
	assert.notEqual(codeCheck.backgroundImage, "none", "code block must have a visible background");
	assert.equal(codeCheck.borderStyle, "solid", "code block must have a visible border");
	assert.equal(codeCheck.overflowX, "auto", "long code must scroll inside its block");
	assert.equal(codeCheck.language, "bash", "language label must be preserved");
	assert.match(codeCheck.codeClass, /hljs/, "code must use the syntax-highlighting class");
	assert((await desktop.locator('.content pre.code-block span[class^="hljs-"]').count()) > 0, "highlighted code must contain syntax spans");

	await desktop.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
	await desktop.screenshot({ path: "/tmp/cast-workspace-desktop.png", fullPage: false });
	assert.equal(await desktop.locator(".workspace-ui").count(), 1, "actual Web UI preview must be present");
	assert.equal(await desktop.locator(".workspace-ui-sidebar").count(), 1, "preview must include the sessions sidebar");
	assert.equal(await desktop.locator(".workspace-ui-new").count(), 1, "preview must include New session");
	assert.equal(await desktop.locator(".workspace-ui-persona").count(), 4, "preview must include switchable personas");
	assert.equal(await desktop.locator(".workspace-ui-metrics").count(), 0, "landing must not show fabricated metrics");
	assert.equal(await desktop.locator(".workspace-ui input, .workspace-ui textarea").count(), 0, "preview must not show an empty input");
	await desktop.getByRole("tab", { name: "Reviewer" }).click();
	assert.equal(await desktop.locator('[data-active-persona]').textContent(), "Reviewer", "persona status must update after switching");
	assert.equal(await desktop.locator('[data-persona-panel="reviewer"]').isHidden(), false, "selected persona panel must be visible");
	assert.equal(await desktop.locator('[data-persona-panel="senior"]').isHidden(), true, "previous persona panel must be hidden");

	const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
	await mobile.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
	const mobileCheck = await mobile.evaluate(() => ({
		viewport: window.innerWidth,
		documentWidth: document.documentElement.scrollWidth,
	panelWidth: document.querySelector(".workspace-ui")?.getBoundingClientRect().width ?? 0,
		titleSize: getComputedStyle(document.querySelector(".workspace-title")).fontSize,
	}));
	assert.equal(mobileCheck.documentWidth, mobileCheck.viewport, "mobile landing page must not overflow horizontally");
	assert(mobileCheck.panelWidth <= mobileCheck.viewport - 32, "workspace preview must fit the mobile gutter");
	await mobile.screenshot({ path: "/tmp/cast-workspace-mobile.png", fullPage: false });

	console.log(JSON.stringify({ codeCheck, mobileCheck }, null, 2));
	console.log("Docs and workspace Playwright checks passed");
} finally {
	await browser?.close();
	server.close();
}
