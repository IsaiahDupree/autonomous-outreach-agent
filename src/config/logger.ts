/**
 * src/config/logger.ts — Winston logger (mirrors Riona pattern)
 */
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) =>
          `[${timestamp}] ${level}: ${message}${Object.keys(meta).length ? " " + JSON.stringify(meta) : ""}`
        )
      ),
    }),
    new DailyRotateFile({
      filename: "logs/outreach-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
    }),
  ],
});

export default logger;
