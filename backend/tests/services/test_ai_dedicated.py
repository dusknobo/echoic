"""Provider protocol tests use fake credentials and never contact external services."""
import asyncio
import base64
import io
import json
from urllib.parse import parse_qs, urlsplit
import wave

import httpx
import pytest
from app.services.ai_assessment import dedicated as service

TENCENT = {"app_id": "123456", "secret_id": "test-id", "secret_key": "test-secret"}
IFLYTEK = {"app_id": "fake-app", "api_key": "fake-key", "api_secret": "fake-secret"}
PCM = b"\0\0" * 640
XML = b'''<xml_result><read_sentence><rec_paper><read_sentence total_score="84"
 accuracy_score="86" fluency_score="80" integrity_score="100" standard_score="0"
 is_rejected="false" except_info="0"><sentence>
 <word content="turn" total_score="82" beg_pos="10" end_pos="40" property="16" dp_message="0">
 <syll><phone content="t"/><phone content="er"/><phone content="n"/></syll></word>
 <word content="off" total_score="85" beg_pos="40" end_pos="70" property="16" werr_msg="512"/>
 </sentence></read_sentence></rec_paper></read_sentence></xml_result>'''

class Socket:
    def __init__(self, messages, final_after_upload=False):
        self.messages, self.sent, self.closed = list(messages), [], False
        self.final_after_upload, self.upload_done = final_after_upload, asyncio.Event()
    async def send(self, message):
        self.sent.append(message)
        if isinstance(message, str) and json.loads(message).get("data", {}).get("status") == 2:
            self.upload_done.set()
    async def recv(self):
        if self.final_after_upload:
            await self.upload_done.wait()
        if not self.messages:
            raise RuntimeError("signed-url-secret-should-not-escape")
        message = self.messages.pop(0)
        if isinstance(message, Exception):
            raise message
        return json.dumps(message)
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_):
        self.closed = True

def connect(monkeypatch, socket):
    calls = []
    def factory(url, **kwargs):
        calls.append((url, kwargs))
        return socket
    monkeypatch.setattr(service.websockets, "connect", factory)
    return calls

@pytest.mark.parametrize("value,expected", [(None,None),("bad",None),(True,None),(float("nan"),None),
    (float("inf"),None),(-1,None),(0,0),(101,100),("45.678",45.68)])
def test_score_validation(value, expected):
    assert service._score(value) == expected

def test_tencent_signature_raw_sort_then_url_encode():
    url = service.tencent_signed_url(TENCENT, "Hello & world!", now=1700000000, nonce=123, voice_id="fixed-id")
    parts, query = urlsplit(url), parse_qs(urlsplit(url).query)
    assert parts.path == "/soe/api/123456"
    assert query["signature"] == ["vN4yWVKy6t5TIgGELEuu86Hyn9g="]
    assert query["ref_text"] == ["Hello & world!"]
    assert "Hello%20%26%20world%21" in parts.query
    assert query["rec_mode"] == ["1"] and query["voice_format"] == ["0"]
    assert query["score_coeff"] == ["4.0"]

def test_iflytek_signature_path_and_date():
    parts = urlsplit(service.iflytek_signed_url(IFLYTEK, date="Wed, 10 Jul 2019 07:35:43 GMT"))
    query = parse_qs(parts.query)
    auth = base64.b64decode(query["authorization"][0]).decode()
    assert parts.path == "/v2/open-ise"
    assert query["date"] == ["Wed, 10 Jul 2019 07:35:43 GMT"]
    assert 'signature="6QfpR82CGu2df89BKxgfrxnSdxhRlVkuab4s4hnhJts="' in auth

@pytest.mark.parametrize("provider,config", [("tencent",{**TENCENT,"endpoint":"ws://host/soe"}),
    ("iflytek",{**IFLYTEK,"endpoint":"wss://user:password@host/ise"}),
    ("azure",{"api_key":"fake","endpoint":"https://host/?key=bad"})])
async def test_unsafe_endpoint_forms(provider, config):
    with pytest.raises(service.ProviderError, match="接口地址"):
        await service.assess(provider, config, PCM, "hello")

@pytest.mark.parametrize("pcm,text", [(b"","hi"),(b"a","hi"),(PCM,""),(b"\0"*(32000*60+2),"hi")], ids=["empty", "odd-bytes", "missing-text", "over-limit"])
async def test_invalid_input_precedes_credentials_or_network(pcm, text):
    with pytest.raises(service.ProviderError):
        await service.assess("azure", {}, pcm, text)

