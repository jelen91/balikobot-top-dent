require('dotenv').config();
const http = require('http');
const iconv = require('iconv-lite');
const fs = require('fs');

const POHODA_MSERVER_URL = process.env.POHODA_MSERVER_URL || 'http://localhost:7778/xml';
const POHODA_ICO = process.env.POHODA_ICO || '12345678';
const POHODA_USER = process.env.POHODA_USER || 'Admin';
const POHODA_PASS = process.env.POHODA_PASS || '';
const POHODA_AUTH = 'Basic ' + Buffer.from(`${POHODA_USER}:${POHODA_PASS}`).toString('base64');

// ID zásilky v Pohodě (z faktura.linkedDocuments.shipments.sourceDocument.id)
// Přepište na ID zásilky, kterou chcete testovat
const SHIPMENT_ID = process.argv[2] || '56785';

function pohodaPost(xmlBody) {
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
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = iconv.decode(buf, 'win1250');
        resolve({ status: res.statusCode, body: text });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  console.log(`\n====== TEST POHODA SHIPMENT (ID: ${SHIPMENT_ID}) ======`);
  console.log(`URL: ${POHODA_MSERVER_URL}`);
  console.log(`ICO: ${POHODA_ICO}`);

  // Pokus 1: listShipmentRequest s ftr:selectedIDs
  const xml1 = `<?xml version="1.0" encoding="UTF-8"?>
<dat:dataPack id="ExportZasilky" ico="${POHODA_ICO}" application="TopDentSync" version="2.0" note=""
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd">
  <dat:dataPackItem id="1" version="2.0">
    <lst:listShipmentRequest version="2.0" shipmentVersion="2.0">
      <lst:requestShipment>
        <ftr:filter>
          <ftr:selectedIDs>
            <ftr:id>${SHIPMENT_ID}</ftr:id>
          </ftr:selectedIDs>
        </ftr:filter>
      </lst:requestShipment>
    </lst:listShipmentRequest>
  </dat:dataPackItem>
</dat:dataPack>`;

  console.log('\n--- Pokus 1: listShipmentRequest + selectedIDs ---');
  console.log('Posílám request...');
  try {
    const r1 = await pohodaPost(xml1);
    console.log(`HTTP Status: ${r1.status}`);
    console.log(`Response délka: ${r1.body.length} znaků`);
    console.log(`Response (prvních 2000 znaků):\n${r1.body.substring(0, 2000)}`);
    fs.writeFileSync('shipment_test_1.xml', r1.body, 'utf8');
    console.log('\n[Uloženo do shipment_test_1.xml]');

    // Hledej tracking kód - vypíš všechny XML tagy a jejich hodnoty
    console.log('\n--- XML tagy s hodnotami (hledání tracking kódu) ---');
    const tagPattern = /<([a-zA-Z:]+)[^>]*>([^<]{3,50})<\/[^>]+>/g;
    let match;
    const found = new Set();
    while ((match = tagPattern.exec(r1.body)) !== null) {
      const key = match[1];
      const val = match[2].trim();
      if (!found.has(key + val)) {
        found.add(key + val);
        console.log(`  <${key}> = "${val}"`);
      }
    }
  } catch (err) {
    console.log(`CHYBA: ${err.message}`);
  }

  // Pokus 2: bez ftr:selectedIDs - jen datum
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 30);
  const dateStr = yesterday.toISOString().split('T')[0];

  const xml2 = `<?xml version="1.0" encoding="UTF-8"?>
<dat:dataPack id="ExportZasilky2" ico="${POHODA_ICO}" application="TopDentSync" version="2.0" note=""
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd">
  <dat:dataPackItem id="1" version="2.0">
    <lst:listShipmentRequest version="2.0" shipmentVersion="2.0">
      <lst:requestShipment>
        <ftr:filter>
          <ftr:dateFrom>${dateStr}</ftr:dateFrom>
        </ftr:filter>
      </lst:requestShipment>
    </lst:listShipmentRequest>
  </dat:dataPackItem>
</dat:dataPack>`;

  console.log('\n--- Pokus 2: listShipmentRequest + dateFrom (posledních 30 dní) ---');
  console.log('Posílám request...');
  try {
    const r2 = await pohodaPost(xml2);
    console.log(`HTTP Status: ${r2.status}`);
    console.log(`Response délka: ${r2.body.length} znaků`);
    console.log(`Response (prvních 3000 znaků):\n${r2.body.substring(0, 3000)}`);
    fs.writeFileSync('shipment_test_2.xml', r2.body, 'utf8');
    console.log('\n[Uloženo do shipment_test_2.xml]');
  } catch (err) {
    console.log(`CHYBA: ${err.message}`);
  }
}

main().catch(console.error);
