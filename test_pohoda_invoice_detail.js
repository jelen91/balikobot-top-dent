require('dotenv').config();
const http = require('http');
const iconv = require('iconv-lite');
const fs = require('fs');

const POHODA_MSERVER_URL = process.env.POHODA_MSERVER_URL || 'http://localhost:7778/xml';
const POHODA_ICO = process.env.POHODA_ICO || '12345678';
const POHODA_USER = process.env.POHODA_USER || 'Admin';
const POHODA_PASS = process.env.POHODA_PASS || '';
const POHODA_AUTH = 'Basic ' + Buffer.from(`${POHODA_USER}:${POHODA_PASS}`).toString('base64');

// Číslo objednávky nebo faktury k testování
const ORDER_NUMBER = process.argv[2] || '2604411';

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
  console.log(`\n====== TEST POHODA INVOICE DETAIL (objednávka: ${ORDER_NUMBER}) ======`);

  // Pokud vypadá jako číslo objednávky (numerické), použijeme dateFrom filtr a filtrujeme v JS
  const daysBack = 10;
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysBack);
  const dateFromStr = dateFrom.toISOString().split('T')[0];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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

  console.log(`Načítám faktury od ${dateFromStr}...`);
  const r = await pohodaPost(xml);
  console.log(`HTTP Status: ${r.status}, délka: ${r.body.length} znaků`);

  // Uložit celé XML
  fs.writeFileSync('invoice_detail_full.xml', r.body, 'utf8');
  console.log('[Uloženo do invoice_detail_full.xml]');

  if (r.body.includes('state="error"')) {
    console.log('CHYBA v odpovědi!');
    console.log(r.body.substring(0, 1000));
    return;
  }

  // Najít konkrétní fakturu pro danou objednávku
  // Rozdělíme XML na jednotlivé faktury
  const invoiceBlocks = r.body.split('<inv:invoice ');
  console.log(`\nNalezeno ${invoiceBlocks.length - 1} faktur celkem`);

  // Hledáme fakturu pro objednávku ORDER_NUMBER
  let foundBlock = null;
  for (let i = 1; i < invoiceBlocks.length; i++) {
    const block = '<inv:invoice ' + invoiceBlocks[i];
    if (block.includes(`<inv:numberOrder>${ORDER_NUMBER}</inv:numberOrder>`)) {
      foundBlock = block.split('</inv:invoice>')[0] + '</inv:invoice>';
      console.log(`\nNalezena faktura pro objednávku ${ORDER_NUMBER}!`);
      break;
    }
  }

  if (!foundBlock) {
    console.log(`\nFaktura pro objednávku ${ORDER_NUMBER} nenalezena v posledních ${daysBack} dnech.`);
    console.log('Zkuste zvýšit daysBack nebo zkontrolujte číslo objednávky.');
    // Ukázat první fakturu jako příklad struktury
    if (invoiceBlocks.length > 1) {
      const firstBlock = '<inv:invoice ' + invoiceBlocks[1].split('</inv:invoice>')[0] + '</inv:invoice>';
      console.log('\n=== Příklad první faktury (pro analýzu struktury) ===');
      console.log(firstBlock.substring(0, 3000));
      fs.writeFileSync('invoice_detail_example.xml', firstBlock, 'utf8');
      console.log('\n[Uloženo do invoice_detail_example.xml]');
    }
    return;
  }

  // Uložit konkrétní fakturu
  fs.writeFileSync('invoice_detail_order.xml', foundBlock, 'utf8');
  console.log('[Uloženo do invoice_detail_order.xml]');

  // Vypsat všechny XML tagy a jejich hodnoty (hledáme tracking kód)
  console.log('\n=== VŠECHNA XML POLE FAKTURY ===');
  const tagPattern = /<([a-zA-Z:]+)[^>]*>([^<]{1,200})<\/[^>]+>/g;
  let match;
  const found = new Set();
  while ((match = tagPattern.exec(foundBlock)) !== null) {
    const key = match[1];
    const val = match[2].trim();
    if (val && !found.has(key + ':::' + val)) {
      found.add(key + ':::' + val);
      console.log(`  ${key}: "${val}"`);
    }
  }

  // Speciálně hledat tracking-related slova
  console.log('\n=== HLEDÁNÍ TRACKING/ZÁSILKA KLÍČOVÝCH SLOV ===');
  const keywords = ['track', 'Track', 'zasilk', 'Zasilk', 'shipping', 'Shipping', 'carrier', 'Carrier', 'package', 'Package', 'NB', 'parcel'];
  for (const kw of keywords) {
    const idx = foundBlock.indexOf(kw);
    if (idx >= 0) {
      console.log(`  [${kw}] nalezeno na pozici ${idx}: ...${foundBlock.substring(Math.max(0, idx - 30), idx + 80)}...`);
    }
  }

  console.log('\n=== KOMPLETNÍ XML FAKTURY ===');
  console.log(foundBlock);
}

main().catch(console.error);
