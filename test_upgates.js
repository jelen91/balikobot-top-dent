require('dotenv').config();
const UPGATES_URL = process.env.UPGATES_URL || 'https://topdent.admin.s5.upgates.com/api/v2';
const UPGATES_USER = process.env.UPGATES_USER || '';
const UPGATES_SECRET = process.env.UPGATES_SECRET || '';
const UPGATES_AUTH = 'Basic ' + Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');

async function test() {
  const upgatesOrderId = '2604411';
  let url = `${UPGATES_URL}/orders/${encodeURIComponent(upgatesOrderId)}`;
  
  console.log('Testing PUT with /orders/2604411...');
  let res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: UPGATES_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracking_code: "26Ez04768" }),
  });
  console.log('PUT status:', res.status);
  console.log('PUT body:', await res.text());

  if (res.status === 501) {
    console.log('\nTesting POST with /orders/2604411...');
    url = `${UPGATES_URL}/orders/${encodeURIComponent(upgatesOrderId)}`;
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: UPGATES_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracking_code: "26Ez04768" }),
    });
    console.log('POST status:', res.status);
    console.log('POST body:', await res.text());

    console.log('\nTesting PUT with /orders and payload array...');
    url = `${UPGATES_URL}/orders`;
    res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: UPGATES_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: [{ order_number: upgatesOrderId, tracking_code: "26Ez04768" }] }),
    });
    console.log('PUT array status:', res.status);
    console.log('PUT array body:', await res.text());
  }
}
test();