def test_tencent_scale_sentinel_and_phonemes():
    result = service.normalize_tencent({"PronAccuracy":90,"PronFluency":.87,"PronCompletion":.95,
        "SuggestedScore":91,"Words":[{"Word":"hello","PronAccuracy":-1,"MatchTag":3,
        "MemBeginTime":100,"MemEndTime":600,"PhoneInfos":[{"Phone":"h","ReferencePhone":"hh",
        "PronAccuracy":70,"Stress":True,"DetectedStress":False}]}]})
    assert result["fluency_score"] == 87 and result["completeness_score"] == 95
    word = result["words"][0]
    assert word["accuracy_score"] is None and word["error_type"] == "Mispronunciation"
    assert word["start"] == .1 and word["end"] == .6
    assert word["expected_phonemes"] == "hh" and word["actual_phonemes"] == "h"
    assert word["phoneme_scores"][0]["score"] == 70
    assert result["connected_speech"][0]["evidence"] == "measured"

def test_tencent_paragraph_times_are_not_valid():
    result = service.normalize_tencent({"Words":[{"Word":"hi","MemBeginTime":0,"MemEndTime":500}],
        "PronFluency":-1}, paragraph=True)
    assert "start" not in result["words"][0] and result["fluency_score"] is None

async def test_tencent_sends_recording_once_and_keeps_aggregate(monkeypatch):
    socket = Socket([{"code":0},{"code":0,"result":{"SentenceId":0,"PronAccuracy":20,
        "Words":[{"Word":"hello","PronAccuracy":20}]}},{"code":0,"result":json.dumps({
        "SentenceId":-1,"PronAccuracy":80,"SuggestedScore":82,"PronFluency":.8})},{"code":0,"final":1}])
    calls = connect(monkeypatch, socket)
    result = await service.assess("tencent", TENCENT, PCM, "hello")
    assert result["accuracy_score"] == 80 and result["overall_score"] == 82
    assert result["words"][0]["word"] == "hello"
    assert socket.sent == [PCM,'{"type": "end"}'] and socket.closed
    assert calls[0][1]["proxy"] is None

async def test_tencent_last_sentence_is_not_overall_score(monkeypatch):
    socket = Socket([{"code":0},{"code":0,"result":{"SentenceId":0,"PronAccuracy":20,
        "Words":[{"Word":"hello"}]}},{"code":0,"result":{"SentenceId":1,"PronAccuracy":90,
        "Words":[{"Word":"world"}]}},{"code":0,"final":1}])
    connect(monkeypatch, socket)
    result = await service.assess("tencent", TENCENT, PCM, "hello world")
    assert result["accuracy_score"] is None
    assert [w["word"] for w in result["words"]] == ["hello","world"]

async def test_tencent_handshake_failure_does_not_upload_or_leak(monkeypatch):
    socket = Socket([{"code":4002,"message":"SECRET_VALUE"}])
    connect(monkeypatch, socket)
    with pytest.raises(service.ProviderError, match="鉴权失败") as caught:
        await service.assess("tencent", TENCENT, PCM, "hello")
    assert not socket.sent and socket.closed and "SECRET_VALUE" not in str(caught.value)

async def test_tencent_requires_final_and_sanitizes_socket_exceptions(monkeypatch):
    socket = Socket([{"code":0},{"code":0,"result":{"PronAccuracy":90}}])
    connect(monkeypatch, socket)
    with pytest.raises(service.ProviderError) as caught:
        await service.assess("tencent", TENCENT, PCM, "hello")
    assert "signed-url" not in str(caught.value) and socket.closed

def azure_payload(nested=False):
    assessment = {"AccuracyScore":82,"FluencyScore":71,"CompletenessScore":100,"ProsodyScore":65,"PronScore":78}
    score = {"AccuracyScore":81,"ErrorType":"None"}
    word = {"Word":"hello","Offset":1000000,"Duration":4000000,"Phonemes":[{"Phoneme":"h",
        "PronunciationAssessment":{"AccuracyScore":75}}],"Feedback":{"Prosody":{"Break":{
        "ErrorTypes":["UnexpectedBreak"],"MissingBreak":{"Confidence":1.0}}}}}
    if nested:
        word["PronunciationAssessment"] = score
        best = {"PronunciationAssessment":assessment,"Words":[word]}
    else:
        word.update(score)
        best = {**assessment,"Words":[word]}
    return {"RecognitionStatus":"Success","NBest":[best]}

@pytest.mark.parametrize("nested", [True,False])
def test_azure_flat_and_nested_response_fields(nested):
    result = service.normalize_azure(azure_payload(nested))
    assert result["overall_score"] == 78 and result["prosody_score"] == 65
    word = result["words"][0]
    assert word["accuracy_score"] == 81 and word["start"] == .1 and word["end"] == .5
    assert "actual_phonemes" not in word and word["phoneme_scores"][0]["score"] == 75
    assert len(result["connected_speech"]) == 1  # Confidence by itself is not a diagnosed error.

