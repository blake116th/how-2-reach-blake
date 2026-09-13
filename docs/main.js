/**
 * Asks the status API which version of this page to show, then asks it for
 * the matching phone number behind a Turnstile check.
 *
 * Every variant already exists in the DOM; a single class on <body> decides
 * which one is visible. The page ships in the loading state, so the switch
 * here is the only thing that ever changes it.
 *
 * The number is never in this file or in index.html. The Worker holds it as a
 * secret and hands it only to a browser that passes an invisible Turnstile
 * check, which keeps it out of reach of anything scraping the page.
 */

/**
 * Local development talks to `wrangler dev` with Cloudflare's test sitekey,
 * which works on any hostname and always passes. Production tokens would be
 * refused by the local Worker's test secret, and vice versa.
 */
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);

const ENDPOINT = IS_LOCAL
  ? "http://localhost:8787/"
  : "https://reach-blake.reach-blake.workers.dev/";

/**
 * How long to wait for the Worker before giving up. Without this the loading
 * state has no exit — a hung request would leave the page spinning forever.
 */
const TIMEOUT_MS = 6000;

/**
 * Loaded from this exact URL: Turnstile breaks if api.js is proxied or cached.
 * `render=explicit` stops it scanning the page, so the widget is only created
 * by {@link runChallenge}.
 */
const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The site's invisible widget, or Cloudflare's always-pass invisible test key. */
const TURNSTILE_SITEKEY = IS_LOCAL
  ? "1x00000000000000000000BB"
  : "0x4AAAAAAEy8AZWsGu6HZAnx";

/** Must match TURNSTILE_ACTION in the Worker, which rejects any other. */
const TURNSTILE_ACTION = "reveal-number";

/**
 * How long the script load or the check may take before the button gives up.
 * Turnstile has no timeout of its own for an invisible check.
 */
const CHALLENGE_TIMEOUT_MS = 15000;

/**
 * Turnstile error codes that mean the widget itself is misconfigured — a bad
 * or disabled sitekey, or a hostname it is not allowed on. Running the check
 * again cannot fix those, so they go straight to the dead-end state.
 */
const WIDGET_CONFIG_ERRORS = ["110100", "110110", "110200", "400020", "400070"];

/**
 * The only statuses the API may return. Must match VALID_STATUSES in the Worker.
 *
 * Deliberately separate from {@link STATES}: that map also holds `loading` and
 * `failed`, which are ours alone and must never be accepted off the wire.
 *
 * @type {readonly string[]}
 */
const API_STATUSES = ["flip", "smart"];

/**
 * @typedef {'checking' | 'ready' | 'rejected' | 'unavailable' | 'broken'} CtaPhase
 *
 * @typedef {object} Cta
 * @property {string} verb Label prefix on the button.
 * @property {string} scheme Link scheme the number is dialled with.
 * @property {string} retryLabel Accessible name of the button while retrying is possible.
 * @property {Partial<Record<CtaPhase, string>>} notes Line under the button for each failure.
 */

/**
 * Everything that changes when the state does, in one place — including the
 * two states the API cannot produce.
 *
 * `theme` mirrors the palette each variant sets in style.css: --mobile-desk for
 * the two phone pages, --desk for the plain ones, so the browser chrome on
 * mobile matches the page instead of staying default.
 *
 * `cta` is only on the two phone pages, the only ones with a button.
 *
 * @type {Record<string, { title: string, theme: string, icon: string, cta?: Cta }>}
 */
const STATES = {
  loading: {
    title: "loading...",
    theme: "#2a1548",
    icon: "icons/phone-landline.svg",
  },
  flip: {
    title: "call blake on his flip!",
    theme: "#ef7fbe",
    icon: "icons/phone-landline.svg",
    cta: {
      verb: "CALL",
      scheme: "tel:",
      retryLabel: "redial",
      notes: {
        rejected: "call dropped. tap to redial.",
        unavailable: "no service in this browser. try another.",
        broken: "blake's phone is off the hook. check back later.",
      },
    },
  },
  smart: {
    title: "text blake on his iphone!",
    theme: "#6fc7e8",
    icon: "icons/phone-mobile.svg",
    cta: {
      verb: "TEXT",
      scheme: "sms:",
      retryLabel: "retry",
      notes: {
        rejected: "not delivered. tap to retry.",
        unavailable: "no service here. try your main browser.",
        broken: "blake's on do not disturb. check back later.",
      },
    },
  },
  failed: {
    title: "failed :(",
    theme: "#2a1548",
    icon: "icons/phone-landline.svg",
  },
};

/**
 * A failure on the way to the number, carrying the button phase it should
 * leave behind so every caller does not have to classify it again.
 */
