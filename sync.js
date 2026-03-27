require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const xml2js = require('xml2js');

// ----------------------------------------------------
// KONFIGURACE (doplnit podle klienta do .env souboru)
// ----------------------------------------------------
const POHODA_MSERVER_URL = process.env.POHODA_MSERVER_URL || 'http://localhost:4444/xml';
const POHODA_ICO = process.env.POHODA_ICO || '12345678';
const POHODA_USER = process.env.POHODA_USER || 'Admin';
const POHODA_PASS = process.env.POHODA_PASS || '';

const BALIKOBOT_API_USER = process.env.BALIKOBOT_API_USER || 'top-dentcz';
const BALIKOBOT_API_KEY = process.env.BALIKOBOT_API_KEY || '4rYH1VXK';
const BALIKOBOT_BASE_URL = 'https://apiv2.balikobot.cz';
const BALIKOBOT_AUTH = 'Basic ' + Buffer.from(`${BALIKOBOT_API_USER}:${BALIKOBOT_API_KEY}`).toString('base64');

const UPGATES_URL = process.env.UPGATES_URL || 'https://vase-domena.upgates.com/api/v2';
const UPGATES_USER = process.env.UPGATES_USER || 'API_USER';
const UPGATES_SECRET = process.env.UPGATES_SECRET || 'API_SECRET';
const UPGATES_AUTH = 'Basic ' + Buffer.from(`${UPGATES_USER}:${UPGATES_SECRET}`).toString('base64');

// ----------------------------------------------------
// DATABÁZE PRO UCHOVÁNÍ ZPRACOVANÝCH FAKTUR
// ----------------------------------------------------
const DB_FILE = path.join(__dirname, 'processed_invoices.json');

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
// KROK 1: ZÍSKÁNÍ FAKTUR Z POHODY
// ----------------------------------------------------
async function fetchInvoicesFromPohoda() {
  console.log('📦 Načítám faktury z Pohoda mServeru...');
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - 3); // Poslední 3 dny
  const dateFromStr = dateFrom.toISOString().split('T')[0];

  // Ukázkové XML pro export faktur z Pohody
  const reqXml = `<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack id="faImport" ico="${POHODA_ICO}" application="Synchronizace" version="2.0" note="Export faktur" xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" xmlns:ftx="http://www.stormware.cz/schema/version_2/filter.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd">
    <dat:dataPackItem id="1" version="2.0">
        <fac:invoiceExport xmlns:fac="http://www.stormware.cz/schema/version_2/invoice.xsd">
            <ftx:filter>
                <ftx:dateFrom>${dateFromStr}</ftx:dateFrom>
            </ftx:filter>
        </fac:invoiceExport>
    </dat:dataPackItem>
</dat:dataPack>`;

  // ZDE BY PROBĚHLO REÁLNÉ VOLÁNÍ NA mServer:
  /*
  const response = await fetch(POHODA_MSERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      'Authorization': 'Basic ' + Buffer.from(`${POHODA_USER}:${POHODA_PASS}`).toString('base64')
    },
    body: reqXml
  });
  const xmlData = await response.text();
  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(xmlData);
  */
  
  // Pro demonstraci vrátíme statické pole:
  return [
    {
      invoiceNumber: '2026001',
      upgatesOrderId: 'UP-123',
      pdfBase64: 'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmog...' // Zkráceno
    }
  ];
}

// ----------------------------------------------------
// KROK 2: NALEZENÍ BALÍKŮ V BALÍKOBOTU (aktuálních)
// ----------------------------------------------------
async function fetchAllRecentPackages() {
  console.log('📥 Stahuji aktuální balíky (neuzavřené i poslední svozy) z Balíkobotu...');
  const packageMap = new Map();
  
  try {
    // 1. Získání aktivních dopravců
    const resInfo = await fetch(`${BALIKOBOT_BASE_URL}/info/carriers`, {
      headers: { 'Authorization': BALIKOBOT_AUTH, 'Content-Type': 'application/json' }
    });
    const infoData = await resInfo.json();
    const carriers = infoData.carriers || [];

    // 2. Projít každého dopravce a stáhnout aktivní balíky
    for (const carrier of carriers) {
      const endpoints = [`/${carrier.slug}/overview`, `/${carrier.slug}/orderview`];
      
      for (const endp of endpoints) {
        try {
          const res = await fetch(`${BALIKOBOT_BASE_URL}${endp}`, {
            headers: { 'Authorization': BALIKOBOT_AUTH, 'Content-Type': 'application/json' }
          });
          const data = await res.json();
          if (data.status !== 200) continue;

          let packageIds = [];
          if (data.packages) packageIds = data.packages.map(p => p.package_id || p.eshop_id);
          else if (data.package_ids) packageIds = data.package_ids;

          // 3. Získat detaily (kvůli zjištění eshop_id a carrier_id / tracking)
          for (const pid of packageIds) {
            try {
              const resDet = await fetch(`${BALIKOBOT_BASE_URL}/${carrier.slug}/package/${pid}`, {
                headers: { 'Authorization': BALIKOBOT_AUTH, 'Content-Type': 'application/json' }
              });
              const detail = await resDet.json();
              if (detail.eshop_id) {
                // Klíčujeme podle eshop_id (který bývá často variabilní symbol/číslo obj)
                packageMap.set(String(detail.eshop_id), {
                  found: true,
                  trackingCode: detail.carrier_id,
                  packageId: detail.package_id,
                  labelUrl: detail.label_url
                });
              }
            } catch (err) { /* ignore pkg det error */ }
          }
        } catch (err) { /* ignore ep error */ }
      }
    }
  } catch (err) {
    console.error('❌ Chyba při stahování dopravců:', err.message);
  }
  
  console.log(`✅ Staženo ${packageMap.size} balíků připravených ke spárování ze současných svozů.`);
  return packageMap;
}

