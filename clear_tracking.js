require('dotenv').config();
const http = require('http');
const https = require('https');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');

const POHODA_MSERVER_URL = process.env.POHODA_MSERVER_URL || 'http://localhost:7778/xml';
const POHODA_ICO = process.env.POHODA_ICO || '12345678';
const POHODA_USER = process.env.POHODA_USER || 'Admin';
const POHODA_PASS = process.env.POHODA_PASS || '';
const POHODA_AUTH = 'Basic ' + Buffer.from(`${POHODA_USER}:${POHODA_PASS}`).toString('base64');

const UPGATES_URL = (process.env.UPGATES_URL || 'https://topdent.admin.s5.upgates.com/api/v2').replace(/\/$/, '');
const UPGATES_USER = process.env.UPGATES_USER || '';
const UPGATES_SECRET = process.env.UPGATES_SECRET || '';
const UPGATES_AUTH = 'Basic ' + Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');

const DAYS_BACK = parseInt(process.argv[2] || '3', 10);

async function pohodaRequest(xmlBody) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(POHODA_MSERVER_URL);
    const bodyBuf = Buffer.from(xmlBody, 'utf8');
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 7778,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'STW-Authorization': POHODA_AUTH,
        'Content-Length': bodyBuf.length,
      },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'win1250')));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function upgatesRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(UPGATES_URL + path);
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Authorization': UPGATES_AUTH,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function main() {
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - DAYS_BACK);
  const dateFromStr = dateFrom.toISOString().split('T')[0];

  console.log(`\n====== MAZÁNÍ TRACKING ČÍSEL Z UPGATES ======`);
  console.log(`Faktury od: ${dateFromStr} (${DAYS_BACK} dní zpět)\n`);

  // 1. Načíst faktury z Pohody
  console.log('Načítám faktury z Pohody...');
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

  const xmlText = await pohodaRequest(reqXml);
  const result = await new xml2js.Parser({
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  }).parseStringPromise(xmlText);

  const packItem = result.responsePack?.responsePackItem;
  const packItems = Array.isArray(packItem) ? packItem : [packItem];
  const invoiceItems = [];
  for (const item of packItems) {
    if (!item || item.$?.state === 'error') continue;
    const inv = item.listInvoice?.invoice;
    if (!inv) continue;
    invoiceItems.push(...(Array.isArray(inv) ? inv : [inv]));
  }

  // Extrahovat čísla objednávek
  const orderNumbers = [];
  for (const inv of invoiceItems) {
    const header = inv?.invoiceHeader || {};
    const numberOrder = header?.numberOrder;
    const on = typeof numberOrder === 'object' ? numberOrder._ : numberOrder;
    if (on) orderNumbers.push(String(on));
  }

  const unique = [...new Set(orderNumbers)];
  console.log(`Nalezeno ${unique.length} objednávek: ${unique.join(', ')}\n`);

  if (unique.length === 0) {
    console.log('Žádné objednávky k vymazání.');
    return;
  }

  // 2. Vymazat tracking_code v Upgates (prázdný string)
  let ok = 0, fail = 0;
  for (const orderNumber of unique) {
    const res = await upgatesRequest('PUT', '/orders', {
      orders: [{ order_number: orderNumber, tracking_code: '' }]
    });
    let updated = false;
    try {
      const data = JSON.parse(res.body);
      updated = data.orders?.[0]?.updated_yn === true;
    } catch (_) {}
    console.log(`  ${orderNumber}: HTTP ${res.status} → ${updated ? 'OK - tracking smazán' : 'FAIL - ' + res.body.substring(0, 100)}`);
    if (updated) ok++; else fail++;
  }

  console.log(`\nHotovo: ${ok} smazáno, ${fail} selhalo.`);
}

main().catch(console.error);
