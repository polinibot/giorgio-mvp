import { loginYap, openAgendaInApp, gotoAgendaDate } from "./lib/yap-shared.mjs";
import { createRequire } from "module";
const req = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = req("playwright");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });

const requests = [];
context.on("request", (r) => {
  requests.push({
    method: r.method(),
    url: r.url().slice(0, 150),
    post: (r.postData() || "").slice(0, 300),
  });
});

const page = await context.newPage();
await loginYap(page, process.env.YAP_USERNAME, process.env.YAP_PASSWORD);
await openAgendaInApp(page);
await gotoAgendaDate(page, "2026-11-13");
await page.waitForTimeout(1000);

const ev = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".fc-event")].find((e) =>
    e.textContent.includes("AB123CD")
  );
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + 100, y: r.y + 5 };
});

if (!ev) { console.log("NO EVENT"); await browser.close(); process.exit(1); }

await page.mouse.click(ev.x, ev.y);
await page.getByText("Dettagli appuntamento").first().waitFor({ state: "visible", timeout: 10000 });
await page.waitForTimeout(300);

requests.length = 0;

const appUrl = await page.evaluate(() => {
  const ev = [...document.querySelectorAll('.fc-event')].find(e => e.textContent.includes('AB123CD'));
  if (!ev) return null;
  const r = ev.getBoundingClientRect();
  return { x: r.x + 100, y: r.y + 5 };
});
await page.mouse.dblclick(appUrl.x, appUrl.y);
await page.waitForTimeout(2000);
console.log('URL after dblclick:', page.url());
await page.waitForTimeout(5000);
console.log('URL after wait:', page.url());
console.log('TITLE:', await page.title());

requests.length = 0;

const pratica2 = await page.evaluate(() => {
  const allBtns = [...document.querySelectorAll('button, .gwt-Button, a.gwt-Anchor, [class*="delete"], [class*="elimin"]')]
    .filter(e => e.getBoundingClientRect().width > 0)
    .map(e => ({ tag: e.tagName, cls: e.className.slice(0,60), txt: e.textContent.trim().slice(0,40) }));
  const delBtns = allBtns.filter(b => /elimin|delete|canc|rimuov|appunt/i.test(b.txt));
  return { title: document.title, url: location.hash.slice(0,100), delBtns, sample: allBtns.slice(0,20) };
});
console.log('PRATICA DETAIL:', JSON.stringify(pratica2, null, 2));
await browser.close();
process.exit(0);

const elimAnchor = await page.evaluate(() => {
  const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")].find((e) =>
    e.textContent.includes("Dettagli")
  );
  if (!popup) return null;
  return [...popup.querySelectorAll("a.gwt-Anchor")]
    .filter((e) => e.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
    .map((a) => ({ txt: a.textContent.trim().slice(0,30), href: a.href }))
    .find((a) => a.txt.includes("Elimina"));
});
console.log('ELIM ANCHOR:', elimAnchor);

requests.length = 0;
await page.mouse.click(elimAnchor.x || 802, elimAnchor.y || 341);
await page.waitForTimeout(1000);
await page.evaluate(() => {
  const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")].find((e) => e.textContent.includes("Dettagli"));
  if (popup) { const a = [...popup.querySelectorAll('a.gwt-Anchor')].find(a => a.textContent.includes('Elimina')); if (a) a.click(); }
});
await page.waitForTimeout(5000);
console.log('URL:', page.url());
console.log('TITLE:', await page.title());

await page.waitForSelector('.gwt-Button, .gwt-Anchor', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(3000);

const praticaContent = await page.evaluate(() => {
  const allBtns = [...document.querySelectorAll('button, .gwt-Button, a.gwt-Anchor')]
    .filter(e => e.getBoundingClientRect().width > 0)
    .map(e => ({ tag: e.tagName, cls: e.className.slice(0,60), txt: e.textContent.trim().slice(0,40) }));
  const delBtns = allBtns.filter(b => /elimin|delete|canc|rimuov/i.test(b.txt));
  return { title: document.title, url: location.href.slice(0,150), delBtns, allBtns: allBtns.slice(0,20) };
});
console.log('PRATICA PAGE:', JSON.stringify(praticaContent, null, 2));
console.log('ALL REQUESTS:', JSON.stringify(requests.slice(0,10), null, 2));
await browser.close();
process.exit(0);

const allActions = await page.evaluate(() => {
  const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
  const allText = [...document.scripts].map(s => s.text || '').join(' ');
  const matches = allText.match(/[A-Za-z]+(?:Delete|Elimin|Remove|Cancel)[A-Za-z]+Action[^'"\s]*/g) || [];
  return { scripts, actionMatches: [...new Set(matches)] };
});
console.log('ALL ACTIONS:', JSON.stringify(allActions.actionMatches));

const elimCoords = await page.evaluate(() => {
  const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")].find((e) =>
    e.textContent.includes("Dettagli")
  );
  if (!popup) return null;
  const a = [...popup.querySelectorAll("a.gwt-Anchor")]
    .filter((e) => e.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
    .find((a) => a.textContent.includes("Elimina"));
  if (!a) return null;
  const r = a.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.href || '' };
});
console.log('ELIM COORDS:', elimCoords);

requests.length = 0;
await page.mouse.click(elimCoords.x, elimCoords.y);
await page.waitForTimeout(5000);

console.log('URL after click:', page.url());
console.log('REQUESTS after click:', JSON.stringify(requests, null, 2));

const pageContent = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button, .gwt-Button, a.gwt-Anchor, [class*="delete"], [class*="elimin"]')]
    .filter(e => e.getBoundingClientRect().width > 0)
    .map(e => ({ tag: e.tagName, cls: e.className.slice(0,60), txt: e.textContent.trim().slice(0,30) }));
  return { title: document.title, btns };
});
console.log('PAGE AFTER CLICK:', JSON.stringify(pageContent, null, 2));

await browser.close();
