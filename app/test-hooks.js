/**
 * Whether the hooks scripts/parity.mjs drives the app through are compiled in:
 * `window.__bmd`, stand-ins for native dialogs (platform.js `stub`), no automatic
 * update check.
 *
 * On in the dev server, and in the `parity` build (`vite build --mode parity`, which
 * reads app/.env.parity): the checks run against a production bundle, because that's
 * what ships — speed budgets mean nothing on development builds of the parsers, and
 * minification is where the 0.1.3 update check went missing. Off in every release
 * build; scripts/check-dist.mjs fails the build if any hook made it into one.
 */
export const TEST_HOOKS = Boolean(import.meta.env?.DEV) || import.meta.env?.VITE_BMD_TEST_HOOKS === '1';
