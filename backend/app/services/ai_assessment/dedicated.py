"""Native pronunciation providers. Never log signed URLs or provider response bodies.

Wire protocols: Tencent SOE-N /1774/107497; Azure short-audio REST;
iFlytek streaming ISE /doc/Ise/IseAPI.html. Input is 16 kHz mono s16le PCM.
"""

import asyncio
import base64
from datetime import datetime, timezone
from email.utils import format_datetime
import hashlib
import hmac
import io
import json
import math
import re
import secrets
import time
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
import uuid
import wave
import xml.etree.ElementTree as ET

import httpx
import websockets


class ProviderError(ValueError):
    """A safe message that may be returned to the user without credential leakage."""


_PCM_BYTES_PER_SECOND = 32000
_MAX_SECONDS = 60
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _score(value, *, fraction=False):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return round(max(0.0, min(100.0, value * (100 if fraction else 1))), 2)


def _seconds(value, divisor):
    if isinstance(value, bool):
        return None
    try:
        value = float(value) / divisor
    except (TypeError, ValueError, OverflowError):
        return None
    return round(value, 6) if math.isfinite(value) and value >= 0 else None


def _text(value, limit=1000):
    return value[:limit] if isinstance(value, str) else ""


def _object(value):
    if isinstance(value, str):
        if len(value.encode("utf-8")) > _MAX_RESPONSE_BYTES:
            raise ProviderError("评测服务返回的数据过大。")
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            raise ProviderError("评测服务返回了无法解析的数据。") from None
    if not isinstance(value, dict):
        raise ProviderError("评测服务返回的数据格式不正确。")
    return value


def _list(value):
    return value if isinstance(value, list) else []


def _required(config, key, label):
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ProviderError(f"请先在 AI 设置中填写{label}。")
    return value.strip()


def _endpoint(value, default, scheme):
    value = value.strip() if isinstance(value, str) else ""
    try:
        parts = urlsplit(value or default)
        valid = (parts.scheme == scheme and parts.hostname and not parts.username
                 and not parts.password and not parts.query and not parts.fragment)
        if not valid:
            raise ValueError
        # Force validation of malformed port values before creating a request.
        parts.port
    except ValueError:
        raise ProviderError(f"接口地址必须为不含账号、查询参数的 {scheme} 地址。") from None
    return parts


def _result(provider):
    return {
        "provider": provider, "kind": "assessment", "accuracy_score": None,
        "fluency_score": None, "completeness_score": None, "prosody_score": None,
        "overall_score": None, "words": [], "feedback": "",
        "connected_speech": [], "limitations": [],
    }


def _word_times(word, start, end):
    if start is not None and end is not None and end >= start:
        word.update(start=start, end=end)


def _assess_input(pcm, reference_text):
    if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
        raise ProviderError("录音为空或不是有效的 16 位 PCM 音频。")
    if len(pcm) > _MAX_SECONDS * _PCM_BYTES_PER_SECOND:
        raise ProviderError("云端发音评测目前每次支持最多 60 秒，请分段录音。")
    if not isinstance(reference_text, str) or not reference_text.strip():
        raise ProviderError("发音评测需要参考文本。")
    if len(reference_text.encode("utf-8")) > 12000:
        raise ProviderError("参考文本过长，请分段评测。")


