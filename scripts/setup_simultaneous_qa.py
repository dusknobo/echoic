from pathlib import Path
import sqlite3, json, shutil, datetime, uuid, wave, math, struct, requests
root=Path(__file__).resolve().parent.parent
qa=root/'.runtime'/'qa'
key='audio/'+uuid.uuid4().hex+'.wav'
shutil.copy2(qa/'reference.wav',root/'.runtime'/'storage'/key)
sentences=[{'index':0,'text':'Short original.','start':0,'end':2,'words':[{'word':'Short','start':0,'end':1},{'word':'original.','start':1,'end':2}],'word_phonemes':[{'word':'Short','ipa':'short'},{'word':'original.','ipa':'original'}]}, {'index':1,'text':'Long original.','start':2,'end':8,'words':[{'word':'Long','start':2,'end':5},{'word':'original.','start':5,'end':8}],'word_phonemes':[{'word':'Long','ipa':'long'},{'word':'original.','ipa':'original'}]}]
with sqlite3.connect(root/'.runtime'/'echoic.db',timeout=15) as db:
    cursor=db.execute('INSERT INTO audio_files(title,source_type,storage_backend,language,file_path,sentences,created_at) VALUES(?,?,?,?,?,?,?)',('Codex temporary simultaneous playback QA','upload','local','en',key,json.dumps(sentences),datetime.datetime.now(datetime.timezone.utc).isoformat()))
    audio_id=cursor.lastrowid
session=requests.Session()
session.trust_env=False
records=[]
for index,duration in [(0,6),(1,2)]:
    recording=qa/('pair-recording-'+str(index)+'.wav')
    with wave.open(str(recording),'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000)
        wav.writeframes(b''.join(struct.pack('<h',int(3000*math.sin(2*math.pi*330*n/16000))) for n in range(16000*duration)))
    with recording.open('rb') as f:
        resp=session.post(f'http://127.0.0.1:18765/api/practice/{audio_id}/sentence/{index}/save',files={'file':(recording.name,f,'audio/wav')},timeout=30)
    resp.raise_for_status()
    records.append(resp.json()['id'])
(qa/'pair-audio.json').write_text(json.dumps({'id':audio_id,'records':records}),encoding='utf-8')
print(json.dumps({'id':audio_id,'records':records}))
