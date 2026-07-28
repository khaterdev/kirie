/**
 * playwright-core is deliberately NOT a dependency. The browser tool imports it
 * lazily inside a try/catch and falls back to ~/.kirie/node_modules, where
 * ensurePlaywrightInstalled puts it on demand. Installing it eagerly would pull
 * a large browser package into every deployment that never uses the tool.
 *
 * This ambient declaration lets the optional dynamic import typecheck. The call
 * site immediately casts the result to its own structural PlaywrightModule
 * interface, so nothing here is relied on for type safety.
 */
declare module "playwright-core" {
  const playwright: unknown;
  export = playwright;
}
