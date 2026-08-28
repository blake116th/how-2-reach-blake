/**
 * Blake's status API — a single-endpoint Cloudflare Worker.
 *
 * Reads are public; writes require a bearer token. Every response is JSON,
 * including errors, so callers can parse unconditionally without branching on
 * the status code first.
 *
 * Base URL: https://reach-blake.reach-blake.workers.dev
 *
 * | Method | Auth   | Purpose                  |
 * | ------ | ------ | ------------------------ |
 * | GET    | none   | Read the current status  |
 * | PUT    | Bearer | Set the current status   |
 * | other  | —      | 405, with an Allow header |
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
 * Bindings available on `env`, declared in `wrangler.jsonc` and as a secret.
 *
 * @typedef {object} Env
 * @property {KVNamespace} BLAKE_STATUS
 *   KV namespace holding a single key, `status`. Bound in `wrangler.jsonc`.
 * @property {string} STATUS_WRITE_TOKEN
 *   Shared bearer token authorizing writes. Set via `wrangler secret put` in
 *   production and `.dev.vars` locally — the two are deliberately different
 *   values, so a leaked dev token grants nothing.
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
 * Headers applied to every read response, success and failure alike.
 *
 * `Access-Control-Allow-Origin` is required because the front end is served
 * from a different origin (GitHub Pages) than this Worker. It is set on error
 * responses too, not just the 200 — without it the browser blocks the response
 * before JavaScript can see it, and a legitimate 500 becomes indistinguishable
 * from the network being down.
 *
 * `*` is appropriate here: the read endpoint is public and carries no
 * credentials. Writes deliberately send no CORS headers, so a browser on
 * another origin cannot call them at all.
 *
 * `no-store` keeps the status fresh. It is the entire point of the site, and
 * KV's own propagation delay already puts a floor under how stale it can be —
 * an HTTP cache on top of that would compound the lag.
 *
 * @type {Record<string, string>}
 */
const READ_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Cache-Control': 'no-store',
};

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
 * Both responses carry {@link READ_HEADERS}, so a cross-origin front end can
 * read the body either way and never sees a cached value.
 *
 * @param {Env} env Worker bindings.
 * @returns {Promise<Response>} JSON response, always.
 */
async function readStatus(env) {
	const status = await env.BLAKE_STATUS.get('status');

	// A bad value here is bad stored data, not a bad request, so it is a 5xx.
	if (!VALID_STATUSES.includes(status)) {
		return Response.json({ error: 'invalid status', status }, { status: 500, headers: READ_HEADERS });
	}

	return Response.json({ status }, { headers: READ_HEADERS });
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
	 * - `PUT` → {@link writeStatus} (bearer token required)
	 * - anything else → `405` `{ "error": "method not allowed" }` with
	 *   `Allow: GET, PUT`
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
			case 'PUT':
				return writeStatus(request, env);
			default:
				return Response.json({ error: 'method not allowed' }, { status: 405, headers: { Allow: 'GET, PUT' } });
		}
	},
};
