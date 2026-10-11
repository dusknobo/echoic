const { launchBrowser } = require('./qa_support.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),qa=path.join(root,'.runtime','qa'),base='http://127.0.0.1:18765';
(async()=>{
 let browser,context;const records=[];
 try {
  browser=await launchBrowser({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+path.join(qa,'sentence.wav')]});
  context=await browser.newContext({viewport:{width:1280,height:960},locale:'zh-CN',permissions:['microphone']});
  await context.addInitScript(()=>{
   localStorage.setItem('echoic.playbackSpeed','1');window.qaMedia=[];window.qaPlays=[];
   const play=HTMLMediaElement.prototype.play;
   HTMLMediaElement.prototype.play=function(...args){
    if(!qaMedia.includes(this))qaMedia.push(this);
    const call={id:qaMedia.indexOf(this),at:performance.now(),src:this.src,duration:null};qaPlays.push(call);
    const promise=play.apply(this,args);promise.then(()=>{call.duration=this.duration},()=>{});return promise;
   };
  });
  const page=await context.newPage(),errors=[],scoreCalls=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.url().endsWith('/score'))scoreCalls.push(r.url())});
  const word=text=>page.getByRole('button',{name:'听发音并查看英文释义：'+text,exact:true});
  const details=()=>page.getByRole('region',{name:'单词发音与英文释义'});
  const waitDefinitions=()=>details().getByText('英文释义',{exact:true}).waitFor();
  const ready=()=>page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='播放原音'&&!b.disabled));
  await page.goto(base+'/speaking/1?time=0');await ready();
  await word('weather').click();
  await details().getByText('Princeton WordNet 3.0',{exact:true}).waitFor();
  await details().getByText('原音中的发音',{exact:true}).waitFor();
  await page.waitForFunction(()=>qaPlays.some(c=>c.duration>0&&c.duration<0.5));
  assert((await details().innerText()).includes('noun'));
  const clip=await page.evaluate(()=>qaPlays.at(-1));assert(clip.duration>=0.3&&clip.duration<=0.4,'plays only the original weather word');
  await page.waitForTimeout(500);
  assert(await page.evaluate(()=>qaMedia.every(a=>a.paused)),'single word finishes without sentence looping');
  const before=await page.evaluate(()=>qaPlays.length);
  await details().getByRole('button',{name:'听单词',exact:true}).click();
  await page.waitForFunction(count=>qaPlays.length>count,before);
  // Start normal playback, then a word. The two never overlap.
  await page.getByRole('button',{name:'播放原音',exact:true}).click();
  const originalId=await page.evaluate(()=>qaPlays.at(-1).id);
  await word('colder.').click();
  assert(await page.evaluate(id=>qaMedia[id].paused,originalId));
  await details().getByText('词典原形：cold',{exact:true}).waitFor();
  // Slow, cancelled lookups must not replace the currently selected word.
  await page.route(base+'/api/dictionary/en/is',async route=>{await new Promise(resolve=>setTimeout(resolve,350));await route.fulfill({json:{word:'is',meanings:[],source:'delayed-old-result'}}).catch(()=>{})});
  await word('is').click();await word('getting').click();
  await details().getByRole('heading',{name:'getting',exact:true}).waitFor();
  await details().getByText('Princeton WordNet 3.0',{exact:true}).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByText('delayed-old-result',{exact:true}).count(),0);
  await page.unroute(base+'/api/dictionary/en/is');
  console.log('PASS: clickable original word clips, English definitions, inflections, replay, no loops, single-track exclusion and cancelled lookups.');
  // Load a temporary recording and confirm word playback cancels a simultaneous pair.
  const saved=await context.request.post(base+'/api/practice/1/sentence/0/save',{multipart:{file:{name:'word-study-qa.wav',mimeType:'audio/wav',buffer:fs.readFileSync(path.join(qa,'pair-recording-0.wav'))}}});
  assert(saved.ok());records.push((await saved.json()).id);
  await page.reload();await ready();
  await page.getByRole('tab',{name:'我的练习',exact:true}).click();
  await page.locator('[role="tabpanel"] .cursor-pointer.rounded-lg.border').first().click();
  const together=page.getByRole('button',{name:'原音与录音同时播放',exact:true});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='原音与录音同时播放'&&!b.disabled));
  await page.evaluate(()=>{qaPlays=[]});await together.click();
  await page.waitForFunction(()=>qaPlays.length===2);
  const pairIds=await page.evaluate(()=>qaPlays.map(c=>c.id));
  await page.getByRole('tab',{name:'翻译与分析',exact:true}).click();await word('weather').click();
  assert(await page.evaluate(ids=>ids.every(id=>qaMedia[id].paused),pairIds),'clicking word stops both comparison tracks');
  await together.waitFor();
  await word('getting').focus();await page.keyboard.press('Enter');
  await details().getByRole('heading',{name:'getting',exact:true}).waitFor();
  assert.equal(scoreCalls.length,0,'Enter on a word never submits recording for scoring');
  await page.screenshot({path:path.join(qa,'word-study.png'),fullPage:true});
  // Recording still allows lookup but disables word audio.
  await page.locator('button').filter({has:page.locator('svg.lucide-mic')}).click();
  await page.waitForSelector('canvas[width="160"]');
  assert(await details().getByRole('button',{name:'听单词',exact:true}).isDisabled());
  await page.evaluate(()=>{qaPlays=[]});await word('The').click();
  await details().getByText('Echoic usage notes',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>qaPlays.length),0,'lookup during recording does not make sound');
  const recSave=page.waitForResponse(r=>r.url().endsWith('/sentence/0/save')&&r.request().method()==='POST');recSave.catch(()=>{});
  await page.waitForTimeout(1000);await page.keyboard.press('KeyR');
  const recorded=await recSave;assert(recorded.ok());records.push((await recorded.json()).id);
  console.log('PASS: word playback stops simultaneous comparison, keyboard lookup does not score, recording lookup stays silent.');
  // Without word timestamps, pronunciation comes from the actual local eSpeak endpoint.
  const audio=await (await context.request.get(base+'/api/audio/1')).json();
  const alternate={...audio,sentences:[{...audio.sentences[0],text:'Hello qzxqzx dogs.',words:[]}]};
  await page.route(base+'/api/audio/1',route=>route.fulfill({json:alternate}));
  await page.route(base+'/api/dictionary/en/hello',route=>route.fulfill({status:503,json:{detail:'QA unavailable'}}));
  await page.reload();await ready();
  const speechResponse=page.waitForResponse(r=>r.url().endsWith('/api/word-speech/en/hello'));speechResponse.catch(()=>{});
  await word('Hello').click();assert((await speechResponse).ok());
  await details().getByText('单词朗读',{exact:true}).waitFor();
  await details().getByText('暂时无法读取词典，请重试。',{exact:true}).waitFor();
  await page.unroute(base+'/api/dictionary/en/hello');
  await details().getByRole('button',{name:'重试查词',exact:true}).click();
  await details().getByText('Princeton WordNet 3.0',{exact:true}).waitFor();
  await word('qzxqzx').click();
  await details().getByText('词典暂未收录这个词。你仍可以听它的发音。',{exact:true}).waitFor();
  await word('dogs.').click();await details().getByText('词典原形：dog',{exact:true}).waitFor();
  await details().getByRole('button',{name:'关闭单词释义',exact:true}).click();
  assert.equal(await details().count(),0);
  await page.waitForTimeout(200);
  assert(await page.evaluate(()=>qaMedia.every(a=>a.paused)),'closing card stops word audio');
  assert.deepEqual(errors,[]);
  console.log('PASS: real offline speech fallback without timestamps, dictionary retry, missing words, base forms, close cleanup, no browser errors.');
 }catch(error){
  if(context&&context.pages().length){const page=context.pages()[0];await page.screenshot({path:path.join(qa,'word-study-failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(-2500))}
  throw error;
 }finally{
  if(context){for(const id of records){const r=await context.request.delete(base+'/api/practice/record/'+id);assert([204,404].includes(r.status()))}}
  if(browser)await browser.close();
 }
})().catch(e=>{console.error(e);process.exit(1)});
