const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({executablePath:'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true}); });
after(async () => { await browser?.close(); });
async function fixture({labels=['Show sidebar','Hide sidebar'], enabled=true, expanded=false, delay=0, storageDelay=0, duplicate=false, mouseOnly=false, pausedFrames=false, ignoreExitOutEvents=false}={}) {
  const page = await browser.newPage();
  page.errors=[];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.setContent(`<style>
    body{margin:0}
    aside{position:fixed;top:0;left:0;height:100vh;width:260px}
    button{width:44px;height:44px}
    aside[data-expanded=false]{width:52px}
    .rail-item{position:absolute;left:4px;width:44px;height:44px}
    #library{top:96px}
    #preset-one{top:160px}
    #preset-two{top:204px}
    #preset-three{top:248px}
  </style>${duplicate?'<button style="display:none" aria-label="Hide sidebar">Hidden toggle</button>':''}<aside data-expanded="${expanded}"><button id="toggle" aria-label="${labels[expanded?1:0]}">Toggle</button><a id="library" class="rail-item" aria-label="Library" href="/library"></a><a id="preset-one" class="rail-item" aria-label="Preset one" href="/g/g-one"></a><a id="preset-two" class="rail-item" aria-label="Preset two" href="/g/g-two"></a><a id="preset-three" class="rail-item" aria-label="Preset three" href="/gpts/g-three"></a></aside>`);
  await page.evaluate(({labels,enabled,delay,storageDelay}) => {
    window.clicks=0;
    window.listeners=[];
    const button=document.getElementById('toggle');
    button.disabled=Boolean(delay);
    if(delay)setTimeout(()=>{button.disabled=false},delay);
    button.addEventListener('click',()=>{
      window.clicks++;
      const sidebar=button.parentElement;
      const expanded=sidebar.dataset.expanded!=='true';
      sidebar.dataset.expanded=String(expanded);
      button.setAttribute('aria-label', labels[expanded?1:0]);
    });
    window.chrome={runtime:{id:'fixture'},storage:{local:{get:async defaults=>{
      if(storageDelay) await new Promise(resolve=>setTimeout(resolve,storageDelay));
      return {...defaults,hoverRevealSidebar:enabled};
    }},onChanged:{addListener:fn=>listeners.push(fn)}}};
  },{labels,enabled,delay,storageDelay});
  if (mouseOnly) await page.evaluate(() => {
    for (const type of ['pointermove', 'pointerover']) {
      document.addEventListener(type, event => event.stopImmediatePropagation(), true);
    }
  });
  if (ignoreExitOutEvents) await page.evaluate(() => {
    // Some window-edge transitions never deliver a usable out event to
    // trackMouseExit. Ensure root-level leave handling works independently.
    for (const type of ['pointerout', 'mouseout']) {
      window.addEventListener(type, event => {
        if (event.relatedTarget === null) event.stopImmediatePropagation();
      }, true);
    }
  });
  if (pausedFrames) await page.evaluate(() => {
    // Model a visible, unfocused window where animation frames are suspended.
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
  });
  await page.addScriptTag({content:read('js/extension-context.js')});
  await page.addScriptTag({content:read('js/collapse-sidebar.js')});
  return page;
}
for(const labels of [['Show sidebar','Hide sidebar'],['Open sidebar','Close sidebar'],['Expand sidebar','Collapse sidebar']]) {
  test(`hover expands and leaving collapses (${labels[0]})`,async()=>{
    const page=await fixture({labels});
    await page.mouse.move(12,250);
    await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
    await page.mouse.move(200,250);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('aside').getAttribute('data-expanded'),'true');
    await page.mouse.move(500,250);
    await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
    assert.equal(await page.evaluate(()=>clicks),2);
    assert.deepEqual(page.errors,[]);
    await page.close();
  });
}
test('moving left outside the browser viewport collapses a hover-open sidebar',async()=>{
  const page=await fixture({ ignoreExitOutEvents: true });
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');

  // Moving past x=0 should close just like moving to the right of the sidebar.
  await page.mouse.move(-25,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  await page.waitForTimeout(750);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'false');

  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  assert.equal(await page.evaluate(()=>clicks),3);
  assert.deepEqual(page.errors,[]);
  await page.close();
});
test('leaving the viewport to the left cancels an in-progress hover reveal',async()=>{
  const page=await fixture({ ignoreExitOutEvents: true });
  await page.mouse.move(12,250);
  await page.waitForTimeout(120);
  await page.mouse.move(-25,250);
  await page.waitForTimeout(750);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'false');
  assert.equal(await page.evaluate(()=>clicks),0);
  assert.deepEqual(page.errors,[]);
  await page.close();
});
test('hidden duplicate toggles are ignored and initial expansion collapses',async()=>{
  const page=await fixture({duplicate:true,expanded:true});
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  assert.equal(await page.evaluate(()=>clicks),2);
  await page.close();
});
test('edge hover waits for a temporarily disabled native toggle',async()=>{
  const page=await fixture({delay:250});
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  assert.equal(await page.evaluate(()=>clicks),1);
  await page.close();
});
test('disabled hover setting leaves the collapsed sidebar alone',async()=>{
  const page=await fixture({enabled:false});
  await page.mouse.move(12,250);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>clicks),0);
  await page.close();
});
test('enabling hover while the pointer is already below Library reveals without another move', async () => {
  const page = await fixture({ enabled: false });
  await page.mouse.move(12, 170);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'), 'false');
  await page.evaluate(() => listeners.forEach(listener => listener({
    hoverRevealSidebar: { oldValue: false, newValue: true },
  }, 'local')));
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'true');
  assert.equal(await page.evaluate(() => clicks), 1);
  await page.close();
});
test('hover entered before settings load reveals once they arrive without another move', async () => {
  const page = await fixture({ storageDelay: 800 });
  await page.mouse.move(12, 170);
  await page.waitForTimeout(450);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'), 'false');
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'true');
  assert.equal(await page.evaluate(() => clicks), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});
