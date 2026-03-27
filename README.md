# Upgates - Pohoda - Balíkobot Synchronizace

Tento skript slouží k automatickému nahrávání čísel balíků (tracking kódů) a vygenerovaných faktur z Pohody zpět do e-shopu Upgates. 

Skript je navržen tak, aby se vyhnul omezením historie v Balíkobot API — automaticky si stáhne všechny **aktuálně zpracovávané a nově uzavřené balíky** ze všech vašich dopravců a tyto balíky pak spáruje s fakturami získanými z účetního systému Pohoda.

## Jak to funguje
1. Skript stáhne nově vytvořené a nezpracované faktury z **Pohoda mServeru** za poslední dny.
2. Následně si hromadně stáhne nejnovější data (aktivní a poslední svozy) z **Balíkobotu** přes všechny nastavené dopravce. Ze získaných dat si vytvoří paměťovou mapu spojující `eshop_id` a trasovací číslo (`carrier_id`).
3. Pro každou fakturu z Pohody se pokusí najít odpovídající balík.
4. Pokud balík najde, odešle (přes PUT/POST) do **Upgates** trasovací číslo a PDF fakturu, označí objednávku za odeslanou a fakturu zapíše do lokálního souboru `processed_invoices.json`.
5. Tyto zpracované faktury už příště ignoruje, aby zbytečně nepřetěžoval Upgates.

---

## Nastavení
Skript ke spuštění potřebuje údaje k API systémům. Vytvořte si ve stejné složce soubor nazvaný přesně `.env` a vložte do něj tyto údaje (upravte je podle svého prostředí):

```ini
POHODA_MSERVER_URL=http://localhost:4444/xml
POHODA_ICO=12345678
POHODA_USER=Admin
POHODA_PASS=heslo_do_pohody

BALIKOBOT_API_USER=top-dentcz
BALIKOBOT_API_KEY=4rYH1VXK

UPGATES_URL=https://vase-domena.upgates.com/api/v2
UPGATES_USER=API_USER
UPGATES_SECRET=API_SECRET
```

Před prvním spuštěním si nainstalujte závislosti:
```bash
npm install
```

---

## 🛠 Příklad: Testovací režim (bezpečný test)
Pro bezpečné vyzkoušení funkce skriptu (end-to-end průchod jedné objednávky bez rizika dvojitého zpracování nebo poškození databáze) slouží testovací režim. Skript stiskne do Pohody reálný dotaz, vyfiltruje pouze žádaný nákup, spáruje jej s Balíkobotem a nahraje přímo do Upgates.

**Jaké číslo tam zadat?**
Zadáváte **Číslo dokladu (Faktury) z Pohody**. Většinou to bývá stejné číslo, pod kterým odesíláte (nebo pod kterým propojení odesílá) do Balíkobotu ID balíku – tedy hodnota `eshop_id` v Balíkobotu. Podle toho se záznamy párují.
Příklad: Pokud do Pohody padla objednávka číslo `250012` a faktura je `2026123` a štítek do Balíkobotu se propsal pod číslem `2026123` nebo pod `54321-B` atd., pak je to to číslo, pod jakým Balíkobot zná daný balík (`eshop_id`). Skript u tohoto příkladu porovnává _InvoiceNumber_.

Spuštění testu provedete z příkazové řádky vložením příkazu `--test <cislo>`:

```bash
node sync.js --test "CHYBÍ-V-OBECNÉM-PŘÍKLADU-ZADEJ-CISLO-FAKTURY"
```
_(Pozn.: Upgates API se v testovacím režimu zavolá naplno! Pokud máte hotové Upgates endpointy, ověřte si, jestli neposíláte finální fakturu opravdovému klientovi e-mailovou automatikou v e-shopu.)_

---

## 🚀 Ostrý (produkční) provoz
Skript nechejte spouštět na pozadí, např. každou hodinu automaticky přes Plánovač úloh (Windows) nebo Cron (Linux).

```bash
node sync.js
```
Skript postupně prozkoumá všechny poslední doklady, najde balíky a uloží do souboru `processed_invoices.json` (automaticky vytvořen). Tento soubor nemažte! Slouží jako paměť toho, co už skript zpracoval.
