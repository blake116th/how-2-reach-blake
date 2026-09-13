/**
 * Blake's status API — a single-endpoint Cloudflare Worker.
 *
 * Reads are public; writes require a bearer token; the phone number for the
 * current status is released only to a visitor who has passed a Turnstile check.
 * Every response is JSON, including errors, so callers can parse unconditionally
 * without branching on the status code first.
 *
 * Base URL: https://reach-blake.reach-blake.workers.dev
 *
 * | Method | Auth      | Purpose                                  |
 * | ------ | --------- | ---------------------------------------- |
 * | GET    | none      | Read the current status                  |
 * | POST   | Turnstile | Read the current status and phone number |
 * | PUT    | Bearer    | Set the current status                   |
 * | other  | —         | 405, with an Allow header                |
 *
 * The status is always one of {@link VALID_STATUSES}. Any other value — including
 * an unset key — is treated as invalid rather than returned to the caller.
 *
 * Read it:
 * ```sh
 * curl https://reach-blake.reach-blake.workers.dev/
 * # {"status":"flip"}
 * ```
 *
 * Reveal the number (the token comes from the Turnstile widget on the site):
 * ```sh
 * curl -X POST --data-urlencode "token=$TURNSTILE_TOKEN" https://reach-blake.reach-blake.workers.dev/
 * # {"status":"flip","number":"+15551234567"}
 * ```
 *
 * Write it:
 * ```sh
 * curl -X PUT -H "Authorization: Bearer $TOKEN" \
 *   -d '{"status":"smart"}' https://reach-blake.reach-blake.workers.dev/
 * # {"status":"smart"}
 * ```
 *
 * @see https://developers.cloudflare.com/workers/
 */

/**
 * Bindings available on `env`, declared in `wrangler.jsonc` and as secrets.
 *
 * @typedef {object} Env
 * @property {KVNamespace} BLAKE_STATUS
 *   KV namespace holding a single key, `status`. Bound in `wrangler.jsonc`.
 * @property {string} STATUS_WRITE_TOKEN
 *   Shared bearer token authorizing writes. Set via `wrangler secret put` in
 *   production and `.dev.vars` locally — the two are deliberately different
 *   values, so a leaked dev token grants nothing.
 * @property {string} TURNSTILE_SECRET_KEY
 *   Secret key of the site's Turnstile widget, used to call siteverify. A secret
 *   in production; Cloudflare's always-pass test secret in `.dev.vars`.
 * @property {string} PHONE_FLIP
 *   Number released while the status is `flip`, in E.164 (`+15551234567`).
 * @property {string} PHONE_SMART
 *   Number released while the status is `smart`, in E.164.
 * @property {string} [TURNSTILE_ALLOW_TEST_KEYS]
 *   `"true"` accepts results from Turnstile test secrets. Local development only.
 */

/**
 * The only values the API will store or return.
 *
 * Callers should treat this as a closed set: anything else is rejected on write
 * and reported as a server error on read.
 *
 * @type {readonly string[]}
 */
const VALID_STATUSES = ['flip', 'smart'];

/**
 * Headers applied to every response from the two public endpoints, success and
 * failure alike.
 *
 * `Access-Control-Allow-Origin` is required because the front end is served
 * from a different origin (GitHub Pages) than this Worker. It is set on error
 * responses too, not just the 200 — without it the browser blocks the response
 * before JavaScript can see it, and a legitimate 500 becomes indistinguishable
 * from the network being down.
 *
 * `*` is appropriate here: neither public endpoint carries credentials, and the
 * number endpoint is guarded by its Turnstile token, not by origin — an origin
 * check would stop only browsers, which the token already covers. Writes
 * deliberately send no CORS headers, so a browser on another origin cannot call
 * them at all.
 *
 * `no-store` keeps the status fresh. It is the entire point of the site, and
 * KV's own propagation delay already puts a floor under how stale it can be —
 * an HTTP cache on top of that would compound the lag. It also keeps a revealed
 * number out of any shared cache.
 *
 * @type {Record<string, string>}
 */
const PUBLIC_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Cache-Control': 'no-store',
};

