import { env, exports } from 'cloudflare:workers';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

const TOKEN = 'test-token';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** A siteverify answer for a genuine token issued on this site. */
const PASSED = {
	success: true,
	'error-codes': [],
	challenge_ts: '2026-09-13T20:00:00.000Z',
	hostname: 'how-2-reach-blake.com',
	action: 'reveal-number',
};

const put = (body, { token = TOKEN, raw } = {}) =>
	exports.default.fetch('http://example.com', {
		method: 'PUT',
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		body: raw ?? JSON.stringify(body),
	});

const reveal = ({ token = 'turnstile-token', headers = {} } = {}) =>
	exports.default.fetch('http://example.com', {
		method: 'POST',
		headers,
		body: token === null ? undefined : new URLSearchParams({ token }),
	});

/**
 * Stands in for siteverify. The Worker and the tests share an isolate, so a spy
 * on the global fetch sees the Worker's outbound call; anything else passes
 * through untouched.
 *
 * @param {object | (() => never)} outcome JSON to answer with, or a function that throws.
 */
const mockSiteverify = (outcome) => {
	const realFetch = globalThis.fetch;

	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		if (String(input instanceof Request ? input.url : input) !== SITEVERIFY_URL) {
			return realFetch(input, init);
		}

		return typeof outcome === 'function' ? outcome() : Response.json(outcome);
	});
};

/** The form fields the Worker sent to siteverify on its first call. */
const sentToSiteverify = async (spy) => {
	const [, init] = spy.mock.calls.find(([input]) => String(input) === SITEVERIFY_URL);
	return Object.fromEntries(new URLSearchParams(init.body));
};