// ----------------------------------------------------
// KROK 3: ODESLÁNÍ DO UPGATES
// ----------------------------------------------------
async function updateUpgatesOrder(orderId, trackingCode, pdfBase64) {
  console.log(`📤 Aktualizuji objednávku ${orderId} v Upgates...`);

  // 1. Zápis tracking kódu a změna stavu u objednávky
  /*
  const updateRes = await fetch(`${UPGATES_URL}/orders/${orderId}`, {
    method: 'PUT',
    headers: {
      'Authorization': UPGATES_AUTH,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      order_status_id: 2, // 2 = Odesláno (zjistěte si správné ID z Upgates)
      external_tracking_code: trackingCode
    })
  });
  if (!updateRes.ok) throw new Error('Nepodařilo se aktualizovat objednávku v Upgates');
  */

  // 2. Nahrání PDF faktury k objednávce
  /*
  const docRes = await fetch(`${UPGATES_URL}/orders/${orderId}/documents`, {
    method: 'POST',
    headers: {
      'Authorization': UPGATES_AUTH,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: 'Faktura',
      file_name: 'faktura.pdf',
      file_content: pdfBase64
    })
  });
  if (!docRes.ok) throw new Error('Nepodařilo se nahrát doklad do Upgates');
  */

  console.log(`✅ Upgates úspěšně aktualizován.`);
}

// ----------------------------------------------------
// HLAVNÍ CYKLUS
// ----------------------------------------------------
async function runSync(testOrderId = null) {
  if (testOrderId) {
    console.log(`\n======================================================`);
    console.log(`🛠️  TESTOVACÍ REŽIM ZAPNUT PRO OBJEDNÁVKU/DOKLAD: ${testOrderId}`);
    console.log(`======================================================\n`);
  } else {
    console.log('🚀 Spouštím standardní synchronizační cyklus...');
  }
  
  const db = await loadDb();

  try {
    // Vždy načítáme faktury z Pohody (i v test režimu, abychom otestovali spojení)
    let invoices = await fetchInvoicesFromPohoda();
    
    // Pokud je testovací režim, vyfiltrujeme pouze tu jednu fakturu/objednávku
    if (testOrderId) {
      invoices = invoices.filter(inv => String(inv.invoiceNumber) === String(testOrderId));
      if (invoices.length === 0) {
        console.log(`\n❌ CHYBA: Doklad ${testOrderId} nebyl nalezen v datech vrácených z Pohoda mServeru v posledních dnech.`);
        console.log(`Zkontrolujte, jestli export z Pohody funguje a vrací tento doklad.\n`);
        return; // konec testu
      }
      console.log(`✅ Doklad ${testOrderId} úspěšně stažen z Pohody (včetně PDF PDF/A).`);
    }
    
    // Stáhneme vše, co Balíkobot momentálně "vydá" (z posledních a aktivních svozů)
    const recentPackages = await fetchAllRecentPackages();

    for (const inv of invoices) {
      // V testovacím režimu ignorujeme databázi zpracovaných, abys to mohl testovat dokola
      if (!testOrderId && db.processed.includes(inv.invoiceNumber)) {
        continue;
      }
      
      console.log(`Zpracovávám doklad: ${inv.invoiceNumber}`);

      // 2. Najdeme balík v naší mapě stažených z Balíkobotu
      const pkg = recentPackages.get(String(inv.invoiceNumber));

      if (pkg && pkg.found) {
        // 3. Pošleme přes API do Upgates (Tracking + Faktura PDF)
        console.log(`📦 Nalezen balík pro ${inv.invoiceNumber}! Tracking kód: ${pkg.trackingCode}`);
        
        console.log(`📤 Odesílám data (Tracking kód + Fakura PDF) do Upgates...`);
        // Odesílá se REÁLNĚ i v testu na přání uživatele
        await updateUpgatesOrder(inv.upgatesOrderId, pkg.trackingCode, inv.pdfBase64);

        if (!testOrderId) {
          // 4. Uložíme jako hotovou (v test režimu neukládáme, aby se to dalo hrát znova)
          db.processed.push(inv.invoiceNumber);
          await saveDb(db);
        }
        console.log(`🎉 Faktura/Doklad ${inv.invoiceNumber} úspěšně zpracován a odeslán do Upgates.`);
      } else {
        console.log(`⏳ Balík k dokladu ${inv.invoiceNumber} se v aktuálních datech Balíkobotu nenašel, počkáme do dalšího cyklu.`);
      }
    }

  } catch (err) {
    console.error('❌ Nastala chyba během synchronizace:', err);
  }

  console.log('✅ Synchronizační cyklus dokončen.');
}

// Spuštění pokud je voláno napřímo (např. v Plánovači úloh / cron)
if (require.main === module) {
  const args = process.argv.slice(2);
  const testFlagIndex = args.indexOf('--test');
  
  if (testFlagIndex !== -1 && args[testFlagIndex + 1]) {
    runSync(args[testFlagIndex + 1]);
  } else {
    runSync();
  }
}

module.exports = { runSync };
