const { launchBrowser } = require('./qa_support.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root=path.resolve(__dirname,'..'), base='http://127.0.0.1:18766', backend='http://127.0.0.1:18765';
const wav=fs.readFileSync(path.join(root,'.runtime/qa/pair-recording-0.wav'));
const tokens=['The','weather','is','getting','colder.','The','weather','is','getting','colder.'];
const sentence={index:0,text:tokens.join(' '),start:0,end:5,words:tokens.map((word,index)=>({word,start:0.5+index*0.45,end:0.75+index*0.45}))};
const timingWords=tokens.map((word,index)=>({word,start:0.2+index*0.5,end:0.5+index*0.5}));
const records=[900001,900002].map(id=>({id,created_at:'2026-10-11T10:00:00',accuracy_score:null,fluency_score:null,completeness_score:null,word_scores:[],sentence_index:0}));
const analysis=(recordId,id)=>({id,record_id:recordId,provider:'openai',kind:'feedback',created_at:'2026-10-11T10:00:00',words:[{word:'weather',accuracy_score:72,feedback:'请回听齿音。'},{word:'sunshine',accuracy_score:null}],feedback:'练习逐词和连读回听。',connected_speech:[{text:'is getting',category:'连读',observation:'注意衔接。',suggestion:'对比两段录音。',evidence:'uncertain'}],limitations:[]});
(async()=>{let browser;try{
 browser=await launchBrowser({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:960},locale:'zh-CN'});
 await context.addInitScript(()=>{
  localStorage.setItem('echoic.playbackSpeed','1');window.qaMedia=[];window.qaPlays=[];
  const play=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(...args){if(!qaMedia.includes(this))qaMedia.push(this);const call={id:qaMedia.indexOf(this),src:this.src,duration:null};qaPlays.push(call);const pending=play.apply(this,args);pending.then(()=>call.duration=this.duration,()=>{});return pending};
 });
 const page=await context.newPage(),errors=[],alignmentCalls=[],aiCalls=[];
 page.on('pageerror',error=>errors.push(error.message));
 const original=await (await context.request.get(backend+'/api/audio/1')).json();
 const stored=new Map(records.map(record=>[record.id,[analysis(record.id,record.id*10),analysis(record.id,record.id*10+1)]]));
 await page.route(base+'/api/**',async route=>{
  const request=route.request(),pathname=new URL(request.url()).pathname;
  if(pathname==='/api/audio/1')return route.fulfill({json:{...original,sentences:[sentence]}});
  if(pathname==='/api/audio/1/stream')return route.fulfill({body:wav,contentType:'audio/wav'});
  if(pathname==='/api/ai/settings')return route.fulfill({json:{enabled:true,analysis_provider:'openai',providers:{openai:{configured:true,errors:[]}}}});
  const analysisHistory=pathname.match(/\/api\/ai\/records\/(\d+)\/analyses$/);
  if(analysisHistory)return route.fulfill({json:stored.get(Number(analysisHistory[1]))||[]});
  if(pathname.endsWith('/analyze')){aiCalls.push(pathname);return route.fulfill({status:500,json:{detail:'Unexpected AI submission in playback QA'}});}
  if(pathname==='/api/practice/1/sentence/0/history')return route.fulfill({json:records});
  const timing=pathname.match(/\/api\/practice\/record\/(\d+)\/word-timings$/);
  if(timing){const recordId=Number(timing[1]);alignmentCalls.push(recordId);await new Promise(resolve=>setTimeout(resolve,650));return route.fulfill({json:{record_id:recordId,source:'local_alignment',words:timingWords,duration:6}}).catch(()=>{});}
  if(/\/api\/practice\/record\/90000[12]\/stream$/.test(pathname))return route.fulfill({body:wav,contentType:'audio/wav'});
  const response=await route.fetch({url:backend+pathname+new URL(request.url()).search});return route.fulfill({response});
 });
 await page.goto(base+'/speaking/1?time=0');
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.getAttribute('aria-label')==='播放原音'&&!button.disabled));
 await page.getByRole('tab',{name:'我的练习',exact:true}).click();
 const cards=()=>page.locator('[role="tabpanel"] .cursor-pointer.rounded-lg.border');
 await cards().first().click();await page.getByTestId('ai-analysis-result').waitFor();
 const compare=()=>page.getByTestId('ai-comparison-panel');
 const sourceButton=source=>compare().getByRole('button',{name:source,exact:true});
 const playCount=()=>page.evaluate(()=>qaPlays.length);
 const chooseOccurrence=async index=>{const select=compare().getByLabel('回听出现位置',{exact:true});await select.selectOption({index});};
 const nextClip=async(button,expected)=>{
  const before=await playCount();await button.click();await page.waitForFunction(count=>qaPlays.length>count&&Number.isFinite(qaPlays.at(-1).duration),before);
  const call=await page.evaluate(()=>qaPlays.at(-1));assert(Math.abs(call.duration-expected)<0.035,'Expected '+expected+'s clip, got '+call.duration+'s');
  assert(await page.evaluate(()=>qaMedia.filter(audio=>!audio.paused).length<=1),'Only one track may play');return call;
 };
 // Selecting an issue must be silent, and repeated words must not guess an occurrence.
 const beforeSelect=await playCount();await page.getByRole('button',{name:'对比回听：weather',exact:true}).click();
 assert.equal(await playCount(),beforeSelect);assert.equal(await compare().getByLabel('回听出现位置').locator('option').count(),3);
 assert(await sourceButton('原音').isDisabled());assert(await sourceButton('我的录音').isDisabled());
 await chooseOccurrence(2);await nextClip(sourceButton('原音'),0.32);
 await page.waitForFunction(()=>qaMedia.every(audio=>audio.paused));
 // Stop a delayed local alignment before it can start audio; reuse its result on retry.
 const beforeLoad=await playCount();await sourceButton('我的录音').click();
 await compare().getByText('正在准备回听片段…',{exact:true}).waitFor();await sourceButton('停止').click();await page.waitForTimeout(800);
 assert.equal(await playCount(),beforeLoad,'Stopped preparation must never start audio later');
 await nextClip(sourceButton('我的录音'),0.37);assert.deepEqual(alignmentCalls,[900001]);
 await page.waitForFunction(()=>qaMedia.every(audio=>audio.paused));
 // Repeated phrase selection uses a longer, real decoded clip, and switching source pauses it.
 await page.getByRole('button',{name:'对比回听：is getting',exact:true}).click();
 assert(await sourceButton('原音').isDisabled());await chooseOccurrence(1);
 const originalClip=await nextClip(sourceButton('原音'),0.9);
 await nextClip(sourceButton('我的录音'),1.0);
 assert(await page.evaluate(id=>qaMedia[id].paused,originalClip.id),'Switching to recording pauses original clip');
 await sourceButton('停止').click();assert(await page.evaluate(()=>qaMedia.every(audio=>audio.paused)));
 // Unmatched text offers only clearly labelled whole-sentence alternatives.
 await page.getByRole('button',{name:'对比回听：sunshine',exact:true}).click();
 await compare().getByText('这段文字未匹配到参考句子，无法定位单词或短语。可以先回听整句。',{exact:true}).waitFor();
 assert.equal(await sourceButton('原音').count(),0);assert.equal(await sourceButton('我的录音').count(),0);
 await nextClip(sourceButton('整句原音'),5);await nextClip(sourceButton('整句录音'),6);
 // Switching the selected persisted analysis stops its audio and clears selected issue UI.
 await page.getByLabel('已保存的分析',{exact:true}).selectOption(String(900001*10+1));
 assert(await page.evaluate(()=>qaMedia.every(audio=>audio.paused)));assert.equal(await page.getByTestId('ai-comparison-panel').count(),0);
 // A delayed alignment for another record cannot start after switching away.
 await cards().nth(1).click();await page.getByTestId('ai-analysis-result').waitFor();
 await page.getByRole('button',{name:'对比回听：weather',exact:true}).click();await chooseOccurrence(1);
 const beforeStale=await playCount();await sourceButton('我的录音').click();await compare().getByText('正在准备回听片段…',{exact:true}).waitFor();
 await cards().first().click();await page.waitForTimeout(900);
 assert.equal(await playCount(),beforeStale);assert(await page.evaluate(()=>qaMedia.every(audio=>audio.paused)));
 assert.equal(await page.getByTestId('ai-comparison-panel').count(),0);assert.equal(aiCalls.length,0);
 // Normal original playback cancels the AI clip rather than overlapping.
 await page.getByRole('button',{name:'对比回听：sunshine',exact:true}).click();await nextClip(sourceButton('整句录音'),6);
 const aiId=await page.evaluate(()=>qaPlays.at(-1).id);
 await page.getByRole('button',{name:'播放原音',exact:true}).click();await page.getByRole('button',{name:'暂停原音',exact:true}).waitFor();
 assert(await page.evaluate(id=>qaMedia[id].paused,aiId));
 await page.getByRole('button',{name:'暂停原音',exact:true}).click();
 await page.getByRole('button',{name:'播放原音',exact:true}).waitFor();
 await page.getByRole('button',{name:'对比回听：weather',exact:true}).click();await chooseOccurrence(1);
 await page.waitForFunction(()=>{const panel=document.querySelector('[data-testid=ai-comparison-panel]');return [...panel.querySelectorAll('button')].some(button=>button.textContent==='原音'&&!button.disabled)});
 await page.screenshot({path:path.join(root,'.runtime/qa/ai-comparison.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: silent issue selection, repeated occurrence choice, decoded word/phrase durations for both sources, delayed preparation stop/retry, single active track, explicit whole-sentence fallback, persisted analysis/record switch cancellation, and no cloud AI or real alignment calls.');
}finally{await browser?.close()}})().catch(error=>{console.error(error);process.exitCode=1});
