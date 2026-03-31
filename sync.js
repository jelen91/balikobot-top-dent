require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const xml2js = require('xml2js');
const iconv = require('iconv-lite');
const logger = require('./logger');

// ----------------------------------------------------
// KONFIGURACE
// ----------------------------------------------------
const POHODA_MSERVER_URL =
  process.env.POHODA_MSERVER_URL || 'http://localhost:7778/xml';
const POHODA_ICO = process.env.POHODA_ICO || '12345678';
const POHODA_USER = process.env.POHODA_USER || 'Admin';
const POHODA_PASS = process.env.POHODA_PASS || '';
const POHODA_AUTH =
  'Basic ' + Buffer.from(`${POHODA_USER}:${POHODA_PASS}`).toString('base64');


const UPGATES_URL = (
  process.env.UPGATES_URL || 'https://topdent.admin.s5.upgates.com/api/v2'
).replace(/\/$/, '');
const UPGATES_USER = process.env.UPGATES_USER || '';
const UPGATES_SECRET = process.env.UPGATES_SECRET || '';
const UPGATES_AUTH =
  'Basic ' +
  Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');

const BB_API_BASE = 'https://apiv2.balikobot.cz';
const BB_USER = process.env.BALIKOBOT_API_USER || '';
const BB_KEY  = process.env.BALIKOBOT_API_KEY  || '';
const BB_AUTH = 'Basic ' + Buffer.from(`${BB_USER}:${BB_KEY}`).toString('base64');
const BB_HEADERS = { Authorization: BB_AUTH, 'Content-Type': 'application/json' };

// ----------------------------------------------------
// DATABÁZE PRO UCHOVÁNÍ ZPRACOVANÝCH FAKTUR
// ----------------------------------------------------
const DB_FILE = path.join(__dirname, 'processed_invoices.json');
const LOG_FILE = path.join(__dirname, 'sync_log.json');

async function loadDb() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    const db = JSON.parse(data);
    // Migrace ze starého formátu pole → objekt s daty
    if (Array.isArray(db.processed)) {
      const now = new Date().toISOString();
      const obj = {};
      for (const num of db.processed) obj[num] = now;
      db.processed = obj;
    }
    return db;
  } catch (err) {
    if (err.code === 'ENOENT') return { processed: {} };
    throw err;
  }
}

