const mysql = require('mysql2/promise');

const TABLE_NAME = 'kareth_app_state';

let pool = null;
let ready = false;
let activeFlush = null;
let lastPersistenceError = null;
const pendingWrites = new Map();

function buildPool() {
  const required = ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de conexión TiDB: ${missing.join(', ')}`);
  }

  const ssl = { minVersion: 'TLSv1.2' };
  if (process.env.TIDB_CA_CERT) {
    ssl.ca = process.env.TIDB_CA_CERT.replace(/\\n/g, '\n');
  }

  const port = Number(process.env.TIDB_PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TIDB_PORT debe ser un puerto válido.');
  }

  return mysql.createPool({
    host: process.env.TIDB_HOST,
    port,
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE || 'kareth',
    ssl,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 100,
    connectTimeout: 15000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4'
  });
}

function parseJson(value, key) {
  try {
    if (Buffer.isBuffer(value)) {
      return JSON.parse(value.toString('utf8'));
    }
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`El estado "${key}" guardado en TiDB no contiene JSON válido.`, { cause: error });
  }
}

async function initialize(seedStates) {
  if (ready) {
    return readAll(seedStates);
  }

  pool = buildPool();

  try {
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        state_key VARCHAR(64) NOT NULL PRIMARY KEY,
        state_json JSON NOT NULL,
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
          ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [existingRows] = await connection.query(
        `SELECT state_key FROM ${TABLE_NAME}`
      );
      const existingKeys = new Set(existingRows.map(row => row.state_key));

      for (const [key, value] of Object.entries(seedStates)) {
        if (!existingKeys.has(key)) {
          await connection.execute(
            `INSERT IGNORE INTO ${TABLE_NAME} (state_key, state_json) VALUES (?, ?)`,
            [key, JSON.stringify(value)]
          );
        }
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }

    ready = true;
    const loaded = await readAll(seedStates);
    console.log(`✅ TiDB conectado; estado de Kareth cargado (${Object.keys(loaded).length} conjuntos).`);
    return loaded;
  } catch (error) {
    ready = false;
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
    throw new Error(`No se pudo inicializar TiDB: ${error.message}`, { cause: error });
  }
}

async function readAll(seedStates = {}) {
  if (!pool) {
    throw new Error('El almacenamiento TiDB no está inicializado.');
  }

  const [rows] = await pool.query(
    `SELECT state_key, state_json FROM ${TABLE_NAME}`
  );
  const states = { ...seedStates };

  for (const row of rows) {
    states[row.state_key] = parseJson(row.state_json, row.state_key);
  }

  return states;
}

async function flushPendingWrites() {
  if (activeFlush) {
    await activeFlush;
    if (pendingWrites.size > 0) {
      return flushPendingWrites();
    }
    return;
  }

  if (pendingWrites.size === 0) {
    if (lastPersistenceError) throw lastPersistenceError;
    return;
  }
  if (!pool || !ready) {
    throw new Error('No se pueden guardar datos: TiDB no está conectado.');
  }

  const operation = (async () => {
    while (pendingWrites.size > 0) {
      const batch = Array.from(pendingWrites.entries());
      pendingWrites.clear();

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const [key, value] of batch) {
          await connection.execute(
            `INSERT INTO ${TABLE_NAME} (state_key, state_json) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE state_json = VALUES(state_json),
               updated_at = CURRENT_TIMESTAMP(3)`,
            [key, value]
          );
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => {});
        for (const [key, value] of batch) {
          if (!pendingWrites.has(key)) pendingWrites.set(key, value);
        }
        throw error;
      } finally {
        connection.release();
      }
    }
  })();

  activeFlush = operation;
  try {
    await operation;
    lastPersistenceError = null;
  } catch (error) {
    lastPersistenceError = error;
    console.error('❌ No se pudieron guardar los datos en TiDB:', error.message);
    throw error;
  } finally {
    activeFlush = null;
  }
}

function saveState(key, value) {
  if (!ready || !pool) {
    throw new Error('No se pueden guardar datos: TiDB todavía no está conectado.');
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`No se pudo serializar el estado "${key}".`);
  }

  pendingWrites.set(key, serialized);
  const writePromise = flushPendingWrites();
  // Existing domain helpers are synchronous; this handler prevents unhandled
  // rejections while callers that await the promise still receive the error.
  writePromise.catch(() => {});
  return writePromise;
}

function getStatus() {
  return {
    ready,
    pendingWrites: pendingWrites.size,
    hasError: Boolean(lastPersistenceError)
  };
}

async function close() {
  let flushError = null;
  try {
    await flushPendingWrites();
  } catch (error) {
    flushError = error;
  }

  if (pool) {
    await pool.end();
    pool = null;
  }
  ready = false;

  if (flushError) throw flushError;
}

module.exports = {
  initialize,
  saveState,
  flushPendingWrites,
  getStatus,
  close
};
