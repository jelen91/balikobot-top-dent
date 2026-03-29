require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const xml2js = require('xml2js');
const iconv = require('iconv-lite');
const logger = require('./logger');

// ----------------------------------------------------
// KONFIGURACE
// ----------------------------------------------------
const POHODA_MSERVER_URL = process.env.POHODA_MSERVER_URL || 'http://localhost:7778/xml';
const POHODA_ICO = process.env.POHODA_ICO || '12345678';
const POHODA_USER = process.env.POHODA_USER || 'Admin';
const POHODA_PASS = process.env.POHODA_PASS || '';
const POHODA_AUTH = 'Basic ' + Buffer.from(`${POHODA_USER}:${POHODA_PASS}`).toString('base64');

const BALIKOBOT_API_USER = process.env.BALIKOBOT_API_USER || 'top-dentcz';
const BALIKOBOT_API_KEY = process.env.BALIKOBOT_API_KEY || '';
const BALIKOBOT_BASE_URL = 'https://apiv2.balikobot.cz';
const BALIKOBOT_AUTH = 'Basic ' + Buffer.from(`${BALIKOBOT_API_USER}:${BALIKOBOT_API_KEY}`).toString('base64');

const UPGATES_URL = (process.env.UPGATES_URL || 'https://topdent.admin.s5.upgates.com/api/v2').replace(/\/$/, '');
const UPGATES_USER = process.env.UPGATES_USER || '';
const UPGATES_SECRET = process.env.UPGATES_SECRET || '';
const UPGATES_AUTH = 'Basic ' + Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');

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
    if (err.code === 'ENOENT') return { entries: [], lastRun: null, stats: { total: 0, success: 0, skipped: 0, error: 0 } };
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
    'Content-Type': 'application/xml',
    'STW-Authorization': '***MASKED***',
  }, xmlBody);

  const res = await fetch(POHODA_MSERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'STW-Authorization': POHODA_AUTH,
    },
    body: xmlBody,
    signal: AbortSignal.timeout(30000), // 30s timeout
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  // Pohoda vrací Windows-1250, dekódujeme správně
  let text;
  try {
    text = iconv.decode(buffer, 'win1250');
  } catch {
    text = buffer.toString('utf8');
  }

  logger.logResponse('Pohoda', res.status, text, POHODA_MSERVER_URL);

  // Vždy uložit raw response pro debug
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

  const maskedPass = POHODA_PASS.length > 2
    ? POHODA_PASS[0] + '*'.repeat(POHODA_PASS.length - 2) + POHODA_PASS[POHODA_PASS.length - 1]
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
        console.log(`   Firma: ${detail.company ? detail.company[0] : 'Neznámá'}`);
        console.log(`   Databáze: ${detail.databaseName ? detail.databaseName[0] : 'Neznámá'}`);
        console.log(`   Účetní rok: ${detail.year ? detail.year[0] : 'Neznámý'}`);
      }
    } else if (res.status === 401) {
      logger.error('Pohoda', 'CHYBA AUTENTIZACE (401): Jméno nebo heslo je špatně.');
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
  logger.info('Pohoda', testInvoiceNumber
    ? `Načítám fakturu č. ${testInvoiceNumber} z Pohoda mServeru...`
    : 'Načítám faktury (poslední 3 dny) z Pohoda mServeru...'
  );

  // Filtr - buď konkrétní faktura, nebo posledních 3 dny
  let filterXml;
  if (testInvoiceNumber) {
    filterXml = `<ftr:number><typ:numberRequested>${testInvoiceNumber}</typ:numberRequested></ftr:number>`;
  } else {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 3);
    const dateFromStr = dateFrom.toISOString().split('T')[0];
    filterXml = `
      <ftr:dateFrom>${dateFromStr}</ftr:dateFrom>
      <ftr:invoiceType>issuedInvoice</ftr:invoiceType>`;
  }

  const reqXml = `<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack id="ExportFaktur" ico="${POHODA_ICO}" application="TopDentSync" version="1.0" note=""
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lInv="http://www.stormware.cz/schema/version_2/list_invoice.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <dat:dataPackItem id="1" version="1.0">
    <lInv:listInvoiceRequest version="2.0" invoiceVersion="2.0">
      <lInv:requestInvoice>
        <ftr:filter>
          <ftr:invoiceType>issuedInvoice</ftr:invoiceType>${filterXml}
        </ftr:filter>
      </lInv:requestInvoice>
    </lInv:listInvoiceRequest>
  </dat:dataPackItem>
</dat:dataPack>`;

  let xmlText;
  try {
    xmlText = await pohodaRequest(reqXml, 'invoice_export');
  } catch (err) {
    logger.error('Pohoda', `Chyba při volání mServeru: ${err.message}`);
    throw err;
  }

  // Parsování XML response
  let result;
  try {
    result = await parseXml(xmlText);
    logger.debug('Pohoda', 'Parsovaná struktura XML response', JSON.stringify(result, null, 2).substring(0, 2000));
  } catch (err) {
    logger.error('Pohoda', `Chyba parsování XML: ${err.message}`);
    throw new Error(`Nelze parsovat XML z Pohody: ${err.message}`);
  }

  // Navigace strukturou - Pohoda vrací dataPack > dataPackItem > responsePackItem > invoiceList > invoice
  // Struktura se může lišit podle verze Pohody - logujeme klíče pro debug
  const rootKeys = Object.keys(result || {});
  logger.debug('Pohoda', `Root keys v response: ${rootKeys.join(', ')}`);

  let invoiceItems = [];
  try {
    const dataPack = result.dataPack || result['dat:dataPack'];
    const dataPackItem = dataPack?.dataPackItem || dataPack?.['dat:dataPackItem'];
    const items = Array.isArray(dataPackItem) ? dataPackItem : [dataPackItem];

    for (const item of items) {
      const responsePack = item?.responsePackItem || item?.['dat:responsePackItem'];
      const responseItems = Array.isArray(responsePack) ? responsePack : [responsePack];

      for (const rItem of responseItems) {
        if (!rItem) continue;
        const invoiceList = rItem?.invoiceList || rItem?.['inv:invoiceList'];
        if (!invoiceList) {
          logger.warn('Pohoda', 'responsePackItem neobsahuje invoiceList', JSON.stringify(rItem).substring(0, 500));
          continue;
        }
        const invoices = invoiceList?.invoice || invoiceList?.['inv:invoice'];
        if (!invoices) {
          logger.warn('Pohoda', 'invoiceList je prázdný');
          continue;
        }
        const arr = Array.isArray(invoices) ? invoices : [invoices];
        invoiceItems.push(...arr);
      }
    }
  } catch (err) {
    logger.error('Pohoda', `Chyba při procházení XML struktury: ${err.message}`);
    logger.debug('Pohoda', 'Plná parsovaná struktura pro debug', JSON.stringify(result));
    throw new Error(`Nelze extrahovat faktury z XML: ${err.message}`);
  }

  logger.info('Pohoda', `Nalezeno ${invoiceItems.length} faktur v odpovědi`);

  // Extrahovat data z každé faktury
  const invoices = invoiceItems.map((inv, idx) => {
    const header = inv?.invoiceHeader || inv?.['inv:invoiceHeader'] || {};
    logger.debug('Pohoda', `Faktura ${idx + 1} - klíče headeru: ${Object.keys(header).join(', ')}`);

    // Číslo faktury
    const numberObj = header?.number || header?.['inv:number'];
    const invoiceNumber = val(numberObj?.numberRequested || numberObj?.['typ:numberRequested'])
      || val(numberObj);

    // Variabilní symbol - typicky = číslo objednávky z e-shopu
    const symVar = val(header?.symVar || header?.['inv:symVar']);

    // Číslo odběratelské objednávky (může být Upgates order code)
    const orderNumber = val(header?.orderNumber || header?.['inv:orderNumber']);

    // Interní ID záznamu v Pohodě (pro PDF print request)
    const internalId = inv?.$?.id || inv?.['$']?.id;

    // Datum
    const date = val(header?.date || header?.['inv:date']);

    logger.debug('Pohoda', `Faktura ${idx + 1}: číslo=${invoiceNumber}, symVar=${symVar}, orderNumber=${orderNumber}, internalId=${internalId}, datum=${date}`);

    return {
      invoiceNumber,
      symVar,         // variabilní symbol (= číslo objednávky z e-shopu)
      orderNumber,    // odběratelské číslo objednávky
      internalId,     // interní ID záznamu v Pohodě
      date,
      // upgatesOrderId = symVar (nebo orderNumber - zjistíme z logů)
      upgatesOrderId: symVar || orderNumber,
    };
  }).filter(inv => inv.invoiceNumber); // vyfiltrovat faktury bez čísla

  logger.info('Pohoda', `Zpracováno ${invoices.length} faktur`, invoices.map(i => `${i.invoiceNumber} (upgatesId: ${i.upgatesOrderId})`).join(', '));
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
        <prn:report name="Faktura - danovydoklad"/>
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
    logger.error('Pohoda', `Chyba při print requestu pro fakturu ${invoiceNumber}: ${err.message}`);
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
      logger.debug('Pohoda', 'Print response obsahuje attachment/pdf klíče', xmlStr.substring(0, 1000));
    } else {
      logger.warn('Pohoda', 'Print response NEOBSAHUJE attachment ani pdf - zkontroluj dump soubor!');
      return null;
    }

    // Pokus o extrakci Base64 z různých možných cest v XML
    const dataPack = result.dataPack || result['dat:dataPack'];
    const dataPackItem = dataPack?.dataPackItem || dataPack?.['dat:dataPackItem'];
    const items = Array.isArray(dataPackItem) ? dataPackItem : [dataPackItem];

    for (const item of items) {
      // Pohoda vrací PDF jako: responsePackItem > printResponse > pdf > data (base64)
      // nebo jako dat:attachment
      const attachment = item?.attachment || item?.['dat:attachment'];
      if (attachment) {
        const base64 = val(attachment) || attachment?.data || attachment?.content;
        if (base64) {
          logger.info('Pohoda', `PDF faktury ${invoiceNumber} úspěšně staženo (${String(base64).length} chars base64)`);
          return String(base64).replace(/\s/g, ''); // odstranit whitespace
        }
      }

      const printResponse = item?.printResponse || item?.responsePackItem?.printResponse;
      if (printResponse) {
        logger.debug('Pohoda', 'Nalezen printResponse element', JSON.stringify(printResponse).substring(0, 500));
        const pdfData = printResponse?.pdf?.data || printResponse?.pdfData || printResponse?._;
        if (pdfData) {
          logger.info('Pohoda', `PDF faktury ${invoiceNumber} staženo z printResponse`);
          return String(pdfData).replace(/\s/g, '');
        }
      }
    }

    logger.warn('Pohoda', `PDF faktury ${invoiceNumber} se nepodařilo extrahovat - zkontroluj dump soubor logs/pohoda_responses/`);
    return null;
  } catch (err) {
    logger.error('Pohoda', `Chyba při extrakci PDF: ${err.message}`);
    return null;
  }
}