async function saveDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ----------------------------------------------------
// LOGOVACÍ SYSTÉM (JSON log pro dashboard)
// ----------------------------------------------------
async function loadSyncLog() {
  try {
    const data = await fs.readFile(LOG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT')
      return {
        entries: [],
        lastRun: null,
        stats: { total: 0, success: 0, skipped: 0, error: 0 },
      };
    throw err;
  }
}

async function saveSyncLog(log) {
  if (log.entries.length > 500) log.entries = log.entries.slice(-500);
  await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

async function addLogEntry(entry) {
  const log = await loadSyncLog();
  log.entries.push({ timestamp: new Date().toISOString(), ...entry });
  log.lastRun = new Date().toISOString();
  if (entry.status === 'success') log.stats.success++;
  else if (entry.status === 'skipped') log.stats.skipped++;
  else if (entry.status === 'error') log.stats.error++;
  log.stats.total++;
  await saveSyncLog(log);
}

// ----------------------------------------------------
// POMOCNÁ FUNKCE: POST na Pohoda mServer
// ----------------------------------------------------
async function pohodaRequest(xmlBody, label = 'pohoda') {
  logger.logRequest('Pohoda', 'POST', POHODA_MSERVER_URL, {
    'Content-Type': 'text/xml',
    'STW-Authorization': '***MASKED***',
  }, xmlBody);

  console.log(`[Pohoda] Posílám POST na ${POHODA_MSERVER_URL}, body ${xmlBody.length} znaků`);

  const res = await fetch(POHODA_MSERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'STW-Authorization': POHODA_AUTH,
    },
    body: xmlBody,
    signal: AbortSignal.timeout(300000), // 5 minut
  });

  console.log(`[Pohoda] HTTP status: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const text = iconv.decode(buffer, 'win1250');

  console.log(`[Pohoda] Response délka: ${text.length} znaků`);

  logger.logResponse('Pohoda', res.status, text, POHODA_MSERVER_URL);
  const dumpPath = logger.dumpResponse(label, text, 'xml');
  logger.info('Pohoda', `Raw XML response uložena: ${dumpPath}`);

  if (!res.ok) {
    throw new Error(`Pohoda mServer vrátil HTTP ${res.status}: ${text.substring(0, 300)}`);
  }

  return text;
}

// ----------------------------------------------------
// PARSOVÁNÍ XML (stripPrefix = bez namespace prefixů)
// ----------------------------------------------------
async function parseXml(xmlText) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
    mergeAttrs: false,
    ignoreAttrs: false,
  });
  return parser.parseStringPromise(xmlText);
}

// Bezpečné čtení hodnoty z parsovaného xml2js objektu
function val(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  if (obj._) return obj._; // text content s atributy
  return null;
}

// ----------------------------------------------------
// TEST PŘIPOJENÍ K POHODĚ
// ----------------------------------------------------
async function testPohodaConnection() {
  const baseUrl = POHODA_MSERVER_URL.replace(/\/xml$/, '');
  const url = `${baseUrl}/status?companyDetail`;

  const maskedPass =
    POHODA_PASS.length > 2
      ? POHODA_PASS[0] +
        '*'.repeat(POHODA_PASS.length - 2) +
        POHODA_PASS[POHODA_PASS.length - 1]
      : POHODA_PASS;

  logger.info('Pohoda', `Testuji připojení na ${url}`);
  console.log(`Použité údaje: ${POHODA_USER} : ${maskedPass}`);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'STW-Authorization': POHODA_AUTH },
    });

    if (res.status === 200) {
      const text = await res.text();
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(text);
      logger.info('Pohoda', 'Připojení úspěšné!');
      if (result.mserver && result.mserver.companyDetail) {
        const detail = result.mserver.companyDetail[0];
        console.log(
          `   Firma: ${detail.company ? detail.company[0] : 'Neznámá'}`,
        );
        console.log(
          `   Databáze: ${detail.databaseName ? detail.databaseName[0] : 'Neznámá'}`,
        );
        console.log(
          `   Účetní rok: ${detail.year ? detail.year[0] : 'Neznámý'}`,
        );
      }
    } else if (res.status === 401) {
      logger.error(
        'Pohoda',
        'CHYBA AUTENTIZACE (401): Jméno nebo heslo je špatně.',
      );
    } else if (res.status === 403) {
      logger.error('Pohoda', 'CHYBA (403): Uživatel nemá práva.');
    } else {
      logger.error('Pohoda', `mServer odpověděl kódem ${res.status}.`);
    }
  } catch (err) {
    logger.error('Pohoda', `Nepodařilo se spojit s mServerem: ${err.message}`);
  }
}

// ----------------------------------------------------
// KROK 1A: ZÍSKÁNÍ FAKTUR Z POHODY
// Pohoda ftr:filter podporuje pouze ftr:dateFrom (bez dateTo).
// Pro produkci stačí 1 den zpět - scheduler běží každých 15 minut.
// Pro dobiehání použijte --days N.
// ----------------------------------------------------
async function fetchInvoicesFromPohoda(testInvoiceNumber = null, daysBack = null) {
  const days = daysBack ?? (testInvoiceNumber ? 5 : 1);

  logger.info(
    'Pohoda',
    testInvoiceNumber
      ? `Načítám fakturu č. ${testInvoiceNumber} (hledám zpětně ${days} dní)...`
      : `Načítám faktury (poslední ${days} dny)...`,
  );

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - days);
  const dateFromStr = dateFrom.toISOString().split('T')[0];

  const reqXml = `<?xml version="1.0" encoding="UTF-8"?>
<dat:dataPack id="ExportFaktur" ico="${POHODA_ICO}" application="TopDentSync" version="2.0" note=""
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <dat:dataPackItem id="1" version="2.0">
    <lst:listInvoiceRequest version="2.0" invoiceType="issuedInvoice" invoiceVersion="2.0">
      <lst:requestInvoice>
        <ftr:filter><ftr:dateFrom>${dateFromStr}</ftr:dateFrom></ftr:filter>
      </lst:requestInvoice>
    </lst:listInvoiceRequest>
  </dat:dataPackItem>
</dat:dataPack>`;

  let xmlText;
  try {
    xmlText = await pohodaRequest(reqXml, 'invoice_export');
  } catch (err) {
    const cause = err.cause ? ` | cause: ${err.cause.message || err.cause}` : '';
    console.log(`[Pohoda] fetch error detail: ${err.message}${cause}`, err.cause || '');
    logger.error('Pohoda', `Chyba při volání mServeru: ${err.message}${cause}`);
    throw err;
  }

  let result;
  try {
    result = await parseXml(xmlText);
    logger.debug('Pohoda', 'Parsovaná struktura XML response', JSON.stringify(result, null, 2).substring(0, 2000));
  } catch (err) {
    logger.error('Pohoda', `Chyba parsování XML: ${err.message}`);
    throw new Error(`Nelze parsovat XML z Pohody: ${err.message}`);
  }

  logger.debug('Pohoda', 'Plná parsovaná XML struktura', JSON.stringify(result).substring(0, 3000));

  let invoiceItems = [];
  try {
    const pack = result.responsePack;
    if (!pack) {
      logger.error('Pohoda', 'Chybí responsePack v odpovědi', JSON.stringify(result).substring(0, 500));
      throw new Error('Chybí responsePack');
    }

    const packItem = pack.responsePackItem;
    const packItems = Array.isArray(packItem) ? packItem : [packItem];

    for (const item of packItems) {
      if (!item) continue;
      logger.debug('Pohoda', `responsePackItem state=${item.$?.state}, klíče: ${Object.keys(item).join(', ')}`);

      if (item.$?.state === 'error') {
        logger.error('Pohoda', `responsePackItem error: ${item.$?.note}`);
        continue;
      }

      const listInvoice = item.listInvoice;
      if (!listInvoice) {
        logger.warn('Pohoda', `responsePackItem neobsahuje listInvoice, klíče: ${Object.keys(item).join(', ')}`);
        continue;
      }

      const invoices = listInvoice.invoice;
      if (!invoices) {
        logger.warn('Pohoda', 'listInvoice neobsahuje žádné faktury');
        continue;
      }
      invoiceItems.push(...(Array.isArray(invoices) ? invoices : [invoices]));
    }
  } catch (err) {
    logger.error('Pohoda', `Chyba při procházení XML struktury: ${err.message}`);
    throw new Error(`Nelze extrahovat faktury z XML: ${err.message}`);
  }

  logger.info('Pohoda', `Nalezeno ${invoiceItems.length} faktur v odpovědi`);

  const invoices = invoiceItems
    .map((inv, idx) => {
      const header = inv?.invoiceHeader || inv?.['inv:invoiceHeader'] || {};
      logger.debug('Pohoda', `Faktura ${idx + 1} - klíče headeru: ${Object.keys(header).join(', ')}`);

      const numberObj = header?.number || header?.['inv:number'];
      const invoiceNumber =
        val(numberObj?.numberRequested || numberObj?.['typ:numberRequested']) ||
        val(numberObj);
      const internalId = val(header?.id || header?.['inv:id']) || inv?.$?.id;
      const numberOrder = val(header?.numberOrder || header?.['inv:numberOrder']);
      const date = val(header?.date || header?.['inv:date']);

      const linkedDocs = inv?.linkedDocuments?.link || inv?.['inv:linkedDocuments']?.['typ:link'];
      const linkedArr = linkedDocs ? (Array.isArray(linkedDocs) ? linkedDocs : [linkedDocs]) : [];
      const shipmentLink = linkedArr.find(l => {
        const agenda = val(l?.sourceAgenda || l?.['typ:sourceAgenda']);
        return agenda === 'shipments';
      });
      const pohodaShipmentNumber = shipmentLink
        ? val(shipmentLink?.sourceDocument?.number || shipmentLink?.['typ:sourceDocument']?.['typ:number'])
        : null;
      const pohodaShipmentId = shipmentLink
        ? val(shipmentLink?.sourceDocument?.id || shipmentLink?.['typ:sourceDocument']?.['typ:id'])
        : null;

      logger.debug('Pohoda', `Faktura ${idx + 1}: číslo=${invoiceNumber}, internalId=${internalId}, numberOrder=${numberOrder}, shipment=${pohodaShipmentNumber} (id=${pohodaShipmentId}), datum=${date}`);

      return {
        invoiceNumber,
        internalId,
        numberOrder,
        date,
        pohodaShipmentNumber,
        pohodaShipmentId,
        upgatesOrderId: numberOrder,
      };
    })
    .filter((inv) => {
      if (!inv.invoiceNumber) return false;
      if (testInvoiceNumber && inv.upgatesOrderId !== testInvoiceNumber && inv.invoiceNumber !== testInvoiceNumber) return false;
      return true;
    });

  logger.info(
    'Pohoda',
    `Zpracováno ${invoices.length} faktur`,
    invoices.map((i) => `${i.invoiceNumber} (upgatesId: ${i.upgatesOrderId})`).join(', '),
  );
  return invoices;
}

// ----------------------------------------------------
// KROK 1B: STAŽENÍ PDF FAKTURY Z POHODY (print request)
// ----------------------------------------------------
async function fetchInvoicePdfFromPohoda(invoiceNumber, internalId = null) {
  logger.info('Pohoda', `Načítám PDF faktury ${invoiceNumber}...`);

  // Pohoda print request - generuje PDF přes tiskový report
  // Filtrovat buď podle čísla faktury nebo interního ID
  const filterXml = internalId
    ? `<ftr:id>${internalId}</ftr:id>`
    : `<ftr:number><typ:numberRequested>${invoiceNumber}</typ:numberRequested></ftr:number>`;

  const reqXml = `<?xml version="1.0" encoding="utf-8"?>
<dat:dataPack id="PrintFaktura" ico="${POHODA_ICO}" application="TopDentSync" version="2.0" note=""
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:prn="http://www.stormware.cz/schema/version_2/print.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd">
  <dat:dataPackItem id="1" version="2.0">
    <prn:print version="1.0">
      <prn:record agenda="vydane_faktury">
        <ftr:filter>
          ${filterXml}
        </ftr:filter>
      </prn:record>
      <prn:printerSettings>
        <prn:report>
          <prn:id>190</prn:id>
        </prn:report>
        <prn:pdf>
          <prn:fileName>faktura_${invoiceNumber}.pdf</prn:fileName>
        </prn:pdf>
      </prn:printerSettings>
    </prn:print>
  </dat:dataPackItem>
</dat:dataPack>`;

  let xmlText;
  try {
    xmlText = await pohodaRequest(reqXml, `invoice_pdf_${invoiceNumber}`);
  } catch (err) {
    logger.error(
      'Pohoda',
      `Chyba při print requestu pro fakturu ${invoiceNumber}: ${err.message}`,
    );
    return null; // PDF není kritické, synchronizaci nevybočíme
  }

  // Parsování - hledáme Base64 PDF v response
  let result;
  try {
    result = await parseXml(xmlText);
  } catch (err) {
    logger.error('Pohoda', `Chyba parsování print response: ${err.message}`);
    return null;
  }

  // Zpracování odpovědi - Hledáme fyzickou cestu pomocí RegEx (nejspolehlivější)
  const pathMatch = xmlText.match(/<rdc:valueProduced[^>]*>(.*?)<\/rdc:valueProduced>/);
  if (pathMatch && pathMatch[1]) {
    const pdfPath = pathMatch[1].trim();
    const fs = require('fs');
    logger.info('Pohoda', `Načítám exportované PDF z lokálního disku (RegEx detekce): ${pdfPath}`);
    if (fs.existsSync(pdfPath)) {
      const fileBuffer = fs.readFileSync(pdfPath);
      logger.info('Pohoda', `Místní PDF úspěšně nahráno (${fileBuffer.length} bytes)`);
      return fileBuffer.toString('base64');
    } else {
      logger.error('Pohoda', `Soubor fyzicky nenalezen na udané cestě disku: ${pdfPath}`);
    }
  }

  // Fallback na starý JSON base64 traversal
  try {
    const dataPack = result.dataPack || result['dat:dataPack'] || result['rsp:responsePack'];
    const dataPackItem = dataPack?.dataPackItem || dataPack?.['dat:dataPackItem'] || dataPack?.['rsp:responsePackItem'];
    const items = Array.isArray(dataPackItem) ? dataPackItem : [dataPackItem];

    for (const item of items) {
      if (!item) continue;

      // 1. Očekávaná struktura vracející absolutní cestu k uloženému PDF na mServeru
      let pdfPath = null;
      
      // RegEx záchrana (nejspolehlivější u XML -> JSON knihoven, které balí do neznámých polí)
      const pathMatch = xmlText.match(/<rdc:valueProduced[^>]*>(.*?)<\/rdc:valueProduced>/);
      if (pathMatch && pathMatch[1]) {
        pdfPath = pathMatch[1];
      }

      if (pdfPath && typeof pdfPath === 'string') {
        const fs = require('fs');
        logger.info('Pohoda', `Načítám PDF vrácené napřímo z disku mServeru: ${pdfPath}`);
        if (fs.existsSync(pdfPath)) {
          const fileBuffer = fs.readFileSync(pdfPath);
          logger.info('Pohoda', `Místní PDF úspěšně nahráno (${fileBuffer.length} bytes)`);
          return fileBuffer.toString('base64');
        } else {
          logger.error('Pohoda', `Systémový export soubor nenalezen na disku: ${pdfPath}`);
        }
      }

      // 2. Fallback pro Base64 přikládán uvnitř XML (Pohoda verze podpora)
      const attachment = item.attachment || item['dat:attachment'];
      if (attachment) {
        const base64 = typeof attachment === 'object' ? attachment.data || attachment.content || attachment._ : attachment;
        if (base64) return String(base64).replace(/\s/g, ''); 
      }
      
      const printResponse = item.printResponse || item.responsePackItem?.printResponse;
      if (printResponse) {
        const pdfData = printResponse.pdf?.data || printResponse.pdfData || printResponse._;
        if (pdfData) return String(pdfData).replace(/\s/g, '');
      }
    }

    logger.warn('Pohoda', `PDF faktury ${invoiceNumber} se nepodařilo extrahovat z XML ani z disku.`);
    return null;
  } catch (err) {
    logger.error('Pohoda', `Interní chyba při extrakci PDF: ${err.message}`);
    return null;
  }
}

// ----------------------------------------------------
// KROK 2B: SESTAVENÍ CACHE TRACKING KÓDŮ Z BALIKOBOTU
// Balikobot eshop_id = "{pohodaShipmentId}-B" → carrier_id = tracking kód dopravce
// Funguje pro všechny dopravce (CP, PPL, DPD, Zásilkovna, GLS, ...)
// ----------------------------------------------------
async function buildBalikobotTrackingCache() {
  logger.info('Balikobot', 'Sestavuji cache tracking kódů z Balikobotu...');
  const cache = {}; // eshop_id -> carrier_id

  // Získat seznam dopravců
  let carriers = [];
  try {
    const res = await fetch(`${BB_API_BASE}/info/carriers`, {
      headers: BB_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    carriers = data.carriers || [];
  } catch (err) {
    logger.error('Balikobot', `Nelze načíst seznam dopravců: ${err.message}`);
    return cache;
  }

  // Pro každého dopravce: overview (aktuální batch) + orderview (poslední odeslaný batch)
  await Promise.allSettled(carriers.map(async (carrier) => {
    try {
      // 1. Overview: aktuální neodeslaný batch - eshop_id přímo dostupné
      const ovRes = await fetch(`${BB_API_BASE}/${carrier.slug}/overview`, {
        headers: BB_HEADERS,
        signal: AbortSignal.timeout(5000),
      });
      if (ovRes.ok) {
        const ovData = await ovRes.json();
        const packages = ovData.packages || ovData.data || [];
        for (const pkg of packages) {
          if (pkg.eshop_id && pkg.carrier_id) cache[pkg.eshop_id] = pkg.carrier_id;
        }
      }
    } catch (_) { /* ignore */ }

    try {
      // 2. Orderview: poslední odeslaná dávka → načíst detaily každého balíčku
      const orRes = await fetch(`${BB_API_BASE}/${carrier.slug}/orderview`, {
        headers: BB_HEADERS,
        signal: AbortSignal.timeout(5000),
      });
      if (!orRes.ok) return;
      const orData = await orRes.json();
      logger.debug('Balikobot', `${carrier.slug}/orderview: status=${orData.status} keys=${Object.keys(orData).join(',')}`);
      if (orData.status !== 200 || !orData.package_ids?.length) return;

      const pkgResults = await Promise.allSettled(
        orData.package_ids.slice(0, 500).map(pkgId =>
          fetch(`${BB_API_BASE}/${carrier.slug}/package/${pkgId}`, {
            headers: BB_HEADERS,
            signal: AbortSignal.timeout(5000),
          }).then(r => r.json())
        )
      );
      for (const result of pkgResults) {
        if (result.status === 'fulfilled') {
          const pkg = result.value;
          if (pkg.eshop_id && pkg.carrier_id) cache[pkg.eshop_id] = pkg.carrier_id;
        }
      }
    } catch (_) { /* ignore */ }
  }));

  logger.info('Balikobot', `Cache sestavena: ${Object.keys(cache).length} balíčků`);
  return cache;
}

// Lookup tracking kódu z cache podle Pohoda shipment ID
// eshop_id v Balikobotu = "{pohodaShipmentId}-B"
function getTrackingFromCache(pohodaShipmentId, cache) {
  if (!pohodaShipmentId) return null;
  return cache[`${pohodaShipmentId}-B`] || null;
}

// KROK 3A: AKTUALIZACE TRACKING KÓDU V UPGATES
// PUT /orders s polem orders - správný formát Upgates API v2
// Endpoint: PUT /orders, body: {"orders": [{"order_number": "...", "tracking_code": "..."}]}
// ----------------------------------------------------
async function updateUpgatesTracking(upgatesOrderId, trackingCode) {
  logger.info('Upgates', `Ukládám tracking kód ${trackingCode} k objednávce ${upgatesOrderId}...`);

  const updateUrl = `${UPGATES_URL}/orders`;
  const body = JSON.stringify({ orders: [{ order_number: String(upgatesOrderId), tracking_code: trackingCode }] });

  logger.logRequest('Upgates', 'PUT', updateUrl, { Authorization: '***MASKED***' }, body);

  const res = await fetch(updateUrl, {
    method: 'PUT',
    headers: { Authorization: UPGATES_AUTH, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15000),
  });

  const resText = await res.text();
  logger.logResponse('Upgates', res.status, resText, updateUrl);
  logger.dumpResponse('upgates_tracking', resText, 'json');

  if (!res.ok) {
    throw new Error(`Upgates PUT /orders vrátil HTTP ${res.status}: ${resText.substring(0, 300)}`);
  }

  // Zkontrolovat updated_yn v response
  try {
    const data = JSON.parse(resText);
    const orderResult = data.orders?.[0];
    if (orderResult && !orderResult.updated_yn) {
      const msgs = orderResult.messages?.map(m => m.message).join(', ') || 'unknown';
      throw new Error(`Upgates neaktualizoval objednávku ${upgatesOrderId}: ${msgs}`);
    }
  } catch (parseErr) {
    if (parseErr.message.includes('neaktualizoval')) throw parseErr;
    // JSON parse chyba - ignorujeme, HTTP 200 stačí
  }

  logger.info('Upgates', `Tracking kód ${trackingCode} úspěšně uložen k objednávce ${upgatesOrderId}`);
  return true;
}

// ----------------------------------------------------
// KROK 3B: NAHRÁNÍ PDF FAKTURY DO UPGATES
// Zkouší endpoint pro přidání souboru k objednávce.
// Přesný formát zjistíme z logů - Upgates API docs jsou
// dynamicky renderované, endpoint zjistíme z response.
// ----------------------------------------------------
async function uploadPdfToUpgates(upgatesOrderId, pdfBase64, invoiceNumber) {
  if (!pdfBase64) {
    logger.warn(
      'Upgates',
      `PDF faktury ${invoiceNumber} není k dispozici, přeskakuji upload`,
    );
    return false;
  }

  logger.info(
    'Upgates',
    `Nahrávám PDF faktury ${invoiceNumber} k objednávce ${upgatesOrderId}...`,
  );

  // Pokus 1: PUT /orders (V Upgates API v2 se vše updatuje hromadně přes 'orders' pole)
  const url = `${UPGATES_URL}/orders`;
  const body = JSON.stringify({
    orders: [
      {
        order_number: upgatesOrderId,
        files: [
          {
            title: `Faktura ${invoiceNumber}`,
            file_name: `Faktura_${invoiceNumber}.pdf`,
            file_content: pdfBase64
          }
        ]
      }
    ]
  });

  logger.logRequest(
    'Upgates',
    'PUT',
    url,
    { Authorization: '***MASKED***', 'Content-Type': 'application/json' },
    `(body: ${body.length} bytes)`,
  );

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: UPGATES_AUTH,
      'Content-Type': 'application/json',
    },
    body,
  });

  const resText = await res.text();
  logger.logResponse('Upgates', res.status, resText, url);
  logger.dumpResponse('upgates_pdf_upload', resText, 'json');

  if (res.ok) {
    logger.info(
      'Upgates',
      `PDF faktury ${invoiceNumber} úspěšně nahráno k objednávce ${upgatesOrderId} přes 'files' pole`,
    );
    return true;
  }

  // Pokud selže na první parametr, API Upgates v2 může vyžadovat 'documents' klíč.
  logger.warn(
    'Upgates',
    `/orders endpoint vrátil ${res.status} pro files, tělo chyby: ${resText}`,
  );
  
  const url2 = `${UPGATES_URL}/orders`;
  const body2 = JSON.stringify({
    orders: [
      {
        order_number: upgatesOrderId,
        documents: [
          {
            title: `Faktura ${invoiceNumber}`,
            file_name: `Faktura_${invoiceNumber}.pdf`,
            file_content: pdfBase64
          }
        ]
      }
    ]
  });

  const res2 = await fetch(url2, {
    method: 'PUT',
    headers: {
      Authorization: UPGATES_AUTH,
      'Content-Type': 'application/json',
    },
    body: body2,
  });

  const resText2 = await res2.text();
  logger.logResponse('Upgates', res2.status, resText2, url2);
  logger.dumpResponse('upgates_documents', resText2, 'json');

  if (res2.ok) {
    logger.info('Upgates', `PDF úspěšně nahráno přes 'documents' pole`);
    return true;
  }

  logger.error(
    'Upgates',
    `Ani 'files' ani 'documents' pole nefungovalo pro aktualizaci. Chyba druhého pokusu: ${resText2}`,
  );
  return false;
}

// ----------------------------------------------------
// HLAVNÍ SYNCHRONIZAČNÍ CYKLUS
// ----------------------------------------------------
async function runSync(testOrderId = null, daysBack = null) {
  console.log(`[runSync] START testOrderId=${testOrderId || 'null'}`);
  if (testOrderId) {
    logger.info('Sync', `===== TESTOVACÍ REŽIM: faktura ${testOrderId} =====`);
    console.log(`\n======================================================`);
    console.log(`  TESTOVACÍ REŽIM - FAKTURA: ${testOrderId}`);
    console.log(`  Logy: logs/sync.log | Debug: logs/sync_debug.log`);
    console.log(`  Raw XML: logs/pohoda_responses/`);
    console.log(`======================================================\n`);
  } else {
    logger.info('Sync', '===== Standardní synchronizační cyklus =====');
  }

  const db = await loadDb();

  try {
    // KROK 1: Faktury z Pohody
    let invoices = await fetchInvoicesFromPohoda(testOrderId || null, daysBack);

    if (testOrderId && invoices.length === 0) {
      logger.error(
        'Sync',
        `Faktura ${testOrderId} nenalezena v Pohodě! Zkontroluj dump XML v logs/pohoda_responses/`,
      );
      await addLogEntry({
        type: 'test',
        status: 'error',
        invoiceNumber: testOrderId,
        message: 'Faktura nenalezena v Pohodě',
      });
      return;
    }

    if (!testOrderId) {
      // Prořezat staré záznamy:
      // - úspěšné (string datum) expirují po 7 dnech
      // - přeskočené (objekt {skipped, until}) expirují po 2 hodinách
      const now = Date.now();
      const successCutoff = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
      for (const [k, v] of Object.entries(db.processed)) {
        if (typeof v === 'string' && v < successCutoff) delete db.processed[k];
        else if (v && typeof v === 'object' && v.skipped && now > v.until) delete db.processed[k];
      }

      // V produkci přeskočit již zpracované (O(1) lookup)
      invoices = invoices.filter((inv) => {
        const rec = db.processed[inv.invoiceNumber];
        if (!rec) return true;
        if (typeof rec === 'string') return false; // úspěšně zpracované
        if (rec.skipped && now < rec.until) return false; // čeká na retry
        return true;
      });
      logger.info(
        'Sync',
        `${invoices.length} faktur čeká na zpracování (po odfiltrování zpracovaných)`,
      );
    }

    if (invoices.length === 0) {
      logger.info('Sync', 'Žádné nové faktury ke zpracování');
      return;
    }

    // KROK 2: Sestavit Balikobot tracking cache (jednou pro celý sync)
    const trackingCache = await buildBalikobotTrackingCache();

    // KROK 3: Zpracování každé faktury
    for (const inv of invoices) {
      logger.info('Sync', `--- Faktura: ${inv.invoiceNumber} | objednávka: ${inv.upgatesOrderId} | zásilka: ${inv.pohodaShipmentNumber || 'není'} ---`);

      if (!inv.upgatesOrderId) {
        logger.warn('Sync', `Faktura ${inv.invoiceNumber} nemá číslo objednávky (numberOrder) - přeskakuji`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'error', invoiceNumber: inv.invoiceNumber, message: 'Chybí číslo objednávky (numberOrder)' });
        continue;
      }

      if (!inv.pohodaShipmentId) {
        logger.info('Sync', `Faktura ${inv.invoiceNumber} nemá zásilku - objednávka pravděpodobně ještě nebyla expedována`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'skipped', invoiceNumber: inv.invoiceNumber, message: 'Zásilka zatím není vytvořena v Pohodě' });
        continue;
      }

      logger.info('Sync', `Zásilka v Pohodě: ${inv.pohodaShipmentNumber} (ID: ${inv.pohodaShipmentId})`);

      // Tracking kód z Balikobotu (eshop_id = "{pohodaShipmentId}-B" → carrier_id)
      const trackingCode = getTrackingFromCache(inv.pohodaShipmentId, trackingCache);
      if (!trackingCode) {
        logger.warn('Sync', `Faktura ${inv.invoiceNumber}: zásilka ${inv.pohodaShipmentId} nenalezena v Balikobotu - přeskakuji (retry za 2h)`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'skipped', invoiceNumber: inv.invoiceNumber, message: `Zásilka ${inv.pohodaShipmentId} nenalezena v Balikobotu` });
        if (!testOrderId) {
          db.processed[inv.invoiceNumber] = { skipped: true, until: Date.now() + 2 * 3600 * 1000 };
          await saveDb(db);
        }
        continue;
      }
      logger.info('Sync', `Tracking kód z Balikobotu: ${trackingCode}`);

      // Odeslat do Upgates
      let trackingOk = false;
      try {
        trackingOk = await updateUpgatesTracking(inv.upgatesOrderId, trackingCode);
      } catch (err) {
        logger.error('Sync', `Chyba při ukládání tracking kódu do Upgates: ${err.message}`);
      }

      if (trackingOk) {
        if (!testOrderId) {
          db.processed[inv.invoiceNumber] = new Date().toISOString();
          await saveDb(db);
        }
        logger.info('Sync', `Faktura ${inv.invoiceNumber} zpracována. Tracking: ${trackingCode}`);
        await addLogEntry({
          type: testOrderId ? 'test' : 'sync',
          status: 'success',
          invoiceNumber: inv.invoiceNumber,
          trackingCode,
          message: `Tracking ${trackingCode} úspěšně uložen do Upgates (objednávka ${inv.upgatesOrderId}).`,
        });
      } else {
        logger.error('Sync', `Faktura ${inv.invoiceNumber} - tracking kód se nepodařilo uložit do Upgates!`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'error', invoiceNumber: inv.invoiceNumber, message: 'Chyba při ukládání tracking kódu do Upgates' });
      }
    }
  } catch (err) {
    logger.error(
      'Sync',
      `Kritická chyba synchronizace: ${err.message}`,
      err.stack,
    );
    await addLogEntry({ type: 'sync', status: 'error', message: err.message });
  }

  logger.info('Sync', '===== Synchronizační cyklus dokončen =====');
}

// ----------------------------------------------------
// SPUŠTĚNÍ Z PŘÍKAZOVÉ ŘÁDKY
// ----------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const testPohodaIndex = args.indexOf('--test-pohoda');
  const testFlagIndex = args.indexOf('--test');
  const daysFlagIndex = args.indexOf('--days');
  const daysArg = daysFlagIndex !== -1 && args[daysFlagIndex + 1] ? parseInt(args[daysFlagIndex + 1], 10) : null;

  if (testPohodaIndex !== -1) {
    testPohodaConnection();
  } else if (testFlagIndex !== -1 && args[testFlagIndex + 1]) {
    runSync(args[testFlagIndex + 1], daysArg);
  } else {
    runSync(null, daysArg);
  }
}

module.exports = { runSync, testPohodaConnection, loadSyncLog, loadDb };
