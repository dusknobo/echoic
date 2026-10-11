const { launchBrowser } = require('./qa_support.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),qa=path.join(root,'.runtime','qa');
const fixture=JSON.parse(fs.readFileSync(path.join(qa,'pair-audio.json'),'utf8'));
const base='http://127.0.0.1:18765';
(async()=>{
 let browser,context;
 try {
  browser=await launchBrowser({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+path.join(qa,'sentence.wav')]});
  context=await browser.newContext({viewport:{width:1280,height:960},locale:'zh-CN',permissions:['microphone']});
  await context.addInitScript(()=>{
   localStorage.setItem('echoic.playbackSpeed','1');
   window.qaMedia=[]; window.qaCalls=[];
   const original=HTMLMediaElement.prototype.play;
   HTMLMediaElement.prototype.play=function(...args){
    let id=qaMedia.indexOf(this); if(id<0){id=qaMedia.length;qaMedia.push(this)}
    qaCalls.push({id,at:performance.now(),time:this.currentTime,duration:this.duration});
    if(window.qaRejectNextPlay){window.qaRejectNextPlay=false;return Promise.reject(new Error('Injected playback failure'))}
    return original.apply(this,args);
   };
   window.qaSnapshot=()=>qaPair.map(id=>{const a=qaMedia[id];return {id,time:a.currentTime,duration:a.duration,paused:a.paused,ended:a.ended,rate:a.playbackRate}});
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const playTogether=()=>page.getByRole('button',{name:'原音与录音同时播放',exact:true});
  const pauseTogether=()=>page.getByRole('button',{name:'暂停同时播放',exact:true}).filter({hasText:'暂停同时播放'});
  const snapshot=()=>page.evaluate(()=>qaSnapshot());
  async function loadSentence(time){
   await page.goto(base+'/speaking/'+fixture.id+'?time='+time);
   await page.getByRole('tab',{name:'我的练习',exact:true}).click();
   const history=page.locator('[role="tabpanel"] .cursor-pointer.rounded-lg.border').first();
   await history.waitFor(); await history.click();
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='原音与录音同时播放'&&!b.disabled));
  }
  async function startPair(){
   await page.evaluate(()=>{qaCalls=[]});
   await playTogether().click();
   await page.waitForFunction(()=>qaCalls.length===2);
   const calls=await page.evaluate(()=>{qaPair=qaCalls.map(c=>c.id);return qaCalls});
   assert(calls[1].at-calls[0].at<100,'both play calls start in the same turn');
   assert(calls.every(c=>c.time<0.1),'both restart at zero');
   await page.waitForFunction(()=>qaSnapshot().every(a=>!a.paused&&a.time>0.05));
  }
  await loadSentence(0);
  await startPair();
  await page.waitForTimeout(350);
  let state=await snapshot();
  assert(Math.abs(state[0].time-state[1].time)<0.15,'tracks advance together');
  await page.keyboard.press('Space');
  await page.getByRole('button',{name:'继续同时播放',exact:true}).filter({hasText:'继续同时播放'}).waitFor();
  const paused=await snapshot(); assert(paused.every(a=>a.paused));
  await page.waitForTimeout(250);
  state=await snapshot();assert(state.every((a,i)=>Math.abs(a.time-paused[i].time)<0.05),'both paused positions hold');
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>qaSnapshot().every(a=>!a.paused));
  state=await snapshot();assert(state.every((a,i)=>a.time>=paused[i].time-0.05),'resume preserves position');
  // The original ends first; keep the recording running without looping the original.
  await page.waitForFunction(()=>qaSnapshot()[0].ended&&!qaSnapshot()[1].paused,{timeout:10000});
  const playCount=await page.evaluate(()=>qaCalls.filter(c=>c.id===qaPair[0]).length);
  await pauseTogether().click();
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>!qaSnapshot()[1].paused);
  state=await snapshot();assert(state[0].ended&&state[0].paused);
  assert.equal(await page.evaluate(()=>qaCalls.filter(c=>c.id===qaPair[0]).length),playCount,'finished short track never restarts on resume');
  await playTogether().waitFor({timeout:10000});
  assert((await snapshot()).every(a=>a.paused),'both finish with no original sentence loop');
  // A new pair always starts both again, and a seek exits comparison mode.
  await startPair();
  const waves=page.locator('[part="scroll"]');
  await waves.last().click({position:{x:80,y:20}});
  await playTogether().waitFor();
  assert((await snapshot()).every(a=>a.paused),'waveform interaction stops both tracks');
  // Same speed on both players, including while paused.
  await startPair();
  await pauseTogether().click();
  await page.locator('button').filter({has:page.locator('svg.lucide-gauge')}).click();
  state=await snapshot();assert(state.every(a=>a.rate===1.5),'shared speed applies to both players');
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>qaSnapshot().every(a=>!a.paused));
  // A/B exits the pair and starts the original only, then the recording.
  await page.evaluate(()=>{qaCalls=[]});
  await page.getByRole('button',{name:'原声/录音对比',exact:true}).click();
  state=await snapshot();assert(!state[0].paused&&state[1].paused,'A/B starts with original only');
  await page.waitForFunction(()=>qaCalls.length===2,{timeout:10000});
  const abCalls=await page.evaluate(()=>qaCalls);
  assert(abCalls[1].at-abCalls[0].at>500,'A/B remains sequential');
  await page.getByRole('button',{name:'原声/录音对比',exact:true}).click();
  assert((await snapshot()).every(a=>a.paused),'cancel A/B stops both');
  // Recording ends first; the original must continue once, then stop.
  console.log('PASS: original shorter, pause/resume, seek exit, shared speed and A/B.');
  await loadSentence(3);
  await startPair();
  await page.waitForFunction(()=>qaSnapshot()[1].ended&&!qaSnapshot()[0].paused,{timeout:10000});
  const recordingPlays=await page.evaluate(()=>qaCalls.filter(c=>c.id===qaPair[1]).length);
  await pauseTogether().click();await page.keyboard.press('Space');
  await page.waitForFunction(()=>!qaSnapshot()[0].paused);
  state=await snapshot();assert(state[1].ended&&state[1].paused);
  assert.equal(await page.evaluate(()=>qaCalls.filter(c=>c.id===qaPair[1]).length),recordingPlays);
  await playTogether().waitFor({timeout:10000});
  assert((await snapshot()).every(a=>a.paused));
  // Sentence changes immediately cancel both tracks and require a new recording selection.
  await startPair();await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(()=>qaSnapshot().every(a=>a.paused));
  assert(await playTogether().isDisabled(),'changing sentence disables pair until recording loaded');
  console.log('PASS: recording shorter and sentence change cleanup.');
  await loadSentence(0);
  await startPair();
  await page.screenshot({path:path.join(qa,'simultaneous-playback.png'),fullPage:true});
  // A freshly captured microphone recording can also be played together.
  const savedPromise=page.waitForResponse(r=>r.url().endsWith('/sentence/0/save')&&r.request().method()==='POST');
  savedPromise.catch(()=>{});
  await page.locator('button').filter({has:page.locator('svg.lucide-mic')}).click();
  await page.waitForSelector('canvas[width="160"]');
  assert((await snapshot()).every(a=>a.paused),'recording stops both comparison tracks');
  await page.waitForTimeout(1200);await page.keyboard.press('KeyR');
  const saved=await savedPromise;assert(saved.ok());fixture.records.push((await saved.json()).id);
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='原音与录音同时播放'&&!b.disabled));
  await startPair();
  await page.locator('[part="scroll"]').last().click({position:{x:80,y:20}});
  await playTogether().waitFor();
  await page.evaluate(()=>{qaRejectNextPlay=true});
  await playTogether().click();
  await page.getByRole('alert').filter({hasText:'音频播放失败'}).waitFor();
  assert((await snapshot()).every(a=>a.paused),'play failure stops both tracks');
  await startPair();
  await pauseTogether().click();
  assert.deepEqual(errors,[]);
  console.log('PASS: fresh microphone recording, recoverable visible playback error, no browser errors.');
  console.log('PASS: simultaneous zero starts; shared pause/resume; both length orders; finished track stays finished; no loop; waveform seek exit; shared speed; A/B preserved; sentence switch cleanup; no browser errors.');
 }catch(error){
  if(context){const pages=context.pages();if(pages.length){await pages[0].screenshot({path:path.join(qa,"simultaneous-failure.png"),fullPage:true});console.error((await pages[0].locator("body").innerText()).slice(-2000))}}
  throw error;
 }finally{
  if(context){
   for(const id of fixture.records){const r=await context.request.delete(base+'/api/practice/record/'+id);assert([204,404].includes(r.status()))}
   const r=await context.request.delete(base+'/api/audio/'+fixture.id);assert([204,404].includes(r.status()));
  }
  if(browser)await browser.close();
 }
})().catch(e=>{console.error(e);process.exit(1)});