def tencent_signed_url(config, reference_text, *, now=None, nonce=None, voice_id=None):
    """Sign unescaped sorted values, URL-encode only the final request (SOE-N)."""
    app_id = _required(config, "app_id", "腾讯云 AppID")
    if not re.fullmatch(r"[0-9]+", app_id):
        raise ProviderError("腾讯云 AppID 应为数字。")
    secret_id = _required(config, "secret_id", "腾讯云 SecretId")
    secret_key = _required(config, "secret_key", "腾讯云 SecretKey")
    parts = _endpoint(config.get("endpoint"), "wss://soe.cloud.tencent.com/soe/api", "wss")
    path = parts.path.rstrip("/")
    if path.endswith("/" + app_id):
        pass
    else:
        path += "/" + app_id
    word_count = len(reference_text.split())
    if word_count > 120:
        raise ProviderError("腾讯新版口语评测参考文本最多支持 120 个单词，请分段评测。")
    now = int(time.time()) if now is None else int(now)
    params = {
        "secretid": secret_id, "timestamp": now, "expired": now + 600,
        "nonce": secrets.randbelow(9999999999) + 1 if nonce is None else nonce,
        "server_engine_type": "16k_en", "voice_id": voice_id or str(uuid.uuid4()),
        "voice_format": 0, "text_mode": 0, "ref_text": reference_text,
        "eval_mode": 1 if word_count <= 30 else 2, "score_coeff": 4.0,
        "sentence_info_enabled": 1, "rec_mode": 1,
    }
    signed_text = parts.netloc + path + "?" + "&".join(
        f"{key}={params[key]}" for key in sorted(params)
    )
    params["signature"] = base64.b64encode(hmac.new(
        secret_key.encode("utf-8"), signed_text.encode("utf-8"), hashlib.sha1
    ).digest()).decode("ascii")
    return urlunsplit((parts.scheme, parts.netloc, path,
                       urlencode(params, quote_via=quote, safe=""), ""))


def normalize_tencent(payload, *, paragraph=False):
    data = _object(payload)
    result = _result("tencent")
    for target, source, fraction in (
        ("accuracy_score", "PronAccuracy", False),
        ("fluency_score", "PronFluency", True),
        ("completeness_score", "PronCompletion", True),
        ("overall_score", "SuggestedScore", False),
    ):
        result[target] = _score(data.get(source), fraction=fraction)
    for item in _list(data.get("Words"))[:1500]:
        if not isinstance(item, dict):
            continue
        word = {"word": _text(item.get("Word"), 200),
                "accuracy_score": _score(item.get("PronAccuracy")), "phoneme_scores": []}
        if not word["word"]:
            continue
        if not paragraph:
            _word_times(word, _seconds(item.get("MemBeginTime", item.get("Mbtm")), 1000),
                        _seconds(item.get("MemEndTime", item.get("Metm")), 1000))
        tags = {0: "None", 1: "Insertion", 2: "Omission", 3: "Mispronunciation", 4: "UnknownWord"}
        word["error_type"] = tags.get(item.get("MatchTag", item.get("Tag")), "Unknown")
        expected = []
        actual = []
        phones = item.get("PhoneInfos", item.get("PhoneInfo"))
        for phone in _list(phones)[:100]:
            if not isinstance(phone, dict):
                continue
            observed = _text(phone.get("Phone"), 100)
            reference = _text(phone.get("ReferencePhone"), 100)
            if reference:
                expected.append(reference)
            if observed:
                actual.append(observed)
            phoneme = reference or observed
            if phoneme:
                detail = {"phoneme": phoneme, "score": _score(phone.get("PronAccuracy"))}
                if not paragraph:
                    _word_times(detail, _seconds(phone.get("MemBeginTime"), 1000),
                                _seconds(phone.get("MemEndTime"), 1000))
                word["phoneme_scores"].append(detail)
            stress = phone.get("Stress")
            detected = phone.get("DetectedStress")
            if isinstance(stress, bool) and isinstance(detected, bool) and stress != detected:
                result["connected_speech"].append({
                    "text": word["word"], "category": "stress",
                    "observation": "服务检测到的音节重音与参考重音不同。",
                    "suggestion": "对照原音练习这个词的音节重音。", "evidence": "measured",
                })
        if expected:
            word["expected_phonemes"] = " ".join(expected)
        if actual:
            word["actual_phonemes"] = " ".join(actual)
        result["words"].append(word)
    result["feedback"] = "腾讯新版口语评测结果。音素与重音提示以接口实际返回为准。"
    result["limitations"] = [
        "腾讯流利度、完整度原始分为 0–1，此处换算为百分制。",
        "流利度综合考虑连读等现象，但接口未提供逐处连读诊断，不能据总分定位哪处漏连读。",
        "当前使用成人严格评分（score_coeff=4.0）；评分不能直接换算雅思分数。",
    ]
    if paragraph:
        result["limitations"].append("腾讯段落模式的词时间戳无意义，未用于定位回放。")
    return result


