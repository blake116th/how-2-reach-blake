import { env, exports } from 'cloudflare:workers';
import { describe, it, expect, beforeEach } from 'vitest';

const TOKEN = 'test-token';

const put = (body, { token = TOKEN, raw } = {}) =>
	exports.default.fetch('http://example.com', {
		method: 'PUT',
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		body: raw ?? JSON.stringify(body),
	});

describe('Blake status worker', () => {
	// Storage is isolated per test file, not per test, so reset between tests.
	beforeEach(async () => {
		await env.BLAKE_STATUS.delete('status');
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
		expect(response.headers.get('Allow')).toBe('GET, PUT');
		expect(await response.json()).toMatchObject({ error: 'method not allowed' });
	});
});
