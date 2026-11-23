import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		// The renderer's and the cloak's tests simulate a good deal: a second
		// or two each here, several times that on CI's two cores with the
		// other files running alongside. Vitest's default 5 s was failing
		// them there on time alone.
		testTimeout: 30_000,
	},
});