def _tencent_error(code):
    messages = {
        4002: "腾讯云鉴权失败，请检查 AppID、SecretId、SecretKey 和本机时间。",
        4003: "腾讯云尚未开通口语评测服务。",
        4004: "腾讯云口语评测资源包已耗尽。",
        4005: "腾讯云账户余额不足。",
        4006: "腾讯云口语评测并发数已达上限，请稍后重试。",
        4007: "腾讯云无法解码录音。",
        4014: "腾讯云认为录音超过本次评测模式的时长限制，请缩短录音。",
        4102: "腾讯云未接受参考文本，请检查并缩短文本。",
        4103: "腾讯云词库中没有参考文本的某些单词，请调整文本。",
    }
    return ProviderError(messages.get(code, "腾讯云口语评测请求失败，请检查服务权限及接口配置。"))


async def _tencent(config, pcm, reference_text):
    url = tencent_signed_url(config, reference_text)
    results = []
    async with websockets.connect(url, open_timeout=10, close_timeout=3,
                                  max_size=_MAX_RESPONSE_BYTES, proxy=None) as socket:
        hello = _object(await asyncio.wait_for(socket.recv(), 15))
        if hello.get("code") != 0:
            raise _tencent_error(hello.get("code"))
        await socket.send(pcm)
        await socket.send(json.dumps({"type": "end"}))
        for _ in range(256):
            message = _object(await asyncio.wait_for(socket.recv(), 90))
            if message.get("code") != 0:
                raise _tencent_error(message.get("code"))
            if message.get("result") is not None:
                results.append(_object(message["result"]))
            if message.get("final") == 1:
                break
        else:
            raise ProviderError("腾讯云返回的评测消息过多，已停止本次请求。")
    if not results:
        raise ProviderError("腾讯云未返回有效评测结果，请检查录音及服务配置。")
    aggregates = [entry for entry in results if entry.get("SentenceId") == -1]
    if aggregates:
        payload = dict(aggregates[-1])
        if not payload.get("Words"):
            # Paragraph aggregate packets can contain scores only. Keep each latest
            # sentence once; do not derive an overall score from a single sentence.
            by_sentence = {}
            for index, entry in enumerate(results):
                if entry.get("SentenceId") != -1:
                    by_sentence[entry.get("SentenceId", index)] = entry
            payload["Words"] = [word for entry in by_sentence.values()
                                for word in _list(entry.get("Words"))]
    elif len(results) == 1:
        payload = results[0]
    else:
        by_sentence = {}
        for index, entry in enumerate(results):
            by_sentence[entry.get("SentenceId", index)] = entry
        if len(by_sentence) == 1:
            payload = next(iter(by_sentence.values()))
        else:
            payload = {"Words": [word for entry in by_sentence.values()
                                 for word in _list(entry.get("Words"))]}
    normalized = normalize_tencent(payload, paragraph=len(reference_text.split()) > 30)
    if not any(normalized[key] is not None for key in ("accuracy_score", "overall_score")):
        normalized["limitations"].append("服务没有返回有效的整体分数，未用局部句子分数代替。")
    return normalized


def _azure_url(config):
    region = config.get("region", "")
    if not config.get("endpoint"):
        if not isinstance(region, str) or not re.fullmatch(r"[a-z0-9-]{2,40}", region):
            raise ProviderError("请在 AI 设置中填写 Azure 区域或完整接口地址。")
        endpoint = f"https://{region}.stt.speech.microsoft.com"
    else:
        endpoint = config["endpoint"]
    parts = _endpoint(endpoint, "", "https")
    path = parts.path.rstrip("/")
    route = "/speech/recognition/conversation/cognitiveservices/v1"
    if not path or path == "/":
        path = route
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _azure_assessment(data):
    nested = data.get("PronunciationAssessment")
    return nested if isinstance(nested, dict) else data