test('collapsed reveal covers the entire left rail below Library, not the area above it',async()=>{
  const page=await fixture();

  await page.mouse.move(12,80);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'false');

  await page.mouse.move(12,145);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.mouse.move(500,145);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');

  await page.mouse.move(65,310);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'false');

  // The former preset-icon cutoff must not leave a dead zone.
  await page.mouse.move(12,310);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.mouse.move(500,310);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');

  // The hotspot extends to the viewport bottom, including the right edge
  // of the 64-pixel rail.
  const bottom=page.viewportSize().height-8;
  await page.mouse.move(63,bottom);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.mouse.move(500,bottom);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');

  assert.equal(await page.evaluate(()=>clicks),6);
  assert.deepEqual(page.errors,[]);
  await page.close();
});
test('rail hover survives changed preset URL shapes',async()=>{
  const page=await fixture();
  await page.evaluate(()=>{
    document.getElementById('preset-one').setAttribute('href','/preset/one');
    document.getElementById('preset-two').setAttribute('href','/preset/two');
    document.getElementById('preset-three').setAttribute('href','/preset/three');
  });
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  assert.equal(await page.evaluate(()=>clicks),1);
  assert.deepEqual(page.errors,[]);
  await page.close();
});
test('rail without presets still reveals to the viewport bottom and keeps Library clickable',async()=>{
  const page=await fixture();
  await page.evaluate(()=>document.querySelectorAll('[id^="preset-"]').forEach(element=>element.remove()));
  await page.mouse.move(12,115);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'false');
  await page.mouse.move(12,170);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.mouse.move(500,170);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  await page.mouse.move(12,page.viewportSize().height-8);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.mouse.move(500,page.viewportSize().height-8);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  assert.equal(await page.evaluate(()=>clicks),4);
  assert.deepEqual(page.errors,[]);
  await page.close();
});
test('moving Library updates the hover boundary without relying on presets',async()=>{
  const page=await fixture();
  await page.evaluate(()=>{
    document.querySelectorAll('[id^="preset-"]').forEach(element=>element.remove());
    document.getElementById('library').style.top='240px';
  });
  await page.mouse.move(12,220);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'false');
  await page.mouse.move(12,page.viewportSize().height-8);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.mouse.move(500,page.viewportSize().height-8);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  assert.equal(await page.evaluate(()=>clicks),2);
  assert.deepEqual(page.errors,[]);
  await page.close();
});
test('synthetic research-menu pointer events cannot reveal the sidebar',async()=>{
  const page=await fixture();
  await page.mouse.move(500,250);
  await page.evaluate(()=>{
    const research=document.createElement('button');
    research.textContent='Deep research';
    document.body.append(research);
    research.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse'}));
  });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'false');
  assert.equal(await page.evaluate(()=>clicks),0);
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:null})));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'true');
  await page.mouse.move(500,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  await page.close();
});
test('sidebar portal menus, the gap, and nested GPT menus remain selectable',async()=>{
  const page=await fixture();
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.evaluate(()=>{
    document.querySelector('aside').insertAdjacentHTML('beforeend','<button id="explore" aria-haspopup="menu" aria-expanded="true" aria-controls="explore-menu">Explore</button>');
    document.body.insertAdjacentHTML('beforeend',`<div id="explore-menu" role="menu" style="position:fixed;left:268px;top:100px;width:180px;height:200px"><button id="gpts" aria-expanded="true">GPTs</button></div><div role="menu" aria-labelledby="gpts" style="position:fixed;left:456px;top:100px;width:180px;height:200px"><button id="gpt-item">My GPT</button></div>`);
    document.getElementById('gpt-item').onclick=()=>window.selectedGPT=true;
  });
  for(const x of [264,300,452,480]) {
    await page.mouse.move(x,120);
    await page.waitForTimeout(150);
    assert.equal(await page.locator('aside').getAttribute('data-expanded'),'true');
  }
  await page.click('#gpt-item');
  assert.equal(await page.evaluate(()=>window.selectedGPT),true);
  await page.mouse.move(700,400);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  assert.deepEqual(page.errors,[]);
  await page.close();
});
test('unrelated and hidden portal menus do not keep the sidebar expanded',async()=>{
  const page=await fixture();
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.evaluate(()=>{
    document.querySelector('aside').insertAdjacentHTML('beforeend','<button id="explore" aria-expanded="true">Explore</button>');
    document.body.insertAdjacentHTML('beforeend','<div role="menu" aria-labelledby="explore" style="visibility:hidden;position:fixed;left:268px;top:100px;width:180px;height:200px"></div><div role="menu" style="position:fixed;left:268px;top:100px;width:180px;height:200px">Composer menu</div>');
  });
  await page.mouse.move(300,120);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  await page.close();
});
test('overflowing sidebar children stay interactive past the sidebar bounds',async()=>{
  const page=await fixture();
  await page.mouse.move(12,250);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='true');
  await page.evaluate(()=>document.querySelector('aside').insertAdjacentHTML('beforeend','<button style="position:absolute;left:250px;top:100px;width:120px">GPTs</button>'));
  await page.mouse.move(300,120);
  await page.waitForTimeout(150);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'),'true');
  await page.mouse.move(500,120);
  await page.waitForFunction(()=>document.querySelector('aside').dataset.expanded==='false');
  await page.close();
});

