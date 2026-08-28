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

/** Must match VALID_STATUSES in the Worker. */
const STATES = {
  flip: "call blake on his flip!",
  smart: "text blake like a normal person!",
  failed: "failed :(",
};

/**
 * Swaps the visible variant and updates the tab title to match.
 *
 * @param {'flip' | 'smart' | 'failed'} state
 */
function show(state) {
  document.body.className = `state-${state}`;
  document.title = STATES[state];
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

    if (!Object.hasOwn(STATES, status) || status === "failed") {
      throw new Error(`unrecognised status: ${status}`);
    }

    show(status);
  } catch (error) {
    console.error("could not reach blake:", error);
    show("failed");
  }
}

main();