def normalize_azure(payload):
    payload = _object(payload)
    if payload.get("RecognitionStatus") != "Success":
        raise ProviderError("Azure 未识别到可评测的语音，请检查录音音量和参考文本。")
    hypotheses = _list(payload.get("NBest"))
    if not hypotheses or not isinstance(hypotheses[0], dict):
        raise ProviderError("Azure 未返回有效的发音评测结果。")
    best = hypotheses[0]
    assessment = _azure_assessment(best)
    result = _result("azure")
    for target, source in (("accuracy_score", "AccuracyScore"), ("fluency_score", "FluencyScore"),
                           ("completeness_score", "CompletenessScore"), ("prosody_score", "ProsodyScore"),
                           ("overall_score", "PronScore")):
        result[target] = _score(assessment.get(source))
    prosody_errors = {
        "UnexpectedBreak": ("pause", "服务检测到不符合预期的停顿。", "对照原音，在同一个意群内保持语流连续。"),
        "MissingBreak": ("pause", "服务检测到应停顿处缺少停顿。", "对照原音，在意群或句子边界留出适当停顿。"),
        "Monotone": ("intonation", "服务检测到语调变化不足。", "练习句子重音和音高起伏，并对照原音回听。"),
    }
    for item in _list(best.get("Words"))[:1500]:
        if not isinstance(item, dict):
            continue
        score = _azure_assessment(item)
        word = {"word": _text(item.get("Word"), 200),
                "accuracy_score": _score(score.get("AccuracyScore")),
                "error_type": _text(score.get("ErrorType"), 100), "phoneme_scores": []}
        if not word["word"]:
            continue
        start = _seconds(item.get("Offset"), 10000000)
        duration = _seconds(item.get("Duration"), 10000000)
        _word_times(word, start, start + duration if start is not None and duration is not None else None)
        expected = []
        for phone in _list(item.get("Phonemes"))[:100]:
            if not isinstance(phone, dict):
                continue
            phoneme = _text(phone.get("Phoneme"), 100)
            if not phoneme:
                continue
            expected.append(phoneme)
            detail = {"phoneme": phoneme, "score": _score(_azure_assessment(phone).get("AccuracyScore"))}
            begin = _seconds(phone.get("Offset"), 10000000)
            duration = _seconds(phone.get("Duration"), 10000000)
            _word_times(detail, begin, begin + duration if begin is not None and duration is not None else None)
            word["phoneme_scores"].append(detail)
        if expected:
            word["expected_phonemes"] = " ".join(expected)
        feedback = score.get("Feedback", item.get("Feedback", {}))
        prosody = feedback.get("Prosody", {}) if isinstance(feedback, dict) else {}
        errors = {word["error_type"]}
        if isinstance(prosody, dict):
            for section in ("Break", "Intonation"):
                block = prosody.get(section)
                if isinstance(block, dict):
                    errors.update(error for error in _list(block.get("ErrorTypes")) if isinstance(error, str))
        for error in sorted(errors.intersection(prosody_errors)):
            category, observation, suggestion = prosody_errors[error]
            result["connected_speech"].append({"text": word["word"], "category": category,
                "observation": observation, "suggestion": suggestion, "evidence": "measured"})
        result["words"].append(word)
    result["feedback"] = "Azure 专用发音评测结果；停顿与语调提示仅展示服务明确返回的错误类型。"
    result["limitations"] = [
        "韵律评测目前仅支持 en-US；韵律分和停顿提示不能等同于逐处连读识别。",
        "音素字段是参考音素及其评分，未将参考音素当作独立识别的实际发音。",
        "专用评测分不能直接换算雅思分数。",
    ]
    return result