/** @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ */
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * What a genuine token for this site must report. Checking both stops a token
 * solved on some other site, or for some other action, from being replayed here.
 * The action must match the one the front end passes to `turnstile.render()`.
 */
const TURNSTILE_HOSTNAME = 'how-2-reach-blake.com';
const TURNSTILE_ACTION = 'reveal-number';

/**
 * Leaves room inside the front end's own 6-second timeout for this Worker to
 * answer with a retryable error rather than the browser giving up first.
 */
const SITEVERIFY_TIMEOUT_MS = 4000;

/** Turnstile tokens are at most 2048 characters; anything longer is not one. */
const MAX_TOKEN_LENGTH = 2048;

/** A phone number the front end can put straight into a `tel:` or `sms:` link. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Compares two tokens without leaking their contents through timing.
 *
 * Both sides are SHA-256 hashed before comparison. That is not for secrecy — it
 * guarantees two equal-length buffers, because `crypto.subtle.timingSafeEqual`
 * throws when byte lengths differ. Hashing first turns a wrong-length token into
 * an ordinary `false` instead of an exception.
 *
 * `timingSafeEqual` is a Cloudflare extension to WebCrypto, not standard.
 *
 * @param {string} provided Token supplied by the caller.
 * @param {string} expected Token from the environment.
 * @returns {Promise<boolean>} True when the tokens match exactly.
 * @see https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
 */
async function tokensMatch(provided, expected) {
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(provided)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	]);

	return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Checks a request's `Authorization` header against the write token.
 *
 * Expects the standard bearer form, with the scheme matched case-sensitively:
 *
 * ```http
 * Authorization: Bearer <token>
 * ```
 *
 * A missing header, a non-Bearer scheme, or an empty token all fail without
 * reaching the comparison.
 *
 * @param {Request} request Incoming request.
 * @param {Env} env Worker bindings.
 * @returns {Promise<boolean>} True when the caller may write.
 */
async function isAuthorized(request, env) {
	const [scheme, token] = (request.headers.get('Authorization') ?? '').split(' ');

	if (scheme !== 'Bearer' || !token) {
		return false;
	}

	return tokensMatch(token, env.STATUS_WRITE_TOKEN);
}

/**
 * Handles `GET /` — returns the current status. Public, no auth.
 *
 * Responses:
 *
 * - `200` — `{ "status": "flip" }`
 * - `500` — `{ "error": "invalid status", "status": null }`
 *
 * The 500 is deliberate rather than a 404. An unset or unrecognised key means
 * the stored data is wrong, which is a server-side fault, not a bad request —
 * the caller did nothing incorrect. The offending value is echoed back in
 * `status` to make the cause obvious. Contrast {@link writeStatus}, where the
 * same invalid value is a 400 because there the caller supplied it.
 *
 * Both responses carry {@link PUBLIC_HEADERS}, so a cross-origin front end can
 * read the body either way and never sees a cached value.
 *
 * @param {Env} env Worker bindings.
 * @returns {Promise<Response>} JSON response, always.
 */
async function readStatus(env) {
	const status = await env.BLAKE_STATUS.get('status');

	// A bad value here is bad stored data, not a bad request, so it is a 5xx.
	if (!VALID_STATUSES.includes(status)) {
		return Response.json({ error: 'invalid status', status }, { status: 500, headers: PUBLIC_HEADERS });
	}

	return Response.json({ status }, { headers: PUBLIC_HEADERS });
}

/**
 * Asks Turnstile whether a token is genuine, and genuinely for this site.
 *
 * Collapses siteverify's answer into the four outcomes the caller acts on:
 *
 * - `ok` — the token passed and was issued for {@link TURNSTILE_HOSTNAME} and
 *   {@link TURNSTILE_ACTION}
 * - `rejected` — the token failed, was already spent, or belongs elsewhere
 * - `unavailable` — siteverify could not be reached or had an internal error
 * - `misconfigured` — the secret is wrong, or a test secret is in use without
 *   `TURNSTILE_ALLOW_TEST_KEYS`
 *
 * Test secrets report `metadata.result_with_testing_key`, hostname `example.com`
 * and no action, so they could never pass the site checks. That flag is not in
 * Turnstile's documentation; if it ever disappears, local development fails the
 * site checks and says so, which is the safe direction. Refusing test results by
 * default means production deployed with a test secret — which passes every
 * token — releases nothing.
 *
 * @param {string} token Token from the Turnstile widget.
 * @param {Request} request Incoming request, for the visitor's IP.
 * @param {Env} env Worker bindings.
 * @returns {Promise<'ok' | 'rejected' | 'unavailable' | 'misconfigured'>}
 */
