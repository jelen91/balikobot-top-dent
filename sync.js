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

// ----------------------------------------------------
// DATABÁZE PRO UCHOVÁNÍ ZPRACOVANÝCH FAKTUR
// ----------------------------------------------------
const DB_FILE = path.join(__dirname, 'processed_invoices.json');
const LOG_FILE = path.join(__dirname, 'sync_log.json');

async function loadDb() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return { processed: [] };
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
// Pokud je zadáno testInvoiceNumber, filtruje podle čísla
// ----------------------------------------------------
async function fetchInvoicesFromPohoda(testInvoiceNumber = null) {
  logger.info(
    'Pohoda',
    testInvoiceNumber
      ? `Načítám fakturu č. ${testInvoiceNumber} z Pohoda mServeru...`
      : 'Načítám faktury (poslední 3 dny) z Pohoda mServeru...',
  );

  // Filtr podle data - posledních 7 dní (pro test i produkci)
  // Filtrování na konkrétní fakturu probíhá v JS po stažení
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - 1); // 1 den pro test
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
        <ftr:filter>
          <ftr:dateFrom>${dateFromStr}</ftr:dateFrom>
        </ftr:filter>
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

  // Parsování XML response
  let result;
  try {
    result = await parseXml(xmlText);
    logger.debug(
      'Pohoda',
      'Parsovaná struktura XML response',
      JSON.stringify(result, null, 2).substring(0, 2000),
    );
  } catch (err) {
    logger.error('Pohoda', `Chyba parsování XML: ${err.message}`);
    throw new Error(`Nelze parsovat XML z Pohody: ${err.message}`);
  }

  // Logujeme celou strukturu pro debug - klíčové pro zjištění správné cesty
  logger.debug(
    'Pohoda',
    'Plná parsovaná XML struktura',
    JSON.stringify(result).substring(0, 3000),
  );

  let invoiceItems = [];
  try {
    // Response: responsePack > responsePackItem > listInvoice > invoice
    const pack = result.responsePack;
    if (!pack) {
      logger.error(
        'Pohoda',
        'Chybí responsePack v odpovědi',
        JSON.stringify(result).substring(0, 500),
      );
      throw new Error('Chybí responsePack');
    }

    const packItem = pack.responsePackItem;
    const packItems = Array.isArray(packItem) ? packItem : [packItem];

    for (const item of packItems) {
      if (!item) continue;
      logger.debug(
        'Pohoda',
        `responsePackItem state=${item.$?.state}, klíče: ${Object.keys(item).join(', ')}`,
      );

      if (item.$?.state === 'error') {
        logger.error('Pohoda', `responsePackItem error: ${item.$?.note}`);
        continue;
      }

      // listInvoice obsahuje invoice položky
      const listInvoice = item.listInvoice;
      if (!listInvoice) {
        logger.warn(
          'Pohoda',
          `responsePackItem neobsahuje listInvoice, klíče: ${Object.keys(item).join(', ')}`,
        );
        continue;
      }

      logger.debug(
        'Pohoda',
        `listInvoice klíče: ${Object.keys(listInvoice).join(', ')}`,
      );
      const invoices = listInvoice.invoice;
      if (!invoices) {
        logger.warn('Pohoda', 'listInvoice neobsahuje žádné faktury');
        continue;
      }
      const arr = Array.isArray(invoices) ? invoices : [invoices];
      invoiceItems.push(...arr);
    }
  } catch (err) {
    logger.error(
      'Pohoda',
      `Chyba při procházení XML struktury: ${err.message}`,
    );
    throw new Error(`Nelze extrahovat faktury z XML: ${err.message}`);
  }

  logger.info('Pohoda', `Nalezeno ${invoiceItems.length} faktur v odpovědi`);

  // Extrahovat data z každé faktury
  const invoices = invoiceItems
    .map((inv, idx) => {
      const header = inv?.invoiceHeader || inv?.['inv:invoiceHeader'] || {};
      logger.debug(
        'Pohoda',
        `Faktura ${idx + 1} - klíče headeru: ${Object.keys(header).join(', ')}`,
      );

      // Číslo faktury v Pohodě (např. 261204643)
      const numberObj = header?.number || header?.['inv:number'];
      const invoiceNumber =
        val(numberObj?.numberRequested || numberObj?.['typ:numberRequested']) ||
        val(numberObj);

      // Interní ID záznamu v Pohodě (pro PDF print request)
      const internalId = val(header?.id || header?.['inv:id']) || inv?.$?.id;

      // Číslo objednávky z e-shopu = inv:numberOrder (= Upgates order code)
      const numberOrder = val(header?.numberOrder || header?.['inv:numberOrder']);

      // Datum
      const date = val(header?.date || header?.['inv:date']);

      // Zásilka provázaná s fakturou (inv:linkedDocuments > shipments)
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
        invoiceNumber,       // číslo faktury v Pohodě (261204643)
        internalId,          // interní ID záznamu pro PDF print
        numberOrder,         // číslo objednávky z e-shopu = Upgates order ID (2604411)
        date,
        pohodaShipmentNumber, // číslo zásilky v Pohodě (26Ez04768)
        pohodaShipmentId,     // interní ID zásilky pro fetch trackingu
        upgatesOrderId: numberOrder, // párujeme podle čísla objednávky
      };
    })
    .filter((inv) => inv.invoiceNumber); // vyfiltrovat faktury bez čísla

  logger.info(
    'Pohoda',
    `Zpracováno ${invoices.length} faktur`,
    invoices
      .map((i) => `${i.invoiceNumber} (upgatesId: ${i.upgatesOrderId})`)
      .join(', '),
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
    ? `<prn:id>${internalId}</prn:id>`
    : `<prn:number><typ:numberRequested>${invoiceNumber}</typ:numberRequested></prn:number>`;

  const reqXml = `<?xml version="1.0" encoding="utf-8"?>
<dat:dataPack id="PrintFaktura" ico="${POHODA_ICO}" application="TopDentSync" version="2.0"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:prn="http://www.stormware.cz/schema/version_2/print.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <dat:dataPackItem id="1" version="2.0">
    <prn:print version="2.0">
      <prn:record agenda="vydane_faktury">
        <prn:filter>
          ${filterXml}
        </prn:filter>
      </prn:record>
      <prn:printerSettings>
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

  // Hledáme 'attachment' element s Base64 PDF
  try {
    const xmlStr = JSON.stringify(result);
    // Pokud response obsahuje attachment, logujeme a extrahujeme
    if (xmlStr.includes('attachment') || xmlStr.includes('pdf')) {
      logger.debug(
        'Pohoda',
        'Print response obsahuje attachment/pdf klíče',
        xmlStr.substring(0, 1000),
      );
    } else {
      logger.warn(
        'Pohoda',
        'Print response NEOBSAHUJE attachment ani pdf - vypisuji chybové XML do konzole:',
      );
      console.log('\n--- POHODA XML ODPOVĚĎ ---');
      console.log(xmlText);
      console.log('--------------------------\n');
      return null;
    }

    // Pokus o extrakci Base64 z různých možných cest v XML
    const dataPack = result.dataPack || result['dat:dataPack'];
    const dataPackItem =
      dataPack?.dataPackItem || dataPack?.['dat:dataPackItem'];
    const items = Array.isArray(dataPackItem) ? dataPackItem : [dataPackItem];

    for (const item of items) {
      // Pohoda vrací PDF jako: responsePackItem > printResponse > pdf > data (base64)
      // nebo jako dat:attachment
      const attachment = item?.attachment || item?.['dat:attachment'];
      if (attachment) {
        const base64 =
          val(attachment) || attachment?.data || attachment?.content;
        if (base64) {
          logger.info(
            'Pohoda',
            `PDF faktury ${invoiceNumber} úspěšně staženo (${String(base64).length} chars base64)`,
          );
          return String(base64).replace(/\s/g, ''); // odstranit whitespace
        }
      }

      const printResponse =
        item?.printResponse || item?.responsePackItem?.printResponse;
      if (printResponse) {
        logger.debug(
          'Pohoda',
          'Nalezen printResponse element',
          JSON.stringify(printResponse).substring(0, 500),
        );
        const pdfData =
          printResponse?.pdf?.data ||
          printResponse?.pdfData ||
          printResponse?._;
        if (pdfData) {
          logger.info(
            'Pohoda',
            `PDF faktury ${invoiceNumber} staženo z printResponse`,
          );
          return String(pdfData).replace(/\s/g, '');
        }
      }
    }

    logger.warn(
      'Pohoda',
      `PDF faktury ${invoiceNumber} se nepodařilo extrahovat - zkontroluj dump soubor logs/pohoda_responses/`,
    );
    return null;
  } catch (err) {
    logger.error('Pohoda', `Chyba při extrakci PDF: ${err.message}`);
    return null;
  }
}

// ----------------------------------------------------
// KROK 3A: AKTUALIZACE TRACKING KÓDU V UPGATES
// ----------------------------------------------------
async function updateUpgatesTracking(upgatesOrderId, trackingCode, _carrier) {
  logger.info(
    'Upgates',
    `Ukládám tracking kód ${trackingCode} k objednávce ${upgatesOrderId}...`,
  );

  const url = `${UPGATES_URL}/orders`;
  const body = JSON.stringify({
    orders: [
      {
        order_number: upgatesOrderId,
        tracking_code: trackingCode,
      }
    ]
  });

  logger.logRequest(
    'Upgates',
    'PUT',
    url,
    { Authorization: '***MASKED***', 'Content-Type': 'application/json' },
    body,
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
  logger.dumpResponse('upgates_tracking', resText, 'json');

  if (!res.ok) {
    throw new Error(
      `Upgates PUT /orders/${upgatesOrderId} vrátil HTTP ${res.status}: ${resText.substring(0, 300)}`,
    );
  }

  logger.info(
    'Upgates',
    `Tracking kód ${trackingCode} úspěšně uložen k objednávce ${upgatesOrderId}`,
  );
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

  // Pokus 1: POST na /orders/{id}/files (JSON s base64)
  const url = `${UPGATES_URL}/orders/${encodeURIComponent(upgatesOrderId)}/files`;
  const body = JSON.stringify({
    name: `Faktura_${invoiceNumber}.pdf`,
    file_name: `Faktura_${invoiceNumber}.pdf`,
    content: pdfBase64,
    file_content: pdfBase64,
    type: 'invoice',
    title: `Faktura ${invoiceNumber}`,
  });

  logger.logRequest(
    'Upgates',
    'POST',
    url,
    { Authorization: '***MASKED***', 'Content-Type': 'application/json' },
    `(body: ${body.length} bytes)`,
  );

  const res = await fetch(url, {
    method: 'POST',
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
      `PDF faktury ${invoiceNumber} úspěšně nahráno k objednávce ${upgatesOrderId}`,
    );
    return true;
  }

  // Pokud selže, zkusíme /documents endpoint
  logger.warn(
    'Upgates',
    `/files endpoint vrátil ${res.status}, zkouším /documents...`,
  );
  const url2 = `${UPGATES_URL}/orders/${encodeURIComponent(upgatesOrderId)}/documents`;
  const res2 = await fetch(url2, {
    method: 'POST',
    headers: {
      Authorization: UPGATES_AUTH,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `Faktura ${invoiceNumber}`,
      file_name: `Faktura_${invoiceNumber}.pdf`,
      file_content: pdfBase64,
    }),
  });
  const resText2 = await res2.text();
  logger.logResponse('Upgates', res2.status, resText2, url2);
  logger.dumpResponse('upgates_documents', resText2, 'json');

  if (res2.ok) {
    logger.info('Upgates', `PDF úspěšně nahráno přes /documents endpoint`);
    return true;
  }

  logger.error(
    'Upgates',
    `Ani /files ani /documents endpoint nefungoval. Zkontroluj dump soubory v logs/pohoda_responses/`,
  );
  return false;
}

// ----------------------------------------------------
// HLAVNÍ SYNCHRONIZAČNÍ CYKLUS
// ----------------------------------------------------
async function runSync(testOrderId = null) {
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
    let invoices = await fetchInvoicesFromPohoda(testOrderId || null);

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
      // V produkci přeskočit již zpracované
      invoices = invoices.filter(
        (inv) => !db.processed.includes(inv.invoiceNumber),
      );
      logger.info(
        'Sync',
        `${invoices.length} faktur čeká na zpracování (po odfiltrování zpracovaných)`,
      );
    }

    if (invoices.length === 0) {
      logger.info('Sync', 'Žádné nové faktury ke zpracování');
      return;
    }

    // KROK 2: Zpracování každé faktury
    for (const inv of invoices) {
      logger.info('Sync', `--- Faktura: ${inv.invoiceNumber} | objednávka: ${inv.upgatesOrderId} | zásilka: ${inv.pohodaShipmentNumber || 'není'} ---`);

      if (!inv.upgatesOrderId) {
        logger.warn('Sync', `Faktura ${inv.invoiceNumber} nemá číslo objednávky (numberOrder) - přeskakuji`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'error', invoiceNumber: inv.invoiceNumber, message: 'Chybí číslo objednávky (numberOrder)' });
        continue;
      }

      // Tracking číslo bereme přímo z Pohody (linkedDocuments > shipments)
      if (!inv.pohodaShipmentNumber) {
        logger.info('Sync', `Faktura ${inv.invoiceNumber} nemá zásilku - objednávka pravděpodobně ještě nebyla expedována`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'skipped', invoiceNumber: inv.invoiceNumber, message: 'Zásilka zatím není vytvořena v Pohodě' });
        continue;
      }

      logger.info('Sync', `Tracking kód z Pohody: ${inv.pohodaShipmentNumber}`);

      // Stáhnout PDF faktury z Pohody
      const pdfBase64 = await fetchInvoicePdfFromPohoda(inv.invoiceNumber, inv.internalId);

      // Odeslat do Upgates
      let trackingOk = false;
      let pdfOk = false;

      try {
        trackingOk = await updateUpgatesTracking(inv.upgatesOrderId, inv.pohodaShipmentNumber, null);
      } catch (err) {
        logger.error('Sync', `Chyba při ukládání tracking kódu do Upgates: ${err.message}`);
      }

      if (pdfBase64) {
        pdfOk = await uploadPdfToUpgates(inv.upgatesOrderId, pdfBase64, inv.invoiceNumber);
      }

      if (trackingOk) {
        if (!testOrderId) {
          db.processed.push(inv.invoiceNumber);
          await saveDb(db);
        }
        logger.info('Sync', `Faktura ${inv.invoiceNumber} zpracována. Tracking: OK, PDF: ${pdfBase64 ? (pdfOk ? 'OK' : 'CHYBA') : 'nedostupné'}`);
        await addLogEntry({
          type: testOrderId ? 'test' : 'sync',
          status: 'success',
          invoiceNumber: inv.invoiceNumber,
          trackingCode: inv.pohodaShipmentNumber,
          message: `Tracking ${inv.pohodaShipmentNumber} uložen. PDF: ${pdfBase64 ? (pdfOk ? 'nahráno' : 'chyba uploadu') : 'nedostupné z Pohody'}`,
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

  if (testPohodaIndex !== -1) {
    testPohodaConnection();
  } else if (testFlagIndex !== -1 && args[testFlagIndex + 1]) {
    runSync(args[testFlagIndex + 1]);
  } else {
    runSync();
  }
}

module.exports = { runSync, testPohodaConnection, loadSyncLog, loadDb };
