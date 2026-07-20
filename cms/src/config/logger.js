// ============================================================
// LOGGER
// Uses Winston — a professional logging library.
// Logs are written to the console (development) and to files
// (production). This is far better than console.log because:
//   - Logs are structured (JSON) and searchable
//   - Different severity levels (info, warn, error)
//   - Log files are automatically rotated
// ============================================================

const winston = require('winston');
const path = require('path');

// Define log format for files — structured JSON with timestamp
const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),  // include stack traces
    winston.format.json()
);

// Define log format for console — human-readable with colours
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
        return `${timestamp} [${level}]: ${message} ${metaStr}`;
    })
);

// Create the logger
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transports: [
        // Always log to console
        new winston.transports.Console({ format: consoleFormat }),
    ],
});

// In production, also write to log files
if (process.env.NODE_ENV === 'production') {
    logger.add(new winston.transports.File({
        filename: path.join(__dirname, '../../logs/error.log'),
        level: 'error',
        format: fileFormat,
        maxsize: 10 * 1024 * 1024,  // 10MB per file
        maxFiles: 10,                // keep last 10 files
    }));
    logger.add(new winston.transports.File({
        filename: path.join(__dirname, '../../logs/combined.log'),
        format: fileFormat,
        maxsize: 10 * 1024 * 1024,
        maxFiles: 10,
    }));
}

module.exports = logger;
