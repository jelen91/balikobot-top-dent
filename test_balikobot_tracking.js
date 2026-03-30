require('dotenv').config();
const https = require('https');

const BB_API_BASE = 'https://apiv2.balikobot.cz';
const BB_USER = process.env.BALIKOBOT_API_USER || '';
const BB_KEY  = process.env.BALIKOBOT_API_KEY  || '';
const BB_AUTH = 'Basic ' + Buffer.from(`${BB_USER}:${BB_KEY}`).toString('base64');

function bbRequest(path) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(BB_API_BASE + path);
    const options = {
      method: 'GET',
      headers: {
        'Authorization': BB_AUTH,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(urlObj, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log(`\n====== TEST BALIKOBOT - hledání tracking čísel ======`);
  console.log(`User: ${BB_USER}`);

  // 1. Seznam dopravců
  console.log('\n1. GET /info/carriers');
  const carriersRes = await bbRequest('/info/carriers');
  console.log(`HTTP Status: ${carriersRes.status}`);
  let carriers = [];
  try {
    const data = JSON.parse(carriersRes.body);
    carriers = data.carriers || [];
    console.log(`Dostupní dopravci (${carriers.length}):`);
    carriers.forEach(c => console.log(`  - ${c.slug}: ${c.name}`));
  } catch (e) {
    console.log('Body:', carriersRes.body.substring(0, 300));
  }

  if (carriers.length === 0) return;

  // 2. Pro každého dopravce: overview (přehled zásilek)
  console.log('\n2. Hledám zásilky přes overview pro každého dopravce...');
  for (const carrier of carriers) {
    const r = await bbRequest(`/${carrier.slug}/overview`);
    if (r.status !== 200) continue;
    try {
      const data = JSON.parse(r.body);
      // overview vrací seznam objednávek s balíčky
      const packages = data.packages || data.data || [];
      if (packages.length === 0) continue;
      console.log(`\n  ${carrier.slug} (${carrier.name}) - ${packages.length} zásilek:`);
      // Ukázat strukturu prvního balíčku
      const first = packages[0];
      console.log(`  Klíče balíčku: ${Object.keys(first).join(', ')}`);
      // Vypsat klíčová pole
      const trackFields = ['carrier_id', 'vs', 'order_number', 'eid', 'rec_name', 'tracking_number', 'package_number'];
      for (const f of trackFields) {
        if (first[f] !== undefined) console.log(`    ${f}: ${first[f]}`);
      }
    } catch (e) { /* skip */ }
  }

  // 3. Orderview - poslední objednávka pro každého dopravce
  console.log('\n3. Hledám nejnovější objednávky přes orderview...');
  for (const carrier of carriers) {
    const r = await bbRequest(`/${carrier.slug}/orderview`);
    if (r.status !== 200) continue;
    try {
      const data = JSON.parse(r.body);
      if (data.status !== 200) continue;
      const pkgIds = data.package_ids || [];
      if (pkgIds.length === 0) continue;
      console.log(`\n  ${carrier.slug} - poslední objednávka má ${pkgIds.length} balíčků, pkg_id[0]=${pkgIds[0]}`);

      // Detail prvního balíčku - tady je tracking číslo
      const pkgRes = await bbRequest(`/${carrier.slug}/package/${pkgIds[0]}`);
      if (pkgRes.status !== 200) continue;
      const pkg = JSON.parse(pkgRes.body);
      console.log(`  Klíče balíčku: ${Object.keys(pkg).join(', ')}`);
      const trackFields = ['carrier_id', 'vs', 'order_number', 'eid', 'rec_name', 'tracking_number', 'package_number', 'label_url'];
      for (const f of trackFields) {
        if (pkg[f] !== undefined) console.log(`    ${f}: ${pkg[f]}`);
      }
    } catch (e) { /* skip */ }
  }

  // 4. Pokud víme carrier, zkusíme packages endpoint - hledáme objednávku 2604411
  // Balikobot má endpoint /info/packages s filtrováním
  console.log('\n4. GET /info/packages (pokud existuje - fulltext search)');
  const infoRes = await bbRequest('/info/packages');
  console.log(`HTTP Status: ${infoRes.status}`);
  console.log('Body:', infoRes.body.substring(0, 300));
}

main().catch(console.error);
