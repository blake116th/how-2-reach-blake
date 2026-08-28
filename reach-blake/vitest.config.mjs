import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// Test-only token, so the suite never depends on the real .dev.vars value.
			miniflare: {
				bindings: { STATUS_WRITE_TOKEN: 'test-token' },
			},
		}),
	],
});