async function verifyToken(token, request, env) {
	const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
	const ip = request.headers.get('CF-Connecting-IP');

	if (ip) {
		body.set('remoteip', ip);
	}

	let outcome;
	try {
		const response = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) });
		outcome = await response.json();
	} catch (error) {
		console.error('siteverify unreachable:', error);
		return 'unavailable';
	}

	const codes = outcome['error-codes'] ?? [];

	if (codes.includes('missing-input-secret') || codes.includes('invalid-input-secret')) {
		console.error('turnstile secret rejected:', codes);
		return 'misconfigured';
	}

	if (outcome.success !== true) {
		console.warn('turnstile token rejected:', codes);
		return codes.includes('internal-error') ? 'unavailable' : 'rejected';
	}

	if (outcome.metadata?.result_with_testing_key) {
		if (env.TURNSTILE_ALLOW_TEST_KEYS === 'true') {
			return 'ok';
		}

		console.error('turnstile test secret in use without TURNSTILE_ALLOW_TEST_KEYS');
		return 'misconfigured';
	}

	if (outcome.hostname !== TURNSTILE_HOSTNAME || outcome.action !== TURNSTILE_ACTION) {
		console.warn('turnstile token issued elsewhere:', outcome.hostname, outcome.action);
		return 'rejected';
	}

	return 'ok';
}

/**
 * A JSON error from {@link revealNumber}.
 *
 * `retryable` tells the front end whether running the check again could help,
 * so it can choose between its retry and dead-end states without knowing what
 * each status code means.
 *
 * @param {string} error Short description.
 * @param {number} status HTTP status code.
 * @param {boolean} retryable Whether a fresh token might succeed.
 * @returns {Response}
 */
function revealError(error, status, retryable) {
	return Response.json({ error, retryable }, { status, headers: PUBLIC_HEADERS });
}

/**
 * Handles `POST /` — returns the current status and its phone number, to a
 * visitor holding a valid Turnstile token.
 *
 * The body is form-encoded with a single `token` field. Form encoding, rather
 * than JSON, keeps this a CORS "simple request", so the browser sends no
 * preflight and the Worker needs no OPTIONS handler.
 *
 * Responses:
 *
 * - `200` — `{ "status": "flip", "number": "+15551234567" }`
 * - `403` — `{ "error": "invalid token", "retryable": true }`
 * - `500` — `{ "error": "invalid status", "retryable": false }`
 * - `500` — `{ "error": "server misconfigured", "retryable": false }`
 * - `502` — `{ "error": "verification unavailable", "retryable": true }`
 *
 * The status is returned alongside the number because it may have changed since
 * the page read it; the front end switches pages rather than show one phone's
 * number on the other's page.
 *
 * Checks run in order: configuration, then the token, then the stored data. The
 * token is verified before anything is read, so a caller without one learns
 * nothing — not even whether the numbers are configured.
 *
 * A missing or malformed token is a 403 rather than a 400. The only legitimate
 * caller is the site's own script, so a bad token means a bad check, and a fresh
 * one is exactly what the front end's retry fetches.
 *
 * @param {Request} request Incoming request, with a form-encoded body.
 * @param {Env} env Worker bindings.
 * @returns {Promise<Response>} JSON response, always.
 */