// ----------------------------------------------------
// KROK 2: BALÍKY Z BALÍKOBOTU
// ----------------------------------------------------
async function fetchAllRecentPackages() {
  logger.info('Balikobot', 'Stahuji aktuální balíky z Balíkobotu...');
  const packageMap = new Map();

  try {
    const resInfo = await fetch(`${BALIKOBOT_BASE_URL}/info/carriers`, {
      headers: { 'Authorization': BALIKOBOT_AUTH, 'Content-Type': 'application/json' },
    });
    const infoData = await resInfo.json();
    const carriers = infoData.carriers || [];
    logger.info('Balikobot', `Nalezeno ${carriers.length} dopravců`);

    for (const carrier of carriers) {
      const endpoints = [`/${carrier.slug}/overview`, `/${carrier.slug}/orderview`];

      for (const endp of endpoints) {
        try {
          const res = await fetch(`${BALIKOBOT_BASE_URL}${endp}`, {
            headers: { 'Authorization': BALIKOBOT_AUTH, 'Content-Type': 'application/json' },
          });
          const data = await res.json();
          if (data.status !== 200) continue;

          let packageIds = [];
          if (data.packages) packageIds = data.packages.map(p => p.package_id || p.eshop_id);
          else if (data.package_ids) packageIds = data.package_ids;

          for (const pid of packageIds) {
            try {
              const resDet = await fetch(`${BALIKOBOT_BASE_URL}/${carrier.slug}/package/${pid}`, {
                headers: { 'Authorization': BALIKOBOT_AUTH, 'Content-Type': 'application/json' },
              });
              const detail = await resDet.json();
              if (detail.eshop_id) {
                packageMap.set(String(detail.eshop_id), {
                  found: true,
                  trackingCode: detail.carrier_id,
                  packageId: detail.package_id,
                  labelUrl: detail.label_url,
                  carrier: carrier.slug,
                });
              }
            } catch { /* ignorovat chybu jednotlivého balíku */ }
          }
        } catch { /* ignorovat chybu endpointu */ }
      }
    }
  } catch (err) {
    logger.error('Balikobot', `Chyba při stahování dopravců: ${err.message}`);
  }

  logger.info('Balikobot', `Staženo ${packageMap.size} balíků (eshop_id → tracking kód)`);
  return packageMap;
}

