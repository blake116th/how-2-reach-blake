/**
 * Asks the status API which version of this page to show.
 *
 * Every variant already exists in the DOM; a single class on <body> decides
 * which one is visible. The page ships in the loading state, so the switch
 * here is the only thing that ever changes it.
 */

const ENDPOINT = "https://reach-blake.reach-blake.workers.dev/";

/**
 * How long to wait before giving up. Without this the loading state has no
 * exit — a hung request would leave the page spinning forever.
 */
const TIMEOUT_MS = 6000;

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
 * Everything that changes when the state does, in one place — including the
 * two states the API cannot produce.
 *
 * `theme` mirrors the palette each variant sets in style.css: --mobile-desk for
 * the two phone pages, --desk for the plain ones, so the browser chrome on
 * mobile matches the page instead of staying default.
 *
 * @type {Record<string, { title: string, theme: string, icon: string }>}
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
  },
  smart: {
    title: "text blake like a normal person!",
    theme: "#6fc7e8",
    icon: "icons/phone-mobile.svg",
  },
  failed: {
    title: "failed :(",
    theme: "#2a1548",
    icon: "icons/phone-landline.svg",
  },
};

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
 * Reads the status and shows the matching variant.
 *
 * Anything unexpected resolves to the failed state: a network error, a
 * non-200 (the API returns 500 when no status is set), a body that will not
 * parse, or a status outside the known set. That last case matters — it keeps
 * the client honest about the same closed set the Worker enforces, so a value
 * we have no page for fails visibly instead of rendering nothing.
 */
async function main() {
  try {
    const response = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`status endpoint returned ${response.status}`);
    }

    const { status } = await response.json();

    if (!API_STATUSES.includes(status)) {
      throw new Error(`unrecognised status: ${status}`);
    }

    show(status);
  } catch (error) {
    console.error("could not reach blake:", error);
    show("failed");
  }
}

main();