async function revealNumber(request, env) {
	if (!env.TURNSTILE_SECRET_KEY) {
		return revealError('server misconfigured', 500, false);
	}

	let token;
	try {
		token = (await request.formData()).get('token');
	} catch {
		token = null;
	}

	if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
		return revealError('invalid token', 403, true);
	}

	switch (await verifyToken(token, request, env)) {
		case 'misconfigured':
			return revealError('server misconfigured', 500, false);
		case 'unavailable':
			return revealError('verification unavailable', 502, true);
		case 'rejected':
			return revealError('invalid token', 403, true);
	}

	const status = await env.BLAKE_STATUS.get('status');

	if (!VALID_STATUSES.includes(status)) {
		return revealError('invalid status', 500, false);
	}

	const number = { flip: env.PHONE_FLIP, smart: env.PHONE_SMART }[status];

	if (!E164.test(number ?? '')) {
		console.error(`no valid phone number configured for ${status}`);
		return revealError('server misconfigured', 500, false);
	}

	return Response.json({ status, number }, { headers: PUBLIC_HEADERS });
}

/**
 * Handles `PUT /` — sets the current status. Requires a bearer token.
 *
 * Request body must be JSON with a `status` field holding one of
 * {@link VALID_STATUSES}:
 *
 * ```json
 * { "status": "flip" }
 * ```
 *
 * Responses:
 *
 * - `200` — `{ "status": "flip" }`, the value now stored
 * - `400` — `{ "error": "body must be JSON" }`
 * - `400` — `{ "error": "invalid status", "valid": ["flip", "smart"] }`
 *   (the valid set is returned so callers can self-correct)
 * - `401` — `{ "error": "unauthorized" }`, with `WWW-Authenticate: Bearer`
 * - `500` — `{ "error": "server misconfigured" }`
 *
 * Checks run in order: configuration, then auth, then body. Auth is verified
 * before the body is read, so an unauthorized caller never has input parsed and
 * nothing is written to KV on any failure path.
 *
 * The 500 guard matters more than it looks. Without it a missing
 * `STATUS_WRITE_TOKEN` would leave `expected` as `undefined`, and the endpoint
 * would fail in a confusing way rather than saying it is misconfigured.
 *
 * Note that KV is eventually consistent: a write is visible immediately in the
 * same location but may take up to 60 seconds to propagate globally, so an
 * immediate read elsewhere can still return the previous value.
 *
 * @param {Request} request Incoming request, with a JSON body.
 * @param {Env} env Worker bindings.
 * @returns {Promise<Response>} JSON response, always.
 */
async function writeStatus(request, env) {
	// Without this a missing secret would make every token compare equal to undefined.
	if (!env.STATUS_WRITE_TOKEN) {
		return Response.json({ error: 'server misconfigured' }, { status: 500 });
	}

	if (!(await isAuthorized(request, env))) {
		return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'body must be JSON' }, { status: 400 });
	}

	// Here a bad status IS the caller's fault, so it is a 4xx rather than a 5xx.
	if (!VALID_STATUSES.includes(body?.status)) {
		return Response.json({ error: 'invalid status', valid: VALID_STATUSES }, { status: 400 });
	}

	await env.BLAKE_STATUS.put('status', body.status);

	return Response.json({ status: body.status });
}

export default {
	/**
	 * Worker entry point. Routes on method only — the path is ignored, so every
	 * path serves the same resource.
	 *
	 * - `GET` → {@link readStatus} (public)
	 * - `POST` → {@link revealNumber} (Turnstile token required)
	 * - `PUT` → {@link writeStatus} (bearer token required)
	 * - anything else → `405` `{ "error": "method not allowed" }` with
	 *   `Allow: GET, POST, PUT`
	 *
	 * @param {Request} request Incoming request.
	 * @param {Env} env Worker bindings.
	 * @param {ExecutionContext} ctx Execution context; unused, as no work outlives the response.
	 * @returns {Promise<Response>} JSON response, always.
	 */
	async fetch(request, env, ctx) {
		switch (request.method) {
			case 'GET':
				return readStatus(env);
			case 'POST':
				return revealNumber(request, env);
			case 'PUT':
				return writeStatus(request, env);
			default:
				return Response.json({ error: 'method not allowed' }, { status: 405, headers: { Allow: 'GET, POST, PUT' } });
		}
	},
};
