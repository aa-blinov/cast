import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { apiV1OpenApiDocument, isStableApiV1Route, legacyPathForApiV1 } from "../src/server/api-v1.ts";

describe("API v1 contract", () => {
	it("is a valid OpenAPI document and is published with the GitHub Pages site", async () => {
		await expect(SwaggerParser.validate(apiV1OpenApiDocument)).resolves.toMatchObject({ openapi: "3.1.1" });

		execFileSync("npm", ["run", "build-site"], { cwd: process.cwd(), stdio: "pipe" });
		const publishedSpec = JSON.parse(readFileSync("site/openapi/v1.json", "utf-8")) as object;
		await expect(SwaggerParser.validate(publishedSpec)).resolves.toMatchObject({ openapi: "3.1.1" });
		expect(publishedSpec).toEqual(apiV1OpenApiDocument);
		expect(readFileSync("site/api.html", "utf-8")).toContain('href="openapi/v1.json"');
	});

	it("contains schemas that compile as JSON Schema 2020-compatible contracts", () => {
		const ajv = new Ajv({ strict: false, allErrors: true });
		const components = apiV1OpenApiDocument.components as { schemas: Record<string, object> };
		for (const [name, schema] of Object.entries(components.schemas)) {
			expect(() => ajv.compile(schema), name).not.toThrow();
		}
	});

	it("publishes only routes accepted by the versioned daemon router", () => {
		const paths = apiV1OpenApiDocument.paths as Record<string, Record<string, unknown>>;
		for (const [path, operations] of Object.entries(paths)) {
			if (path === "/api/v1/openapi.json") continue;
			const legacyPath = legacyPathForApiV1(path.replace("{id}", "session-test"));
			expect(legacyPath, path).toBeDefined();
			for (const method of Object.keys(operations)) {
				if (!/^(get|post|delete)$/.test(method)) continue;
				expect(isStableApiV1Route(method.toUpperCase(), legacyPath!), `${method.toUpperCase()} ${path}`).toBe(true);
			}
		}
	});
});
