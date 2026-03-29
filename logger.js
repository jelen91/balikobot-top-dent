/**
 * Centrální logovací modul pro Top-Dent Sync
 * 
 * Úrovně: DEBUG, INFO, WARN, ERROR
 * Výstup: konzole (zkrácený) + soubory (plný)
 * Rotace: max 5 souborů po 5 MB
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');
const POHODA_RESPONSES_DIR = path.join(LOGS_DIR, 'pohoda_responses');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_LOG_FILES = 5;
const MAX_CONSOLE_LENGTH = 200; // Zkrácení pro konzoli

// Vytvoření adresářů pro logy
function ensureLogDirs() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (!fs.existsSync(POHODA_RESPONSES_DIR)) fs.mkdirSync(POHODA_RESPONSES_DIR, { recursive: true });
}

// Formátování timestampu
function timestamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

// Formátování pro čitelnost
function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

// Rotace log souborů
function rotateLog(logFile) {
  try {
    const stats = fs.statSync(logFile);
    if (stats.size >= MAX_LOG_SIZE) {
      // Posun existujících rotovaných souborů
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const from = `${logFile}.${i}`;
        const to = `${logFile}.${i + 1}`;
        if (fs.existsSync(from)) {
          if (i + 1 >= MAX_LOG_FILES) {
            fs.unlinkSync(from); // Smazat nejstarší
          } else {
            fs.renameSync(from, to);
          }
        }
      }
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch (err) {
    // Soubor neexistuje, není co rotovat
  }
}

// Zápis do log souboru
function writeToFile(logFile, line) {
  ensureLogDirs();
  rotateLog(logFile);
  fs.appendFileSync(logFile, line + '\n', 'utf8');
}

// Maskování citlivých dat
function maskSensitive(text) {
  if (!text) return text;
  // Maskovat Basic auth hlavičky
  return text.replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***MASKED***')
    .replace(/"password"\s*:\s*"[^"]*"/g, '"password": "***"')
    .replace(/Authorization:\s*[^\n\r]*/gi, 'Authorization: ***MASKED***');
}

// Zkrácení textu pro konzoli
function truncate(text, maxLen = MAX_CONSOLE_LENGTH) {
  if (!text) return '';
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... (${str.length} chars total)`;
}

// ─── Hlavní logger ───

const LOG_FILE = path.join(LOGS_DIR, 'sync.log');
const DEBUG_LOG_FILE = path.join(LOGS_DIR, 'sync_debug.log');

// Zda je verbose mód zapnutý
let verboseMode = process.argv.includes('--verbose') || process.env.SYNC_VERBOSE === 'true';

const logger = {
  setVerbose(v) {
    verboseMode = v;
  },

  debug(component, message, data = null) {
    const line = `[${timestamp()}] DEBUG ${component}: ${message}`;
    const fullLine = data ? `${line}\n    DATA: ${maskSensitive(typeof data === 'string' ? data : JSON.stringify(data, null, 2))}` : line;

    // Debug jde jen do debug logu a konzole jen ve verbose módu
    writeToFile(DEBUG_LOG_FILE, fullLine);
    if (verboseMode) {
      console.log(`\x1b[90m${line}\x1b[0m`); // Šedivá barva
      if (data) console.log(`\x1b[90m    DATA: ${truncate(data)}\x1b[0m`);
    }
  },

  info(component, message, data = null) {
    const line = `[${timestamp()}] INFO  ${component}: ${message}`;
    const fullLine = data ? `${line}\n    DATA: ${maskSensitive(typeof data === 'string' ? data : JSON.stringify(data, null, 2))}` : line;

    writeToFile(LOG_FILE, line);
    writeToFile(DEBUG_LOG_FILE, fullLine);
    console.log(`\x1b[36m${line}\x1b[0m`); // Cyan barva
  },

  warn(component, message, data = null) {
    const line = `[${timestamp()}] WARN  ${component}: ${message}`;
    const fullLine = data ? `${line}\n    DATA: ${maskSensitive(typeof data === 'string' ? data : JSON.stringify(data, null, 2))}` : line;

    writeToFile(LOG_FILE, fullLine);
    writeToFile(DEBUG_LOG_FILE, fullLine);
    console.log(`\x1b[33m${line}\x1b[0m`); // Žlutá barva
  },

  error(component, message, data = null) {
    const line = `[${timestamp()}] ERROR ${component}: ${message}`;
    const fullLine = data ? `${line}\n    DATA: ${maskSensitive(typeof data === 'string' ? data : JSON.stringify(data, null, 2))}` : line;

    writeToFile(LOG_FILE, fullLine);
    writeToFile(DEBUG_LOG_FILE, fullLine);
    console.error(`\x1b[31m${line}\x1b[0m`); // Červená barva
    if (data) console.error(`\x1b[31m    ${truncate(data)}\x1b[0m`);
  },

  /**
   * Uloží raw response (XML/JSON) do separátního souboru pro debug analýzu
   * @returns {string} Cesta k uloženému souboru
   */
  dumpResponse(component, content, extension = 'xml') {
    ensureLogDirs();
    const filename = `${component.toLowerCase()}_${formatDate(new Date())}.${extension}`;
    const filepath = path.join(POHODA_RESPONSES_DIR, filename);
    fs.writeFileSync(filepath, content, 'utf8');
    logger.debug(component, `Raw response uložena do ${filepath}`);
    return filepath;
  },

  /**
   * Loguje HTTP request pro debugging
   */
  logRequest(component, method, url, headers = {}, body = null) {
    const maskedHeaders = { ...headers };
    if (maskedHeaders['Authorization']) maskedHeaders['Authorization'] = '***MASKED***';
    if (maskedHeaders['STW-Authorization']) maskedHeaders['STW-Authorization'] = '***MASKED***';

    logger.info(component, `${method} ${url}`);
    logger.debug(component, `Request headers: ${JSON.stringify(maskedHeaders)}`);
    if (body) {
      logger.debug(component, `Request body (prvních 500 znaků): ${truncate(body, 500)}`);
    }
  },

  /**
   * Loguje HTTP response pro debugging
   */
  logResponse(component, status, body, url = '') {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    logger.info(component, `Response status=${status}, body size=${bodyStr.length} bytes${url ? ` (${url})` : ''}`);
    logger.debug(component, `Response body: ${truncate(bodyStr, 1000)}`);
  },

  /**
   * Vrátí posledních N řádků hlavního logu
   */
  async getRecentLogs(n = 100, logType = 'main') {
    const file = logType === 'debug' ? DEBUG_LOG_FILE : LOG_FILE;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      return lines.slice(-n);
    } catch (err) {
      return [];
    }
  },

  /**
   * Seznam uložených raw response souborů
   */
  listDumpFiles() {
    ensureLogDirs();
    try {
      return fs.readdirSync(POHODA_RESPONSES_DIR)
        .filter(f => !f.startsWith('.'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  },

  /**
   * Přečte obsah dump souboru
   */
  readDumpFile(filename) {
    const filepath = path.join(POHODA_RESPONSES_DIR, path.basename(filename)); // Sanitize
    if (!fs.existsSync(filepath)) return null;
    return fs.readFileSync(filepath, 'utf8');
  },

  // Cesty pro export
  LOGS_DIR,
  LOG_FILE,
  DEBUG_LOG_FILE,
  POHODA_RESPONSES_DIR,
};

module.exports = logger;