async def _azure(config, pcm, reference_text):
    key = _required(config, "api_key", "Azure Speech API Key")
    language = config.get("language") or "en-US"
    if not isinstance(language, str) or not re.fullmatch(r"en-[A-Za-z]{2}", language):
        raise ProviderError("当前 Azure 发音评测请使用英语区域代码，例如 en-US 或 en-GB。")
    parameters = {"ReferenceText": reference_text, "GradingSystem": "HundredMark",
                  "Granularity": "Phoneme", "Dimension": "Comprehensive", "EnableMiscue": True}
    if language == "en-US":
        parameters["EnableProsodyAssessment"] = True
    headers = {"Ocp-Apim-Subscription-Key": key, "Accept": "application/json",
               "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
               "Pronunciation-Assessment": base64.b64encode(json.dumps(
                   parameters, ensure_ascii=False, separators=(",", ":")
               ).encode("utf-8")).decode("ascii")}
    wav = io.BytesIO()
    with wave.open(wav, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(pcm)
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10),
                                 follow_redirects=False, trust_env=False) as client:
        response = await client.post(_azure_url(config), params={"language": language, "format": "detailed"},
                                     headers=headers, content=wav.getvalue())
    if response.status_code != 200:
        messages = {401: "Azure 鉴权失败，请检查密钥、区域和接口地址。",
                    403: "Azure 拒绝访问，请检查资源权限。",
                    429: "Azure 调用配额或频率已达上限，请稍后重试。"}
        raise ProviderError(messages.get(response.status_code, "Azure 发音评测请求失败，请检查服务配置和录音。"))
    if len(response.content) > _MAX_RESPONSE_BYTES:
        raise ProviderError("Azure 返回的数据过大。")
    try:
        payload = response.json()
    except ValueError:
        raise ProviderError("Azure 返回了无法解析的数据。") from None
    return normalize_azure(payload)


