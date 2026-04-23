import path from "node:path";
import { config as loadDotenv } from "dotenv";

export const PROJECT_ROOT = path.resolve(__dirname, "..");

let isLoaded = false;

export function initEnv(): void {
  if (isLoaded) {
    return;
  }
  loadDotenv({ quiet: true });
  loadDotenv({
    path: path.join(PROJECT_ROOT, ".env"),
    quiet: true,
    override: false,
  });
  isLoaded = true;
}
