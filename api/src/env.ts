/**
 * Bootstrap environment loading.
 * This module MUST be imported first in index.ts before any other imports.
 * It synchronously loads the .env file so that process.env is populated
 * before any module-level code (including logging initialization) runs.
 */
import { config } from "dotenv";
import fs from "fs";
import path from "path";

const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  config({ path: envPath });
}
