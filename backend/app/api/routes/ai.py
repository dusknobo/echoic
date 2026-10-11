"""Explicit opt-in AI settings and analysis of saved recordings."""
import asyncio
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import get_db
from app.models.ai_record_analysis import AIRecordAnalysis
from app.models.practice_record import PracticeRecord
from app.services.ai_assessment.generic import AnalysisError, analyze_audio, prepare_audio
from app.services.ai_assessment.settings import (
    AISettingsStore, ConfigError, DEDICATED_PROVIDERS, GENERIC_PROVIDERS,
    get_ai_settings_store, validate_provider,
)
from app.services.factory import get_storage_service


def same_origin(request: Request):
    if request.url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(status_code=403, detail="AI 设置与分析仅允许从本机地址访问。")
    origin = request.headers.get("origin")
    if origin:
        allowed = set(settings.cors_origins)
        allowed.add(f"{request.url.scheme}://{request.url.netloc}")
        if origin not in allowed:
            raise HTTPException(status_code=403, detail="请从 Echoic 本机页面使用 AI 设置与分析。")


router = APIRouter(dependencies=[Depends(same_origin)])
_running: set[tuple[int, str, str]] = set()


def load_config(store):
    try:
        return store.load()
    except ConfigError as error:
        raise HTTPException(status_code=503, detail=str(error)) from None


@router.get("/settings")
def get_settings(store: AISettingsStore = Depends(get_ai_settings_store)):
    return store.public(load_config(store))


@router.put("/settings")
async def update_settings(request: Request, store: AISettingsStore = Depends(get_ai_settings_store)):
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(status_code=415, detail="请使用 JSON 保存 AI 设置。")
    try:
        patch = await request.json()
        return store.update(patch)
    except (ConfigError, ValueError, TypeError):
        # Request values may contain credentials. Never echo validation inputs or exceptions.
        raise HTTPException(status_code=400, detail="AI 设置保存失败，请检查字段、服务地址及配置文件权限。") from None
    except OSError:
        raise HTTPException(status_code=503, detail="无法写入本地 AI 设置，请检查配置文件权限。") from None


@router.post("/providers/{provider}/validate")
def check_provider(provider: str, store: AISettingsStore = Depends(get_ai_settings_store)):
    config = load_config(store)
    if provider not in config["providers"]:
        raise HTTPException(status_code=404, detail="不支持的 AI 服务。")
    errors = validate_provider(provider, config["providers"][provider])
    return {"valid": not errors, "configured": not errors, "errors": errors,
        "message": "配置字段完整。尚未验证密钥有效性、服务开通情况或模型权限。" if not errors else "；".join(errors)}


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["assessment", "feedback"] | None = None
    provider: Literal["tencent", "azure", "iflytek", "openai", "gemini", "qwen", "local"] | None = None


def _response(analysis):
    return {**analysis.result, "id": analysis.id, "record_id": analysis.record_id,
        "provider": analysis.provider, "kind": analysis.kind, "created_at": analysis.created_at.isoformat() + "Z"}


@router.get("/records/{record_id}/analyses")
def history(record_id: int, db: Session = Depends(get_db)):
    if db.get(PracticeRecord, record_id) is None:
        raise HTTPException(status_code=404, detail="录音不存在。")
    results = db.query(AIRecordAnalysis).filter(AIRecordAnalysis.record_id == record_id).order_by(AIRecordAnalysis.id.desc()).limit(30).all()
    return [_response(item) for item in results]


@router.post("/records/{record_id}/analyze")
async def analyze(record_id: int, body: AnalyzeRequest, request: Request, db: Session = Depends(get_db),
                  store: AISettingsStore = Depends(get_ai_settings_store)):
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(status_code=415, detail="请使用 JSON 发起分析。")
    config = load_config(store)
    if not config["enabled"]:
        raise HTTPException(status_code=409, detail="请先在设置中启用 AI 分析。")
    if body.provider:
        provider = body.provider
    elif body.mode:
        # Keep explicit modes working for older clients.
        provider = config["assessment_provider" if body.mode == "assessment" else "feedback_provider"]
    else:
        provider = config["analysis_provider"]
    if body.mode == "feedback" and provider not in GENERIC_PROVIDERS:
        raise HTTPException(status_code=400, detail="连读文字反馈请选择支持音频输入的大模型。")
    fields = config["providers"][provider]
    errors = validate_provider(provider, fields)
    if errors:
        raise HTTPException(status_code=409, detail="该服务尚未配置完整：" + "；".join(errors))
    record = db.get(PracticeRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="录音不存在。")
    mode = "assessment" if provider in DEDICATED_PROVIDERS else "feedback"
    key = (record_id, provider, mode)
    if key in _running:
        raise HTTPException(status_code=409, detail="该录音正在分析，请等待当前请求完成。")
    _running.add(key)
    try:
        storage = get_storage_service(record.storage_backend)
        path = storage.get_absolute_path(record.recording_path)
        reference_text = record.sentence_text
        pcm, wav = await run_in_threadpool(prepare_audio, path)
        async with asyncio.timeout(170):
            if provider in DEDICATED_PROVIDERS:
                from app.services.ai_assessment.dedicated import assess, ProviderError
                try:
                    result = await assess(provider, fields, pcm, reference_text)
                except ProviderError as error:
                    raise AnalysisError(str(error)) from None
            else:
                result = await analyze_audio(provider, fields, wav, reference_text)
        # A recording can be deleted in another tab while an external request is running.
        db.expire_all()
        if db.get(PracticeRecord, record_id) is None:
            raise HTTPException(status_code=404, detail="录音已删除，本次结果未保存。")
        analysis = AIRecordAnalysis(record_id=record_id, provider=provider, kind=result["kind"], result=result)
        db.add(analysis)
        db.commit()
        db.refresh(analysis)
        return _response(analysis)
    except TimeoutError:
        raise HTTPException(status_code=504, detail="AI 分析超时，请稍后重试。") from None
    except AnalysisError as error:
        raise HTTPException(status_code=502, detail=str(error)) from None
    except HTTPException:
        raise
    except Exception:
        # Never forward raw provider exceptions: URLs and request headers may hold credentials.
        raise HTTPException(status_code=502, detail="AI 分析失败，请检查配置、录音及服务状态后重试。") from None
    finally:
        _running.discard(key)
