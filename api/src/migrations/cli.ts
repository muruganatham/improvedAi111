/**
 * Migration CLI
 *
 * Command-line interface for managing MongoDB migrations.
 *
 * Usage:
 *   pnpm run migrate              # Run all pending migrations (default)
 *   pnpm run migrate status       # Show status of all migrations
 *   pnpm run migrate create "name" # Create a new migration file
 *
 * @see README.md for full documentation and examples
 */

/* eslint-disable no-process-exit */
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  getMigrationFullStatus,
  runPendingMigrations,
  generateMigrationId,
  generateMigrationContent,
  getPendingMigrations,
} from "./runner";
import { loggers } from "../logging";

const log = loggers.migration();

const MIGRATIONS_DIR = path.join(__dirname);

/**
 * Format a date for display
 */
function formatDate(date: Date | null): string {
  if (!date) return "-";
  return date.toISOString().replace("T", " ").substring(0, 19);
}

/**
 * Pad string to specified length
 */
function pad(str: string, length: number): string {
  return str.padEnd(length);
}

/**
 * Print a table row
 */
function printRow(cols: string[], widths: number[]): void {
  const cells = cols.map((col, i) => pad(col, widths[i]));
  log.info(`│ ${cells.join(" │ ")} │`);
}

/**
 * Print table separator
 */
function printSeparator(widths: number[], char: "┬" | "┼" | "┴"): void {
  const topChar = char === "┬" ? "┌" : char === "┴" ? "└" : "├";
  const bottomChar = char === "┬" ? "┐" : char === "┴" ? "┘" : "┤";
  const lines = widths.map(w => "─".repeat(w + 2));
  log.info(`${topChar}${lines.join(char)}${bottomChar}`);
}

/**
 * Status command - show migration status
 */
async function statusCommand(): Promise<void> {
  log.error("Migrations are MongoDB-only. Not supported in TiDB Direct Mode.");
  process.exit(1);
}

/**
 * Run command - execute pending migrations
 */
async function runCommand(): Promise<void> {
  log.error("Migrations are MongoDB-only. Not supported in TiDB Direct Mode.");
  process.exit(1);
}

/**
 * Create command - scaffold a new migration file
 */
async function createCommand(name: string): Promise<void> {
  try {
    if (!name || name.trim().length === 0) {
      log.error("❌ Migration name is required");
      process.exit(1);
    }

    const migrationId = generateMigrationId(name);
    const filename = `${migrationId}.ts`;
    const filepath = path.join(MIGRATIONS_DIR, filename);

    // Check if file already exists
    if (fs.existsSync(filepath)) {
      log.error(`❌ Migration file already exists: ${filename}`);
      process.exit(1);
    }

    // Generate and write content
    const content = generateMigrationContent(name);
    fs.writeFileSync(filepath, content, "utf-8");

    log.info(`✓ Created migration: ${filename}`, { path: filepath });
    process.exit(0);
  } catch (error) {
    log.error("❌ Error:", { error });
    process.exit(1);
  }
}

// Create commander program
const program = new Command();

program.name("migrate").description("MongoDB migration tool").version("1.0.0");

program
  .command("status")
  .description("Show status of all migrations")
  .action(statusCommand);

program
  .command("create <name>")
  .description("Create a new migration file")
  .action(createCommand);

program
  .command("run", { isDefault: true })
  .description("Run all pending migrations (default command)")
  .action(runCommand);

// Parse arguments
program.parse(process.argv);