class CtaFailure extends Error {
  /**
   * @param {CtaPhase} phase
   * @param {string} message
   */
  constructor(phase, message) {
    super(message);
    this.phase = phase;
  }
}

/**
 * Points the SVG favicon at a new file.
 *
 * Assigning to `link.href` alone is unreliable — several browsers cache the
 * icon against the element and never re-read it. Replacing the node forces
 * every browser to treat it as a new icon, which is why this looks like
 * pointless indirection and is not.
 *
 * @param {string} href Icon path, relative to the page.
 */
function setFavicon(href) {
  const link = document.getElementById("favicon");

  if (!link || link.getAttribute("href") === href) {
    return;
  }

  const replacement = link.cloneNode(true);
  replacement.setAttribute("href", href);
  link.replaceWith(replacement);
}

/**
 * Swaps the visible variant and brings the title, favicon and browser chrome
 * along with it. The single place that knows how a state looks.
 *
 * @param {'loading' | 'flip' | 'smart' | 'failed'} state
 */
function show(state) {
  const { title, theme, icon } = STATES[state];
  const themeColor = document.querySelector('meta[name="theme-color"]');

  document.body.className = `state-${state}`;
  document.title = title;
  themeColor?.setAttribute("content", theme);
  setFavicon(icon);
}

/**
 * Formats a US number for the button; anything else is shown as stored.
 *
 * @param {string} number E.164, e.g. `+15551234567`.
 * @returns {string} e.g. `(555) 123-4567`.
 */
function formatNumber(number) {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : number;
}

/**
 * Puts one phone page's button into a phase. The single place that knows how
 * the button looks in each.
 *
 * The status button uses `aria-disabled` rather than `disabled`, so a keyboard
 * user who presses retry keeps focus on it while the check runs again.
 *
 * @param {'flip' | 'smart'} state Which page's button.
 * @param {CtaPhase} phase
 * @param {string} [number] E.164 number, required for `ready`.
 */
function setCta(state, phase, number) {
  const { verb, scheme, retryLabel, notes } = STATES[state].cta;
  const bar = document.querySelector(`.variant-${state} .ctabar`);
  const link = bar.querySelector(".cta-link");
  const button = bar.querySelector(".cta-status");

  bar.dataset.phase = phase;
  link.hidden = phase !== "ready";
  button.hidden = phase === "ready";
  bar.querySelector(".cta-note").textContent = notes[phase] ?? "";

  if (phase === "ready") {
    link.href = scheme + number;
    link.querySelector(".cta-text").textContent =
      `${verb} ${formatNumber(number)}`;
    return;
  }

  const placeholder = phase === "checking" ? "···-···-····" : "███-███-████";
  const label = {
    checking: "getting blake's number",
    rejected: retryLabel,
  }[phase];

  button.querySelector(".cta-text").textContent = `${verb} ${placeholder}`;
  button.setAttribute("aria-disabled", String(phase !== "rejected"));
  button.setAttribute("aria-label", label ?? "number unavailable");
}

/**
 * Loads the Turnstile script once. Rejects with the dead-end phase when it is
 * blocked (an ad blocker, most often), unreachable, or never finishes —
 * retrying cannot bring back a script the browser refuses to load.
 *
 * @returns {Promise<object>} The `turnstile` global.
 */
function loadTurnstile() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const fail = (message) => reject(new CtaFailure("unavailable", message));
    const timer = setTimeout(
      () => fail("turnstile script timed out"),
      CHALLENGE_TIMEOUT_MS,
    );

    script.src = TURNSTILE_SCRIPT;
    script.addEventListener("load", () => {
      clearTimeout(timer);
      window.turnstile
        ? resolve(window.turnstile)
        : fail("turnstile loaded without its API");
    });
    script.addEventListener("error", () => {
      clearTimeout(timer);
      fail("turnstile script blocked or unreachable");
    });
    document.head.append(script);
  });
}

/** The widget from the previous check, removed before the next one renders. */
let widgetId;

/**
 * Runs one invisible check and resolves with its token.
 *
 * Retrying is done by removing the widget and rendering a fresh one, the only
 * documented way to start a new check. Turnstile's own retry loop is off, so
 * nothing runs again unless the visitor asks.
 *
 * Callbacks can fire more than once, so only the first outcome counts. The
 * error callback returns true to tell Turnstile the error is handled; without
 * one, Turnstile throws.
 *
 * @param {object} turnstile The `turnstile` global.
 * @returns {Promise<string>} Token to exchange for the number.
 */