def iflytek_signed_url(config, *, date=None):
    api_key = _required(config, "api_key", "讯飞 APIKey")
    secret = _required(config, "api_secret", "讯飞 APISecret")
    parts = _endpoint(config.get("endpoint"), "wss://ise-api.xfyun.cn/v2/open-ise", "wss")
    date = date or format_datetime(datetime.now(timezone.utc), usegmt=True)
    source = f"host: {parts.netloc}\ndate: {date}\nGET {parts.path} HTTP/1.1"
    signature = base64.b64encode(hmac.new(secret.encode("utf-8"), source.encode("utf-8"),
                                        hashlib.sha256).digest()).decode("ascii")
    authorization = (f'api_key="{api_key}", algorithm="hmac-sha256", '
                     f'headers="host date request-line", signature="{signature}"')
    query = {"authorization": base64.b64encode(authorization.encode("utf-8")).decode("ascii"),
             "date": date, "host": parts.netloc}
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def iflytek_initial_message(config, reference_text):
    app_id = _required(config, "app_id", "讯飞 AppID")
    if len(reference_text.split()) > 1000:
        raise ProviderError("讯飞参考文本最多支持 1000 个单词，请分段评测。")
    category = "read_chapter" if len(reference_text.split()) > 100 else "read_sentence"
    return {"common": {"app_id": app_id}, "business": {
        "sub": "ise", "ent": "en_vip", "category": category, "cmd": "ssb",
        "text": "\ufeff[content]\n" + reference_text, "tte": "utf-8", "ttp_skip": True,
        "aue": "raw", "auf": "audio/L16;rate=16000", "rstcd": "utf8",
        "rst": "entirety", "ise_unite": "1", "extra_ability": "multi_dimension;syll_phone_err_msg",
    }, "data": {"status": 0}}


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def normalize_iflytek(xml_data):
    if not isinstance(xml_data, (bytes, str)):
        raise ProviderError("讯飞未返回有效的评测文档。")
    encoded = xml_data.encode("utf-8") if isinstance(xml_data, str) else xml_data
    if len(encoded) > _MAX_RESPONSE_BYTES or b"<!DOCTYPE" in encoded.upper() or b"<!ENTITY" in encoded.upper():
        raise ProviderError("讯飞返回了不支持的评测文档。")
    try:
        document = ET.fromstring(encoded)
    except (ValueError, ET.ParseError):
        raise ProviderError("讯飞返回了无法解析的评测文档。") from None
    paper = document.find(".//rec_paper")
    if paper is None and document.tag == "rec_paper":
        paper = document
    if paper is None:
        raise ProviderError("讯飞结果缺少详细评分，请检查评测权限。")
    assessment = next((node for node in paper if node.tag in {"read_sentence", "read_chapter", "read_word"}), None)
    if assessment is None:
        raise ProviderError("讯飞结果缺少英语朗读评分。")
    if assessment.get("is_rejected", "false").lower() == "true":
        raise ProviderError("讯飞未能有效评测本次录音，请对照文本重新录音。")
    result = _result("iflytek")
    for target, source in (("accuracy_score", "accuracy_score"), ("fluency_score", "fluency_score"),
                           ("completeness_score", "integrity_score"), ("overall_score", "total_score")):
        result[target] = _score(assessment.get(source))
    dp_errors = {0: "None", 16: "Omission", 32: "Insertion", 64: "Repetition", 128: "Substitution"}
    properties = (
        (16, 512, "linking", "此处参考文本建议连读。", "把相邻单词放在一起练习，避免逐词断开。"),
        (32, 2048, "stress", "此处参考文本建议重读。", "对照原音突出该词，保持其他词相对轻读。"),
        (64, 4096, "intonation", "此处参考文本提示句末语调。", "对照原音练习句末音高变化。"),
        (2, 256, "pause", "此处参考文本建议意群停顿。", "按意群练习，在边界留出自然停顿。"),
    )
    for node in list(assessment.iter("word"))[:1500]:
        text = _text(node.get("content"), 200)
        if not text or text.lower() in {"sil", "silv", "fil"}:
            continue
        word = {"word": text, "accuracy_score": _score(node.get("accuracy_score")),
                "overall_score": _score(node.get("total_score")),
                "error_type": dp_errors.get(_int(node.get("dp_message")), "Unknown"),
                "phoneme_scores": []}
        _word_times(word, _seconds(node.get("beg_pos"), 100), _seconds(node.get("end_pos"), 100))
        expected = []
        for phone in list(node.iter("phone"))[:100]:
            phoneme = _text(phone.get("content"), 100)
            if phoneme and phoneme.lower() not in {"sil", "silv", "fil"}:
                expected.append(phoneme)
                score = _score(phone.get("accuracy_score"))
                if score is not None:
                    word["phoneme_scores"].append({"phoneme": phoneme, "score": score})
        if expected:
            word["expected_phonemes"] = " ".join(expected)
        result["words"].append(word)
        prop, error = _int(node.get("property")), _int(node.get("werr_msg"))
        for property_bit, error_bit, category, observation, suggestion in properties:
            if prop & property_bit:
                uncertain = bool(error & error_bit)
                result["connected_speech"].append({"text": text, "category": category,
                    "observation": ("服务返回可能未符合该处要求的提示，需结合录音复核。" if uncertain else observation),
                    "suggestion": suggestion, "evidence": "uncertain" if uncertain else "reference"})
    result["feedback"] = "讯飞英语朗读评测结果。参考连读、重读标记与录音错误提示分开显示。"
    result["limitations"] = [
        "已请求讯飞百分制全维度结果；准确度、流利度、完整度需要对应服务权限。",
        "单词总分单独保留；服务没有返回词准确度时不以总分冒充准确度。",
        "property 表示参考读法；werr_msg 的连读等诊断仍在厂商优化中，仅作待复核提示。",
        "音素标记使用讯飞符号；参考音素不等于独立识别出的实际发音。",
        "专用评测分不能直接换算雅思分数。",
    ]
    if _int(assessment.get("except_info")):
        result["limitations"].append("服务提示录音音量、噪声或内容存在异常，本次分数应谨慎参考。")
    return result


