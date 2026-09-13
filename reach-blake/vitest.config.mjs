import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// Test-only values, so the suite never depends on the real .dev.vars. The
			// empty TURNSTILE_ALLOW_TEST_KEYS matters: .dev.vars sets it, and the suite
			// must see production behaviour unless a test opts in.
			miniflare: {
				bindings: {
					STATUS_WRITE_TOKEN: 'test-token',
					TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
					TURNSTILE_ALLOW_TEST_KEYS: '',
					PHONE_FLIP: '+15550000001',
					PHONE_SMART: '+15550000002',
				},
			},
		}),
	],
});
