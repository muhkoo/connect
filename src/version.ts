/**
 * SDK build version — stamped to the console when a {@link Client} is created.
 *
 * During active development, bump the `-alpha.N` suffix whenever we ship a build
 * so we can confirm in the browser console that the page is running the build we
 * expect (and isn't serving a stale cached bundle). Keep this in sync with
 * `package.json` `version`.
 */
export const VERSION = "0.10.14-alpha.0";
