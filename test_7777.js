// ČISTĚ ČTECÍ TEST proti mServeru na portu 7777 (Ateosys instance).
// Nic nezapisuje, jen stáhne seznam faktur za poslední 1 den a vypíše počet.
// Spustit na serveru:  node test_7777.js
require('dotenv').config();
const http = require('http');
const iconv = require('iconv-lite');
const xml2js = require('xml2js');

const PORT = 7777; // <-- testujeme Ateosys mServer
const POHODA_ICO = process.env.POHODA_ICO || '28130235';
const POHODA_USER = process.env.POHODA_USER || 'Admin';
const POHODA_PASS = process.env.POHODA_PASS || '';
const POHODA_AUTH = 'Basic ' + Buffer.from(`${POHODA_USER}:${POHODA_PASS}`).toString('base64');

function pohodaRequest(xmlBody) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(xmlBody, 'utf8');
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/xml',
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'STW-Authorization': POHODA_AUTH,
        'Content-Length': bodyBuf.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'win1250')));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - 1);
  const dateFromStr = dateFrom.toISOString().split('T')[0];

  console.log(`\n=== ČTECÍ TEST mServeru na portu ${PORT} ===`);
  console.log(`ICO: ${POHODA_ICO}, uživatel: ${POHODA_USER}, faktury od: ${dateFromStr}\n`);

  const reqXml = `<?xml version="1.0" encoding="UTF-8"?>
<dat:dataPack id="Test7777" ico="${POHODA_ICO}" application="TopDentSyncTest" version="2.0" note=""
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
    xmlText = await pohodaRequest(reqXml);
  } catch (err) {
    console.log(`❌ SPOJENÍ SELHALO: ${err.code || err.message}`);
    console.log(`   → mServer na portu ${PORT} buď neběží, nebo neodpovídá.`);
    process.exit(1);
  }

  const result = await new xml2js.Parser({
    explicitArray: false,
    tagNameProcessors: [xml2js.processors.stripPrefix],
  }).parseStringPromise(xmlText);

  const packItem = result.responsePack?.responsePackItem;
  const packItems = Array.isArray(packItem) ? packItem : [packItem];
  let invoiceCount = 0;
  let errState = null;
  for (const item of packItems) {
    if (!item) continue;
    if (item.$?.state === 'error') { errState = item.$?.note || 'error'; continue; }
    const inv = item.listInvoice?.invoice;
    if (inv) invoiceCount += Array.isArray(inv) ? inv.length : 1;
  }

  if (errState) {
    console.log(`⚠️  mServer odpověděl, ale s chybou: ${errState}`);
    console.log(`\n--- prvních 600 znaků odpovědi ---\n${xmlText.substring(0, 600)}`);
    process.exit(2);
  }

  console.log(`✅ mServer na portu ${PORT} ODPOVÍDÁ.`);
  console.log(`✅ Vráceno faktur za poslední 1 den: ${invoiceCount}`);
  console.log(`\n→ Port 7777 je použitelný jako náhrada za 7778. Nic se nezapisovalo.`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