@pytest.mark.parametrize("language,prosody", [("en-US",True),("en-GB",False)])
async def test_azure_wav_header_and_prosody_language(monkeypatch, language, prosody):
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200,json=azure_payload())
    original = httpx.AsyncClient
    monkeypatch.setattr(service.httpx,"AsyncClient",lambda **kwargs:original(transport=httpx.MockTransport(handle),**kwargs))
    await service.assess("azure",{"api_key":"fake","region":"eastus","language":language},PCM,"hello")
    request = requests[0]
    assert str(request.url).startswith("https://eastus.stt.speech.microsoft.com/speech/recognition/")
    assert request.url.params["format"] == "detailed" and request.url.params["language"] == language
    params = json.loads(base64.b64decode(request.headers["Pronunciation-Assessment"]))
    assert params["ReferenceText"] == "hello" and params["Granularity"] == "Phoneme"
    assert params["GradingSystem"] == "HundredMark" and params["EnableMiscue"] is True
    assert bool(params.get("EnableProsodyAssessment")) is prosody
    with wave.open(io.BytesIO(request.content)) as audio:
        assert audio.getframerate() == 16000 and audio.getnchannels() == 1
        assert audio.readframes(audio.getnframes()) == PCM

async def test_azure_failed_http_hides_response_body(monkeypatch):
    original = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request:httpx.Response(401,text="FAKE_KEY"))
    monkeypatch.setattr(service.httpx,"AsyncClient",lambda **kwargs:original(transport=transport,**kwargs))
    with pytest.raises(service.ProviderError,match="鉴权失败") as caught:
        await service.assess("azure",{"api_key":"fake","region":"eastus"},PCM,"hello")
    assert "FAKE_KEY" not in str(caught.value)

@pytest.mark.parametrize("payload", [{"RecognitionStatus":"NoMatch"},{"RecognitionStatus":"Success","NBest":[]}])
def test_azure_invalid_result_is_not_zero_score(payload):
    with pytest.raises(service.ProviderError):
        service.normalize_azure(payload)

def test_iflytek_bom_text_and_hundredmark_settings():
    message = service.iflytek_initial_message(IFLYTEK,"turn off")
    business = message["business"]
    assert business["text"] == "\ufeff[content]\nturn off"
    assert business["cmd"] == "ssb" and message["data"]["status"] == 0
    assert business["aue"] == "raw" and business["ise_unite"] == "1"
    assert "multi_dimension" in business["extra_ability"]

def test_iflytek_reference_and_uncertain_linking_stay_distinct():
    result = service.normalize_iflytek(XML)
    assert result["accuracy_score"] == 86 and result["overall_score"] == 84
    assert result["prosody_score"] is None
    word = result["words"][0]
    assert word["accuracy_score"] is None and word["overall_score"] == 82
    assert word["expected_phonemes"] == "t er n" and "actual_phonemes" not in word
    assert word["start"] == .1 and word["end"] == .4
    assert [x["evidence"] for x in result["connected_speech"]] == ["reference","uncertain"]

@pytest.mark.parametrize("xml", [b'<xml_result/>',b'<xml_result><',
    b'<!DOCTYPE foo [<!ENTITY x "hello">]><xml_result/>',XML.replace(b'is_rejected="false"',b'is_rejected="true"')])
def test_iflytek_invalid_xml_or_rejection(xml):
    with pytest.raises(service.ProviderError):
        service.normalize_iflytek(xml)

async def test_iflytek_stream_first_middle_final_and_close(monkeypatch):
    socket = Socket([{"code":0,"data":{"status":2,"data":base64.b64encode(XML).decode()}}],final_after_upload=True)
    connect(monkeypatch,socket)
    pcm = PCM*2
    result = await service.assess("iflytek",IFLYTEK,pcm,"turn off")
    sent = [json.loads(value) for value in socket.sent]
    assert sent[0]["business"]["cmd"] == "ssb"
    assert [x["business"]["aus"] for x in sent[1:]] == [1,2,4]
    assert [x["data"]["status"] for x in sent] == [0,1,1,2]
    assert b"".join(base64.b64decode(x["data"]["data"]) for x in sent[1:]) == pcm
    assert result["overall_score"] == 84 and socket.closed

async def test_iflytek_rejection_stops_upload_and_hides_server_message(monkeypatch):
    socket = Socket([{"code":11200,"message":"TOKEN"}])
    connect(monkeypatch,socket)
    with pytest.raises(service.ProviderError,match="未授权") as caught:
        await service.assess("iflytek",IFLYTEK,PCM*100,"turn off")
    assert "TOKEN" not in str(caught.value) and len(socket.sent) < 5 and socket.closed
    count = len(socket.sent)
    await asyncio.sleep(.06)
    assert len(socket.sent) == count

async def test_iflytek_malformed_final_is_not_partial_success(monkeypatch):
    socket = Socket([{"code":0,"data":{"status":2,"data":"not base64 !!!"}}],final_after_upload=True)
    connect(monkeypatch,socket)
    with pytest.raises(service.ProviderError,match="无法解析"):
        await service.assess("iflytek",IFLYTEK,PCM,"hello")
    assert socket.closed
