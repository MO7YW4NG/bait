/**
 * Launch the Pi shopping agent (GMI LLM) with the Bait shop extension.
 *   pnpm shop off            — unprotected agent
 *   pnpm shop on             — same agent, Bait Guard checks every payment before signing
 *   pnpm shop on -p "..."    — non-interactive run (prints the answer and exits)
 * Needs the feed (4030) and merchants (4021) running; run `pnpm decoy` first so the feed has evidence.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [mode, ...rest] = process.argv.slice(2);
if (mode !== "on" && mode !== "off") {
  console.error("Usage: pnpm shop on|off [pi args, e.g. -p \"buy ...\"]");
  process.exit(2);
}
try {
  process.loadEnvFile(".env");
} catch {
  /* env may come from the shell */
}
if (!process.env.GMI_API_KEY) {
  console.error("GMI_API_KEY is missing (.env)");
  process.exit(2);
}

const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
if (!existsSync(cli)) {
  console.error("Pi is not installed. Run pnpm install.");
  process.exit(2);
}

const model = process.env.CUSTOMER_MODEL ?? "deepseek-ai/DeepSeek-V4-Pro";
const args = [
  cli,
  "--offline",
  "--no-session",
  "--no-extensions",
  "--extension", resolve("src/pi/baitShop.ts"),
  "--no-builtin-tools", // no file/bash access: the agent can only shop
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-mcp",
  "--provider", "gmi",
  "--model", model,
  ...rest,
];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, BAIT_GUARD: mode, PI_TELEMETRY: "0" },
});
child.on("exit", (code) => process.exit(code ?? 0));
