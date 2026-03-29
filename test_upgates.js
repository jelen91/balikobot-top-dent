require('dotenv').config();
const fetch = require('node-fetch') || globalThis.fetch;

async function testMethods() {
  const UPGATES_URL = process.env.UPGATES_URL || 'https://topdent.admin.s5.upgates.com/api/v2';
  const UPGATES_USER = process.env.UPGATES_USER || '';
  const UPGATES_SECRET = process.env.UPGATES_SECRET || '';
  const UPGATES_AUTH = 'Basic ' + Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');
  
  const orderId = '2604411';
  const tracking = '26Ez04768';

  console.log('--- TESTOVÁNÍ UPGATES ENDPOINTŮ PRO AKTUALIZACI TRACKINGU ---');

  // 1. Zkouška PUT na kořenný endpoint s polem (Nejčastější u Upgates)
  let url = `${UPGATES_URL}/orders`;
  console.log(`\n1. Pokus: PUT ${url}`);
  let body = JSON.stringify({ orders: [{ order_number: orderId, tracking_code: tracking }] });
  let res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: UPGATES_AUTH, 'Content-Type': 'application/json' },
    body: body,
  });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${await res.text()}`);

  // 2. Zkouška POST na konkrétní ID (občas některá API podporují)
  url = `${UPGATES_URL}/orders/${orderId}`;
  console.log(`\n2. Pokus: POST ${url}`);
  body = JSON.stringify({ tracking_code: tracking });
  res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: UPGATES_AUTH, 'Content-Type': 'application/json' },
    body: body,
  });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${await res.text()}`);

  // 3. Zkouška PUT jen s objektem u kořenového endpointu
  url = `${UPGATES_URL}/orders`;
  console.log(`\n3. Pokus: PUT ${url} (bez pole, jen objekt)`);
  body = JSON.stringify({ order_number: orderId, tracking_code: tracking });
  res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: UPGATES_AUTH, 'Content-Type': 'application/json' },
    body: body,
  });
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Body: ${await res.text()}`);
}

testMethods();