function runChallenge(turnstile) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      outcome instanceof CtaFailure ? reject(outcome) : resolve(outcome);
    };

    const timer = setTimeout(
      () => settle(new CtaFailure("rejected", "turnstile check timed out")),
      CHALLENGE_TIMEOUT_MS,
    );

    if (widgetId !== undefined) {
      turnstile.remove(widgetId);
    }

    try {
      widgetId = turnstile.render("#turnstile-widget", {
        sitekey: TURNSTILE_SITEKEY,
        action: TURNSTILE_ACTION,
        retry: "never",
        "refresh-expired": "never",
        callback: (token) => settle(token),
        "error-callback": (code) => {
          const phase = WIDGET_CONFIG_ERRORS.includes(String(code))
            ? "broken"
            : "rejected";
          settle(new CtaFailure(phase, `turnstile error ${code}`));
          return true;
        },
        "unsupported-callback": () =>
          settle(new CtaFailure("unavailable", "browser unsupported")),
      });
    } catch (error) {
      settle(new CtaFailure("broken", `turnstile render failed: ${error}`));
    }
  });
}

/**
 * Trades a token for the current status and its number.
 *
 * The Worker says in `retryable` whether a fresh token could help. A response
 * without that field did not come from the number endpoint as written — an
 * older deployment, or Cloudflare's own error page — so it is judged by status
 * code instead: a server hiccup is worth retrying, anything else is not.
 *
 * @param {string} token
 * @returns {Promise<{ status: 'flip' | 'smart', number: string }>}
 */
async function fetchNumber(token) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new CtaFailure("rejected", `number endpoint unreachable: ${error}`);
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const retryable = body.retryable ?? response.status >= 500;
    throw new CtaFailure(
      retryable ? "rejected" : "broken",
      `number endpoint returned ${response.status}`,
    );
  }

  if (!API_STATUSES.includes(body.status) || !/^\+\d+$/.test(body.number)) {
    throw new CtaFailure("broken", "number endpoint returned an unknown shape");
  }

  return body;
}

/** Loaded once, on first use, and shared by every check after it. */
let turnstileLoad;

/** Bumped per attempt, so a slow old attempt cannot overwrite a newer one. */
let attempt = 0;

/**
 * Runs one Turnstile check and trades its token for the status and number.
 * Rejects with a {@link CtaFailure} naming the phase to show.
 *
 * @returns {Promise<{ status: 'flip' | 'smart', number: string }>}
 */
async function requestNumber() {
  turnstileLoad ??= loadTurnstile();
  const token = await runChallenge(await turnstileLoad);
  return fetchNumber(token);
}

/**
 * Takes one phone page's button from checking to the number, or to the right
 * failure.
 *
 * If the status changed since the page loaded, the Worker's answer wins: the
 * page switches rather than show one phone's number on the other's page.
 *
 * @param {'flip' | 'smart'} state The page currently showing.
 * @param {ReturnType<typeof requestNumber>} [request] A request already under
 *   way. Page load starts one before the status is known; a retry starts afresh.
 */
async function reveal(state, request = requestNumber()) {
  const current = ++attempt;
  setCta(state, "checking");

  try {
    const { status, number } = await request;

    if (current !== attempt) {
      return;
    }

    if (status !== state) {
      show(status);
    }
    setCta(status, "ready", number);
  } catch (error) {
    if (current !== attempt) {
      return;
    }

    console.error("could not get blake's number:", error);
    setCta(state, error instanceof CtaFailure ? error.phase : "broken");
  }
}

/**
 * Reads the status and shows the matching variant, then starts on its number.
 *
 * Anything unexpected resolves to the failed state: a network error, a
 * non-200 (the API returns 500 when no status is set), a body that will not
 * parse, or a status outside the known set. That last case matters — it keeps
 * the client honest about the same closed set the Worker enforces, so a value
 * we have no page for fails visibly instead of rendering nothing.
 *
 * The number is asked for at the same time, not after. The check takes a second
 * or more and does not need the status — the Worker returns it with the number
 * — so waiting for the status read first would only add its round trip. If that
 * read fails, the failed page has no button and the number is dropped unseen.
 */
async function main() {
  // The whole button is the retry, but only while retrying can help.
  for (const state of API_STATUSES) {
    const bar = document.querySelector(`.variant-${state} .ctabar`);
    bar.querySelector(".cta-status").addEventListener("click", () => {
      if (bar.dataset.phase === "rejected") {
        reveal(state);
      }
    });
  }

  const early = requestNumber();
  // Nothing awaits it if the status read fails; this keeps that rejection quiet.
  early.catch(() => {});

  let status;
  try {
    const response = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`status endpoint returned ${response.status}`);
    }

    ({ status } = await response.json());

    if (!API_STATUSES.includes(status)) {
      throw new Error(`unrecognised status: ${status}`);
    }
  } catch (error) {
    console.error("could not reach blake:", error);
    show("failed");
    return;
  }

  show(status);
  reveal(status, early);
}

main();