test('Library button with both accessible label and text reveals below Library', async () => {
  const page = await fixture();
  await page.evaluate(() => {
    document.querySelectorAll('[id^="preset-"]').forEach(element => element.remove());
    document.getElementById('library').outerHTML = '<button id="library" class="rail-item" aria-label="Library" title="Library">Library</button>';
  });
  await page.mouse.move(12, 115);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'), 'false');
  await page.mouse.move(12, 170);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'true');
  await page.mouse.move(500, 170);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'false');
  assert.equal(await page.evaluate(() => clicks), 2);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('hover reveals in a blurred window even when animation frames are paused', async () => {
  const page = await fixture({ pausedFrames: true });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(500, 250);
  await page.mouse.move(12, page.viewportSize().height - 8);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'true',
    null, { polling: 50 });
  assert.equal(await page.evaluate(() => clicks), 1);
  await page.mouse.move(500, 250);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'false',
    null, { polling: 50 });
  assert.equal(await page.evaluate(() => clicks), 2);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('blurred-window hover cancels if the pointer leaves before the reveal delay', async () => {
  const page = await fixture({ pausedFrames: true });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(12, 250);
  await page.waitForTimeout(110);
  await page.mouse.move(500, 250);
  await page.waitForTimeout(450);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'), 'false');
  assert.equal(await page.evaluate(() => clicks), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('blurred-window reveal retries disabled controls without animation frames', async () => {
  const page = await fixture({ pausedFrames: true, delay: 800 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.move(12, 250);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'true',
    null, { polling: 50 });
  assert.equal(await page.evaluate(() => clicks), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('mouse hover reveals without pointer events or an activation click', async () => {
  const page = await fixture({ mouseOnly: true });
  await page.mouse.move(500, 170);
  await page.mouse.move(12, 170);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'), 'true');
  await page.mouse.move(500, 170);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'false');
  assert.equal(await page.evaluate(() => clicks), 2);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('the full rail below Library opens the sidebar with one mascot', async () => {
  const page = await fixture();
  await page.evaluate(() => { chrome.runtime.getURL = file => 'chrome-extension://fixture/' + file; });
  await page.addStyleTag({ content: read('css/flawless-corner.css') });
  await page.addScriptTag({ content: read('js/flawless-corner.js') });
  await page.mouse.move(500, 20);
  await page.locator('#ghrc-flawless-corner').hover();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('aside').getAttribute('data-expanded'), 'false');
  await page.mouse.move(12, 170);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'true');
  assert.equal(await page.locator('#ghrc-flawless-corner').isVisible(), true);
  await page.mouse.move(500, 20);
  await page.waitForFunction(() => document.querySelector('aside').dataset.expanded === 'false');
  assert.equal(await page.evaluate(() => clicks), 2);
  assert.deepEqual(page.errors, []);
  await page.close();
});
