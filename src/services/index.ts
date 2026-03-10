export * from "./cloud";
export * from "./telegram";
export * from "./obsidian";

import { Server } from "http";
import logger from "../config/logger";

export function shutdown(server: Server): void {
  logger.info("Shutting down gracefully...");
  server.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}
