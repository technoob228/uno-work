/**
 * The console's address, in a module that imports nothing: `machineClass`
 * reads it while it loads, and `accountOverview` sits in an import cycle with
 * it (accountOverview → unoAccount → … → machineErrors → machineClass), so
 * taking it from there threw "Cannot access 'CONSOLE_URL' before
 * initialization" whenever the cycle was entered from accountOverview.
 *
 * @module account/consoleUrl
 */
export const CONSOLE_URL = "https://console.uno.place";
