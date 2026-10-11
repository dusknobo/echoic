const { launchBrowser } = require('./qa_support.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),qa=path.join(root,'.runtime','qa');
const item=JSON.parse(fs.readFileSync(path.join(qa,'word-marker-audio.json'),'utf8'));
const base='http://127.0.0.1:18765',markerUrl=base+'/api/audio/'+item.id+'/markers';
(async()=>{
 let browser,context;
 try {
 browser=await launchBrowser({headless:true});
 context=await browser.newContext({viewport:{width:1280,height:1000},locale:'zh-CN'});
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const rows=page.locator('section[aria-label="\u65f6\u95f4\u6807\u8bb0"] ol > li');
 await page.goto(base+'/listening/'+item.id);
 await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=1);
 assert.equal(await rows.count(),1,'historical marker loads');
 assert.equal(await page.locator('[aria-label="\u6807\u8bb0\u7684\u5355\u8bcd\u548c\u4e0a\u4e0b\u6587"]').count(),0,'words hidden on blind listen');
 assert.equal(await page.getByRole('button',{name:/^\u6807\u8bb0\u5355\u8bcd /}).count(),0,'full text hidden');
 await page.locator('audio').evaluate(a=>{a.currentTime=3.1});
 await page.waitForFunction(()=>!document.querySelector('audio').seeking);
 await page.getByRole('button',{name:/\(P\)/}).click();
 await page.waitForFunction(()=>!document.querySelector('audio').paused);
 await page.waitForTimeout(100);
 await page.evaluate(()=>{
  window.qaPlayer=document.querySelector('audio');window.qaEvents=[];
  ['pause','seeking','emptied'].forEach(type=>qaPlayer.addEventListener(type,()=>qaEvents.push(type)));
 });
 const savedKey=page.waitForResponse(r=>r.url()===markerUrl&&r.request().method()==='POST');
 await page.keyboard.press('Space');
 assert.equal((await savedKey).status(),201);
 await page.getByRole('button',{name:'\u542c\u5b8c\u67e5\u770b\u6807\u8bb0\u8bcd',exact:true}).click();
 await rows.first().locator('strong').waitFor();
 assert.equal(await rows.count(),2);
 assert.equal(await rows.first().locator('strong').innerText(),'echo');
 assert.equal(await rows.last().locator('strong').innerText(),'friend.');
 assert.equal(await rows.first().locator('mark').count(),1,'only one repeated-word occurrence is highlighted');
 await page.getByRole('button',{name:'\u542c\u5b8c\u67e5\u770b\u539f\u6587',exact:true}).click();
 const first=page.getByRole('button',{name:'\u6807\u8bb0\u5355\u8bcd echo\uff0c\u7b2c 1 \u53e5\u7b2c 1 \u8bcd',exact:true});
 const second=page.getByRole('button',{name:'\u6807\u8bb0\u5355\u8bcd echo\uff0c\u7b2c 1 \u53e5\u7b2c 2 \u8bcd',exact:true});
 assert((await first.getAttribute('class')).includes('bg-amber-200'));
 assert(!(await second.getAttribute('class')).includes('bg-amber-200'),'same text at another time must stay unmarked');
 const savedWord=page.waitForResponse(r=>r.url()===markerUrl&&r.request().method()==='POST');
 await second.click();
 const wordResponse=await savedWord;
 assert.equal(wordResponse.status(),201);
 assert.equal((await wordResponse.json()).time,4.5,'pointing a word saves its time, not playback time');
 await page.waitForTimeout(150);
 const playback=await page.locator('audio').evaluate(a=>({paused:a.paused,same:a===qaPlayer,time:a.currentTime,events:qaEvents}));
 assert.equal(playback.paused,false,'word click continues playback');
 assert.equal(playback.same,true);
 assert.deepEqual(playback.events,[],'marking never pauses, seeks or reloads');
 assert.equal(await rows.count(),3);
 assert.equal(await rows.nth(1).locator('strong').innerText(),'echo');
 await page.screenshot({path:path.join(qa,'word-markers.png'),fullPage:true});
 await rows.nth(1).getByRole('button',{name:'\u4ece\u8be5\u8bcd\u56de\u542c',exact:true}).click();
 const replay=await page.locator('audio').evaluate(a=>({paused:a.paused,time:a.currentTime}));
 assert.equal(replay.paused,false);
 assert(replay.time>=3.85&&replay.time<4.5,'word replay starts 0.1s before the selected word');
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=1);
 assert.equal(await rows.count(),3,'all three marker times survive reload');
 assert.equal(await page.locator('[aria-label="\u6807\u8bb0\u7684\u5355\u8bcd\u548c\u4e0a\u4e0b\u6587"]').count(),0,'reloading restores blind listen');
 await page.getByRole('button',{name:'\u542c\u5b8c\u67e5\u770b\u6807\u8bb0\u8bcd',exact:true}).click();
 assert.deepEqual(await rows.locator('strong').allTextContents(),['echo','echo','friend.']);
 // No word timestamps: keep the markers and explain the fallback.
 const audio=await (await context.request.get(base+'/api/audio/'+item.id)).json();
 await page.route(base+'/api/audio/'+item.id,route=>route.fulfill({json:{...audio,sentences:[]}}));
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=1);
 await page.getByRole('button',{name:'\u542c\u5b8c\u67e5\u770b\u6807\u8bb0\u8bcd',exact:true}).click();
 const fallback='\u6682\u65e0\u9010\u8bcd\u65f6\u95f4\u8f74\u3002\u8f6c\u5199\u5b8c\u6210\u540e\u5237\u65b0\uff0c\u5373\u53ef\u67e5\u770b\u5bf9\u5e94\u5355\u8bcd\uff1b\u65f6\u95f4\u6807\u8bb0\u5df2\u4fdd\u7559\u3002';
 assert.equal(await page.getByText(fallback,{exact:true}).count(),3);
 assert.deepEqual(errors,[]);
 console.log('PASS: historical and new markers map to words; repeated occurrences stay separate; word click never pauses/seeks/reloads; replay and refresh persist; missing word timestamps handled.');
 } finally {
  if(context){
   const deleted=await context.request.delete(base+'/api/audio/'+item.id);
   assert([204,404].includes(deleted.status()),'temporary audio cleanup');
  }
  if(browser)await browser.close();
 }
})().catch(e=>{console.error(e);process.exit(1)});