describe('Blake status worker', () => {
	// Storage is isolated per test file, not per test, so reset between tests.
	beforeEach(async () => {
		await env.BLAKE_STATUS.delete('status');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('GET (public)', () => {
		it.each(['flip', 'smart'])('returns 200 and JSON for %s', async (status) => {
			await env.BLAKE_STATUS.put('status', status);

			const response = await exports.default.fetch('http://example.com');

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('application/json');
			expect(await response.json()).toEqual({ status });
		});

		it('needs no auth header', async () => {
			await env.BLAKE_STATUS.put('status', 'flip');

			const response = await exports.default.fetch('http://example.com');

			expect(response.status).toBe(200);
		});

		it('500s with a JSON error when no status is set', async () => {
			const response = await exports.default.fetch('http://example.com');

			expect(response.status).toBe(500);
			expect(response.headers.get('content-type')).toContain('application/json');
			expect(await response.json()).toMatchObject({ error: 'invalid status' });
		});

		it('500s with a JSON error for an unrecognised status', async () => {
			await env.BLAKE_STATUS.put('status', 'asleep');

			const response = await exports.default.fetch('http://example.com');

			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ error: 'invalid status' });
		});

		// The front end is served from another origin, so without these headers on
		// the error response too a real 500 is indistinguishable from a dead network.
		it.each([
			[200, 'flip'],
			[500, null],
		])('sends CORS and no-store on the %i', async (code, stored) => {
			if (stored) {
				await env.BLAKE_STATUS.put('status', stored);
			}

			const response = await exports.default.fetch('http://example.com');

			expect(response.status).toBe(code);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(response.headers.get('Cache-Control')).toBe('no-store');
		});
	});

	describe('POST (Turnstile)', () => {
		it.each([
			['flip', '+15550000001'],
			['smart', '+15550000002'],
		])('returns the %s number for a passed token', async (status, number) => {
			await env.BLAKE_STATUS.put('status', status);
			mockSiteverify(PASSED);

			const response = await reveal();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status, number });
		});

		it('sends the secret, token and visitor IP to siteverify', async () => {
			await env.BLAKE_STATUS.put('status', 'flip');
			const spy = mockSiteverify(PASSED);

			await reveal({ token: 'abc', headers: { 'CF-Connecting-IP': '203.0.113.7' } });

			expect(await sentToSiteverify(spy)).toEqual({
				secret: 'test-turnstile-secret',
				response: 'abc',
				remoteip: '203.0.113.7',
			});
		});

		// Same reasoning as GET: a cross-origin caller must be able to read errors,
		// and a revealed number must never land in a shared cache.
		it.each([
			[200, PASSED],
			[403, { success: false, 'error-codes': ['invalid-input-response'] }],
		])('sends CORS and no-store on the %i', async (code, outcome) => {
			await env.BLAKE_STATUS.put('status', 'flip');
			mockSiteverify(outcome);

			const response = await reveal();

			expect(response.status).toBe(code);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(response.headers.get('Cache-Control')).toBe('no-store');
		});

		it.each([
			['is missing', null],
			['is empty', ''],
			['is too long', 'x'.repeat(2049)],
		])('403s without calling siteverify when the token %s', async (_, token) => {
			await env.BLAKE_STATUS.put('status', 'flip');
			const spy = mockSiteverify(PASSED);

			const response = await reveal({ token });

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: 'invalid token', retryable: true });
			expect(spy.mock.calls.some(([input]) => String(input) === SITEVERIFY_URL)).toBe(false);
		});

		it.each([
			['a failed token', { success: false, 'error-codes': ['invalid-input-response'] }],
			['a spent token', { success: false, 'error-codes': ['timeout-or-duplicate'] }],
			['another hostname', { ...PASSED, hostname: 'evil.example' }],
			['another action', { ...PASSED, action: 'login' }],
			['no action', { ...PASSED, action: undefined }],
		])('403s, retryable, for %s', async (_, outcome) => {
			await env.BLAKE_STATUS.put('status', 'flip');
			mockSiteverify(outcome);

			const response = await reveal();

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: 'invalid token', retryable: true });
		});

		it.each([
			[
				'siteverify is unreachable',
				() => {
					throw new TypeError('network down');
				},
			],
			['siteverify has an internal error', { success: false, 'error-codes': ['internal-error'] }],
		])('502s, retryable, when %s', async (_, outcome) => {
			await env.BLAKE_STATUS.put('status', 'flip');
			mockSiteverify(outcome);

			const response = await reveal();

			expect(response.status).toBe(502);
			expect(await response.json()).toEqual({ error: 'verification unavailable', retryable: true });
		});

		it('500s, not retryable, when siteverify rejects the secret', async () => {
			await env.BLAKE_STATUS.put('status', 'flip');
			mockSiteverify({ success: false, 'error-codes': ['invalid-input-secret'] });

			const response = await reveal();

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: 'server misconfigured', retryable: false });
		});

		// Bindings are fixed for the whole run, so the tests that need a different
		// env call the handler directly rather than through exports.default.
		const revealWith = (overrides) =>
			worker.fetch(new Request('http://example.com', { method: 'POST', body: new URLSearchParams({ token: 'turnstile-token' }) }), {
				...env,
				...overrides,
			});

		it('500s without calling siteverify when the secret is not set', async () => {
			await env.BLAKE_STATUS.put('status', 'flip');
			const spy = mockSiteverify(PASSED);

			const response = await revealWith({ TURNSTILE_SECRET_KEY: undefined });

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: 'server misconfigured', retryable: false });
			expect(spy.mock.calls.some(([input]) => String(input) === SITEVERIFY_URL)).toBe(false);
		});

		it('500s when the number for the current status is not E.164', async () => {
			await env.BLAKE_STATUS.put('status', 'flip');
			mockSiteverify(PASSED);

			const response = await revealWith({ PHONE_FLIP: '555 123 4567' });

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: 'server misconfigured', retryable: false });
		});

		it('500s, not retryable, when no status is set', async () => {
			mockSiteverify(PASSED);

			const response = await reveal();

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: 'invalid status', retryable: false });
		});

		// Test secrets pass every token, so production running on one must release nothing.
		describe('Turnstile test secrets', () => {
			const TEST_KEY_PASSED = { success: true, 'error-codes': [], hostname: 'example.com', metadata: { result_with_testing_key: true } };

			it('are refused as a misconfiguration by default', async () => {
				await env.BLAKE_STATUS.put('status', 'flip');
				mockSiteverify(TEST_KEY_PASSED);

				const response = await reveal();

				expect(response.status).toBe(500);
				expect(await response.json()).toEqual({ error: 'server misconfigured', retryable: false });
			});

			it('are accepted with TURNSTILE_ALLOW_TEST_KEYS', async () => {
				await env.BLAKE_STATUS.put('status', 'flip');
				mockSiteverify(TEST_KEY_PASSED);

				const response = await revealWith({ TURNSTILE_ALLOW_TEST_KEYS: 'true' });

				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ status: 'flip', number: '+15550000001' });
			});
		});
	});

	describe('PUT (authenticated)', () => {
		it.each(['flip', 'smart'])('stores %s with a valid token', async (status) => {
			const response = await put({ status });

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ status });
			expect(await env.BLAKE_STATUS.get('status')).toBe(status);
		});

		it('401s with no Authorization header', async () => {
			const response = await put({ status: 'flip' }, { token: null });

			expect(response.status).toBe(401);
			expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
			expect(await response.json()).toMatchObject({ error: 'unauthorized' });
		});

		it('401s with a wrong token', async () => {
			const response = await put({ status: 'flip' }, { token: 'nope' });

			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ error: 'unauthorized' });
		});

		it('does not write when auth fails', async () => {
			await put({ status: 'flip' }, { token: 'nope' });

			expect(await env.BLAKE_STATUS.get('status')).toBeNull();
		});

		it('400s on an invalid status', async () => {
			const response = await put({ status: 'asleep' });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: 'invalid status' });
			expect(await env.BLAKE_STATUS.get('status')).toBeNull();
		});

		// Writes are intentionally not CORS-enabled: no browser on another origin
		// should be able to call them, successfully or otherwise.
		it('sends no CORS header, even on success', async () => {
			const response = await put({ status: 'flip' });

			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		});

		it('400s on a malformed body', async () => {
			const response = await put(null, { raw: 'not json' });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: 'body must be JSON' });
		});
	});

	it('405s on an unsupported method', async () => {
		const response = await exports.default.fetch('http://example.com', {
			method: 'DELETE',
		});

		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, POST, PUT');
		expect(await response.json()).toMatchObject({ error: 'method not allowed' });
	});
});
