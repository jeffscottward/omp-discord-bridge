import { join } from "node:path";

// Runs before every test file (and before any src module is imported): use the fixture config with
// fake ids instead of the real ~/.config/omp-discord/config.json.
process.env.OMP_BOT_CONFIG = join(import.meta.dir, "fixtures", "config.json");
