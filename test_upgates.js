require('dotenv').config();
const https = require('https');

function request(url, method, auth, bodyObj) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const bodyStr = JSON.stringify(bodyObj);
    const options = {
      method: method,
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(urlObj, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function testMethods() {
  const UPGATES_URL = (process.env.UPGATES_URL || 'https://topdent.admin.s5.upgates.com/api/v2').replace(/\/$/, '');
  const UPGATES_USER = process.env.UPGATES_USER || '';
  const UPGATES_SECRET = process.env.UPGATES_SECRET || '';
  const UPGATES_AUTH = 'Basic ' + Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');
  
  const orderId = '2604411';
  const tracking = '26Ez04768';

  console.log('--- TESTOVÁNÍ UPGATES ENDPOINTŮ PRO AKTUALIZACI TRACKINGU ---');

  // 1. Zkouška PUT na kořenový endpoint s polem (nejčastější u Upgates)
  let url = `${UPGATES_URL}/orders`;
  console.log(`\n1. Pokus: PUT ${url}`);
  let res = await request(url, 'PUT', UPGATES_AUTH, { orders: [{ order_number: orderId, tracking_code: tracking }] });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body}`);

  // 2. Zkouška POST na konkrétní ID
  url = `${UPGATES_URL}/orders/${orderId}`;
  console.log(`\n2. Pokus: POST ${url}`);
  res = await request(url, 'POST', UPGATES_AUTH, { tracking_code: tracking });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body}`);

  // 3. Zkouška PUT jen s objektem
  url = `${UPGATES_URL}/orders`;
  console.log(`\n3. Pokus: PUT ${url} (bez pole)`);
  res = await request(url, 'PUT', UPGATES_AUTH, { order_number: orderId, tracking_code: tracking });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${res.body}`);
}

testMethods();