def _iflytek_error(code):
    messages = {11200: "讯飞未授权所请求的评测能力，请检查服务权限。",
                11201: "讯飞评测调用额度已耗尽。",
                10313: "讯飞 AppID 与 APIKey 不匹配，请检查设置。",
                60114: "讯飞认为录音过长，请分段评测。",
                68676: "讯飞未能有效评测本次录音，请对照文本重新录音。",
                48195: "讯飞未接受评测文本或题型，请检查文本格式。"}
    return ProviderError(messages.get(code, "讯飞语音评测请求失败，请检查密钥、服务权限和录音。"))


async def _iflytek(config, pcm, reference_text):
    initial = iflytek_initial_message(config, reference_text)
    url = iflytek_signed_url(config)
    async with websockets.connect(url, open_timeout=10, close_timeout=3,
                                  max_size=_MAX_RESPONSE_BYTES, proxy=None) as socket:
        await socket.send(json.dumps(initial, ensure_ascii=False))

        async def upload():
            for index, offset in enumerate(range(0, len(pcm), 1280)):
                message = {"business": {"cmd": "auw", "aus": 1 if index == 0 else 2, "aue": "raw"},
                           "data": {"status": 1, "data": base64.b64encode(pcm[offset:offset + 1280]).decode("ascii")}}
                await socket.send(json.dumps(message))
                # Match 40 ms audio chunks; never block the event loop while sending.
                await asyncio.sleep(0.04)
            await socket.send(json.dumps({"business": {"cmd": "auw", "aus": 4, "aue": "raw"},
                                          "data": {"status": 2, "data": ""}}))

        async def receive():
            for _ in range(512):
                message = _object(await asyncio.wait_for(socket.recv(), 30))
                if message.get("code") != 0:
                    raise _iflytek_error(message.get("code"))
                data = message.get("data")
                if not isinstance(data, dict):
                    continue
                if data.get("status") == 2:
                    encoded = data.get("data")
                    if not isinstance(encoded, str):
                        raise ProviderError("讯飞未返回最终评测文档。")
                    try:
                        return normalize_iflytek(base64.b64decode(encoded, validate=True))
                    except (ValueError, TypeError) as error:
                        if isinstance(error, ProviderError):
                            raise
                        raise ProviderError("讯飞返回了无法解析的最终评测文档。") from None
            raise ProviderError("讯飞返回的评测消息过多，已停止本次请求。")

        sending = asyncio.create_task(upload())
        receiving = asyncio.create_task(receive())
        try:
            # A provider rejection must stop sending immediately, rather than
            # continuing to upload the rest of a recording after a failed request.
            done, _ = await asyncio.wait((sending, receiving), return_when=asyncio.FIRST_COMPLETED)
            if receiving in done:
                return receiving.result()
            await sending
            return await receiving
        finally:
            for task in (sending, receiving):
                if not task.done():
                    task.cancel()
            await asyncio.gather(sending, receiving, return_exceptions=True)


async def assess(provider: str, config: dict, pcm: bytes, reference_text: str) -> dict:
    """Evaluate a bounded recording. Exceptions never contain signed request details."""
    _assess_input(pcm, reference_text)
    aliases = {"tencent_soe": "tencent", "azure_speech": "azure", "iflytek_ise": "iflytek"}
    provider = aliases.get(provider, provider)
    handler = {"tencent": _tencent, "azure": _azure, "iflytek": _iflytek}.get(provider)
    if handler is None:
        raise ProviderError("未知的专用发音评测服务。")
    try:
        async with asyncio.timeout(_MAX_SECONDS + 100):
            return await handler(config, pcm, reference_text.strip())
    except ProviderError:
        raise
    except (TimeoutError, asyncio.TimeoutError, httpx.TimeoutException):
        raise ProviderError("发音评测服务连接或分析超时，请稍后重试。") from None
    except Exception:
        # HTTP/WebSocket exceptions can include signed URLs or credential headers.
        raise ProviderError("发音评测服务连接失败或返回异常，请检查接口地址和服务配置。") from None
