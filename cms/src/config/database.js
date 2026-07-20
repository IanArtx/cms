// ============================================================
// DATABASE CONNECTION
// Uses the 'pg' library's connection pool.
// A pool maintains multiple open connections to the database
// so the app doesn't have to open/close one on every request.
// ============================================================

const { Pool } = require('pg');

// Create a connection pool using environment variables
const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // SSL is required in production (DigitalOcean enforces it)
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    // Pool sizing — how many simultaneous DB connections to allow
    max: 20,                // maximum connections in the pool
    idleTimeoutMillis: 30000,   // close idle connections after 30 seconds
    connectionTimeoutMillis: 2000, // error if a connection takes more than 2 seconds
});

// Test the connection when the server starts
pool.on('connect', () => {
    // Only log in development to avoid noise in production logs
    if (process.env.NODE_ENV === 'development') {
        console.log('✅ Database connection established');
    }
});

// Log any unexpected pool errors
pool.on('error', (err) => {
    console.error('❌ Unexpected database pool error:', err.message);
    // Do not crash the process — the pool will attempt to recover
});

// ============================================================
// QUERY HELPER
// Wraps pool.query with error logging.
// Usage:  const result = await query('SELECT * FROM users WHERE id = $1', [id]);
// ============================================================
const query = async (text, params) => {
    const start = Date.now();
    try {
        const result = await pool.query(text, params);
        if (process.env.NODE_ENV === 'development') {
            const duration = Date.now() - start;
            // Log slow queries (over 1 second) for performance monitoring
            if (duration > 1000) {
                console.warn(`⚠️  Slow query (${duration}ms):`, text);
            }
        }
        return result;
    } catch (err) {
        console.error('Database query error:', { text, params, error: err.message });
        throw err;
    }
};

// ============================================================
// TRANSACTION HELPER
// For operations that must be atomic — either ALL steps succeed
// or ALL are rolled back. Critical for financial operations.
//
// Usage:
//   await withTransaction(async (client) => {
//       await client.query('INSERT INTO ...');
//       await client.query('UPDATE accounts SET ...');
//   });
// ============================================================
const withTransaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        // Always release the client back to the pool
        client.release();
    }
};

// ============================================================
// HEALTH CHECK
// Used by the server startup to verify DB is reachable
// ============================================================
const checkConnection = async () => {
    try {
        const result = await query('SELECT NOW() AS current_time');
        console.log('✅ Database health check passed:', result.rows[0].current_time);
        return true;
    } catch (err) {
        console.error('❌ Database health check failed:', err.message);
        return false;
    }
};

module.exports = { query, withTransaction, checkConnection, pool };
