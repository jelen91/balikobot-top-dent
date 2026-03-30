require('dotenv').config();
const https = require('https');

function request(url, method, auth, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      method: method,
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json'
      }
    };
    
    let bodyStr = '';
    if (bodyObj) {
      bodyStr = JSON.stringify(bodyObj);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(urlObj, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyObj) req.write(bodyStr);
    req.end();
  });
}

async function testMethods() {
  const UPGATES_URL = (process.env.UPGATES_URL || 'https://topdent.admin.s5.upgates.com/api/v2').replace(/\/$/, '');
  const UPGATES_USER = process.env.UPGATES_USER || '';
  const UPGATES_SECRET = process.env.UPGATES_SECRET || '';
  const UPGATES_AUTH = 'Basic ' + Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');
  
  const orderId = '2604411';

  console.log('--- TESTOVÁNÍ PRÁV API KLÍČE ---');

  // 1. Zkouška GET (Pokud toto neprojde, je API klíč / URL úplně špatně)
  let url = `${UPGATES_URL}/orders/${orderId}`;
  console.log(`\n1. Pokus: GET ${url} (Získání objednávky - test read práv)`);
  let res = await request(url, 'GET', UPGATES_AUTH);
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body.substring(0, 150)}...`);

  // 2. Zkouška GET na hlavní endpoint orders
  url = `${UPGATES_URL}/orders`;
  console.log(`\n2. Pokus: GET ${url} (Získání seznamu - test read práv)`);
  res = await request(url, 'GET', UPGATES_AUTH);
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body.substring(0, 150)}...`);
  
  // 3. GET /orders?order_number= (hledání interního ID)
  url = `${UPGATES_URL}/orders?order_number=${orderId}`;
  console.log(`\n3. Pokus: GET ${url} (Hledání interního ID podle čísla objednávky)`);
  res = await request(url, 'GET', UPGATES_AUTH);
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body.substring(0, 300)}`);

  // 4. PUT na order-statuses
  url = `${UPGATES_URL}/order-statuses`;
  console.log(`\n4. Pokus: PUT ${url} (Alternativní endpoint pro stavy / tracking)`);
  res = await request(url, 'PUT', UPGATES_AUTH, { orders: [{ order_number: orderId, tracking_code: "TEST_TRACKING_123" }] });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body.substring(0, 300)}`);

  // 5. GET /orders/91536 - plný detail objednávky (hledáme tracking_code pole a dalsi klice)
  const internalId = '91536'; // order_id z předchozího GET
  url = `${UPGATES_URL}/orders/${internalId}`;
  console.log(`\n5. Pokus: GET ${url} (Plný detail objednávky - zjistit pole pro tracking)`);
  res = await request(url, 'GET', UPGATES_AUTH);
  console.log(`HTTP Status: ${res.status}`);
  // Vypsat celé tělo - chceme vidět všechny klíče
  try {
    const parsed = JSON.parse(res.body);
    const order = parsed.orders?.[0] || parsed;
    console.log('Klíče objednávky:', Object.keys(order).join(', '));
    // Hledej tracking-related pole
    for (const [k, v] of Object.entries(order)) {
      if (typeof v === 'string' || typeof v === 'number') {
        console.log(`  ${k}: ${v}`);
      }
    }
  } catch (e) {
    console.log(`Body: ${res.body.substring(0, 500)}`);
  }

  // 6. PUT /orders/91536 - update tracking kódu (klíčový test!)
  url = `${UPGATES_URL}/orders/${internalId}`;
  console.log(`\n6. Pokus: PUT ${url} (Update tracking kódu přes interní ID - KLÍČOVÝ TEST)`);
  res = await request(url, 'PUT', UPGATES_AUTH, { tracking_code: "TEST_TRACKING_123" });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body.substring(0, 500)}`);

  // 7. PATCH /orders/91536
  url = `${UPGATES_URL}/orders/${internalId}`;
  console.log(`\n7. Pokus: PATCH ${url} (PATCH jako alternativa k PUT)`);
  res = await request(url, 'PATCH', UPGATES_AUTH, { tracking_code: "TEST_TRACKING_123" });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body.substring(0, 300)}`);
}

testMethods();
