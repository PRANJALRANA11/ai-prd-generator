/**
 * Auth Setup Script
 *
 * Run this once with `npm run auth-setup` to log into your dedicated Google
 * account in a real browser window. The session state is saved to
 * `auth-state.json` so the headless bot can reuse it.
 *
 * Usage:
 *   1. Run `npm run auth-setup`
 *   2. Log in to Google in the browser that opens
 *   3. Navigate to https://meet.google.com to confirm access
 *   4. Press Ctrl+C in the terminal OR close the browser window
 */

import { chromium } from "playwright";
import path from "path";

const AUTH_STATE_PATH = process.env.AUTH_STATE_PATH ?? "./auth-state.json";
const resolvedPath = path.resolve(AUTH_STATE_PATH);

async function main() {
  console.log("🔐 Launching browser for Google authentication...");
  console.log("   Please log in to the Google account you want the bot to use.");
  console.log("   After logging in, navigate to https://meet.google.com to confirm access.");
  console.log("   Then press Ctrl+C in this terminal or close the browser.\n");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto("https://accounts.google.com");

  // Auto-save session state every 5 seconds while the browser is open
  const saveInterval = setInterval(async () => {
    try {
      await context.storageState({ path: resolvedPath });
    } catch {
      // Browser might be closing, ignore
    }
  }, 5000);

  // Handle Ctrl+C gracefully
  process.on("SIGINT", async () => {
    clearInterval(saveInterval);
    try {
      await context.storageState({ path: resolvedPath });
      console.log(`\n✅ Auth state saved to ${resolvedPath}`);
    } catch {
      console.error("\n❌ Failed to save auth state.");
    }
    await browser.close();
    process.exit(0);
  });

  // Handle browser being closed by the user
  browser.on("disconnected", () => {
    clearInterval(saveInterval);
    console.log(`\n✅ Browser closed. Auth state saved to ${resolvedPath}`);
    process.exit(0);
  });

  console.log("⏳ Waiting for you to complete login...");
  console.log("   Session is being auto-saved every 5 seconds.\n");

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("❌ Auth setup failed:", err);
  process.exit(1);
});
