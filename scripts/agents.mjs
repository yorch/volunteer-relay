// Compatibility entrypoint for Relay's existing harness prompts and bun script.
import { runCrewplane } from "./crewplane.mjs";

try {
  process.exitCode = await runCrewplane(["agents", ...process.argv.slice(2)]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