// ----------------------------------------------------
// KROK 3A: AKTUALIZACE TRACKING KÓDU V UPGATES
// ----------------------------------------------------
async function updateUpgatesTracking(upgatesOrderId, trackingCode, _carrier) {
  logger.info('Upgates', `Ukládám tracking kód ${trackingCode} k objednávce ${upgatesOrderId}...`);

  const url = `${UPGATES_URL}/orders/${encodeURIComponent(upgatesOrderId)}`;
  const body = JSON.stringify({
    tracking_code: trackingCode,
    // tracking_carrier: carrier, // odkomentovat pokud Upgates API vyžaduje dopravce
  });

  logger.logRequest('Upgates', 'PUT', url, { Authorization: '***MASKED***', 'Content-Type': 'application/json' }, body);

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': UPGATES_AUTH,
      'Content-Type': 'application/json',
    },
    body,
  });

  const resText = await res.text();
  logger.logResponse('Upgates', res.status, resText, url);
  logger.dumpResponse('upgates_tracking', resText, 'json');

  if (!res.ok) {
    throw new Error(`Upgates PUT /orders/${upgatesOrderId} vrátil HTTP ${res.status}: ${resText.substring(0, 300)}`);
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
    logger.warn('Upgates', `PDF faktury ${invoiceNumber} není k dispozici, přeskakuji upload`);
    return false;
  }

  logger.info('Upgates', `Nahrávám PDF faktury ${invoiceNumber} k objednávce ${upgatesOrderId}...`);

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

  logger.logRequest('Upgates', 'POST', url, { Authorization: '***MASKED***', 'Content-Type': 'application/json' }, `(body: ${body.length} bytes)`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': UPGATES_AUTH,
      'Content-Type': 'application/json',
    },
    body,
  });

  const resText = await res.text();
  logger.logResponse('Upgates', res.status, resText, url);
  logger.dumpResponse('upgates_pdf_upload', resText, 'json');

  if (res.ok) {
    logger.info('Upgates', `PDF faktury ${invoiceNumber} úspěšně nahráno k objednávce ${upgatesOrderId}`);
    return true;
  }

  // Pokud selže, zkusíme /documents endpoint
  logger.warn('Upgates', `/files endpoint vrátil ${res.status}, zkouším /documents...`);
  const url2 = `${UPGATES_URL}/orders/${encodeURIComponent(upgatesOrderId)}/documents`;
  const res2 = await fetch(url2, {
    method: 'POST',
    headers: { 'Authorization': UPGATES_AUTH, 'Content-Type': 'application/json' },
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

  logger.error('Upgates', `Ani /files ani /documents endpoint nefungoval. Zkontroluj dump soubory v logs/pohoda_responses/`);
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
      logger.error('Sync', `Faktura ${testOrderId} nenalezena v Pohodě! Zkontroluj dump XML v logs/pohoda_responses/`);
      await addLogEntry({ type: 'test', status: 'error', invoiceNumber: testOrderId, message: 'Faktura nenalezena v Pohodě' });
      return;
    }

    if (!testOrderId) {
      // V produkci přeskočit již zpracované
      invoices = invoices.filter(inv => !db.processed.includes(inv.invoiceNumber));
      logger.info('Sync', `${invoices.length} faktur čeká na zpracování (po odfiltrování zpracovaných)`);
    }

    if (invoices.length === 0) {
      logger.info('Sync', 'Žádné nové faktury ke zpracování');
      return;
    }

    // KROK 2: Balíky z Balíkobotu
    const recentPackages = await fetchAllRecentPackages();

    // KROK 3: Zpracování každé faktury
    for (const inv of invoices) {
      logger.info('Sync', `--- Zpracovávám fakturu: ${inv.invoiceNumber} (upgatesOrderId: ${inv.upgatesOrderId}) ---`);

      if (!inv.upgatesOrderId) {
        logger.warn('Sync', `Faktura ${inv.invoiceNumber} nemá upgatesOrderId (symVar je prázdný) - přeskakuji`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'error', invoiceNumber: inv.invoiceNumber, message: 'Chybí symVar (číslo objednávky Upgates)' });
        continue;
      }

      // Najít balík v Balíkobotu
      const pkg = recentPackages.get(String(inv.invoiceNumber));

      if (!pkg || !pkg.found) {
        logger.info('Sync', `Balík k faktuře ${inv.invoiceNumber} nenalezen v Balíkobotu - čekáme na expedici`);
        await addLogEntry({ type: testOrderId ? 'test' : 'sync', status: 'skipped', invoiceNumber: inv.invoiceNumber, message: 'Balík nenalezen v Balíkobotu' });
        continue;
      }

      logger.info('Sync', `Balík nalezen! tracking: ${pkg.trackingCode}, dopravce: ${pkg.carrier}`);

      // Stáhnout PDF faktury z Pohody
      const pdfBase64 = await fetchInvoicePdfFromPohoda(inv.invoiceNumber, inv.internalId);

      // Odeslat do Upgates
      let trackingOk = false;
      let pdfOk = false;

      try {
        trackingOk = await updateUpgatesTracking(inv.upgatesOrderId, pkg.trackingCode, pkg.carrier);
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
          trackingCode: pkg.trackingCode,
          carrier: pkg.carrier,
          message: `Tracking ${pkg.trackingCode} uložen. PDF: ${pdfBase64 ? (pdfOk ? 'nahráno' : 'chyba uploadu') : 'nedostupné z Pohody'}`,
        });
      } else {
        logger.error('Sync', `Faktura ${inv.invoiceNumber} - tracking kód se nepodařilo uložit do Upgates!`);
        await addLogEntry({
          type: testOrderId ? 'test' : 'sync',
          status: 'error',
          invoiceNumber: inv.invoiceNumber,
          message: 'Chyba při ukládání tracking kódu do Upgates',
        });
      }
    }

  } catch (err) {
    logger.error('Sync', `Kritická chyba synchronizace: ${err.message}`, err.stack);
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
