"""Local provider configuration. Secrets never leave the server in read responses."""
import base64
import copy
import ctypes
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit

SECRETS = ("api_key", "secret_key", "api_secret")
PUBLIC_FIELDS = ("endpoint", "model", "app_id", "secret_id", "region", "language")
GENERIC_PROVIDERS = ("openai", "gemini", "qwen", "local")
DEDICATED_PROVIDERS = ("tencent", "azure", "iflytek")
ANALYSIS_PROVIDERS = DEDICATED_PROVIDERS + GENERIC_PROVIDERS
DEFAULTS = {
    "enabled": False, "analysis_provider": "qwen", "assessment_provider": "tencent", "feedback_provider": "qwen",
    "providers": {
        "tencent": {"endpoint": "wss://soe.cloud.tencent.com/soe/api/", "app_id": "", "secret_id": "", "secret_key": "", "language": "en-US"},
        "azure": {"endpoint": "", "region": "eastasia", "api_key": "", "language": "en-US"},
        "iflytek": {"endpoint": "wss://ise-api.xfyun.cn/v2/open-ise", "app_id": "", "api_key": "", "api_secret": "", "language": "en-US"},
        "openai": {"endpoint": "https://api.openai.com/v1", "model": "gpt-audio-1.5", "api_key": ""},
        "gemini": {"endpoint": "https://generativelanguage.googleapis.com/v1beta", "model": "gemini-3.8-flash", "api_key": ""},
        "qwen": {"endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen3.8-omni-flash", "api_key": ""},
        "local": {"endpoint": "http://127.0.0.1:8000/v1", "model": "Qwen/Qwen3-Omni-30B-A3B-Instruct", "api_key": ""},
    },
}
_lock = threading.RLock()


class ConfigError(ValueError):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(data: bytes, decrypt=False) -> bytes:
    buffer = ctypes.create_string_buffer(data)
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = _Blob()
    crypt = ctypes.windll.crypt32
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output))
    if not ok:
        raise ConfigError("Windows 无法加密或解密 AI 密钥，请使用保存密钥的同一 Windows 用户。")
    try:
        return ctypes.string_at(output.data, output.length)
    finally:
        ctypes.windll.kernel32.LocalFree(output.data)


def _encrypt(value: str) -> str:
    if not value or os.name != "nt":
        return value
    return "dpapi:" + base64.b64encode(_dpapi(value.encode())).decode()


def _decrypt(value: str) -> str:
    if value.startswith("dpapi:"):
        if os.name != "nt":
            raise ConfigError("此配置中的密钥绑定到 Windows 用户，请重新填写密钥。")
        try:
            return _dpapi(base64.b64decode(value[6:]), decrypt=True).decode()
        except ConfigError:
            raise
        except Exception:
            raise ConfigError("AI 密钥解密失败，请重新填写密钥。") from None
    return value


def validate_provider(provider: str, config: dict) -> list[str]:
    if provider not in DEFAULTS["providers"]:
        return ["不支持的服务。"]
    errors = []
    required = {
        "tencent": ("app_id", "secret_id", "secret_key"),
        "azure": ("api_key",), "iflytek": ("app_id", "api_key", "api_secret"),
        "openai": ("api_key", "endpoint", "model"),
        "gemini": ("api_key", "endpoint", "model"),
        "qwen": ("api_key", "endpoint", "model"), "local": ("endpoint", "model"),
    }[provider]
    for field in required:
        if not config.get(field, "").strip():
            errors.append(f"请填写 {field}。")
    endpoint = config.get("endpoint", "")
    if endpoint:
        try:
            parsed = urlsplit(endpoint)
            schemes = ("wss",) if provider in ("tencent", "iflytek") else ("https",)
            if provider == "local":
                schemes = ("http", "https")
            if parsed.scheme not in schemes or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                errors.append("服务地址无效，请填写不含密钥、查询参数的完整基础地址。")
        except ValueError:
            errors.append("服务地址格式无效。")
    elif provider == "azure" and not re.fullmatch(r"[a-z0-9-]+", config.get("region", "")):
        errors.append("请填写 Azure 区域或服务地址。")
    if provider == "tencent" and config.get("app_id") and not config["app_id"].isdigit():
        errors.append("腾讯 AppID 应为数字。")
    return errors


class AISettingsStore:
    def __init__(self, path=None):
        self.path = Path(path or os.environ.get("ECHOIC_AI_SETTINGS_PATH") or Path(__file__).resolve().parents[4] / ".runtime" / "ai-settings.json")

    def load(self):
        with _lock:
            result = copy.deepcopy(DEFAULTS)
            if not self.path.exists():
                return result
            try:
                saved = json.loads(self.path.read_text(encoding="utf-8"))
                for key in ("enabled", "assessment_provider", "feedback_provider"):
                    if key in saved:
                        result[key] = saved[key]
                # Preserve the previous feedback choice when upgrading an existing setup.
                result["analysis_provider"] = saved.get("analysis_provider", result["feedback_provider"])
                if result["analysis_provider"] not in ANALYSIS_PROVIDERS:
                    raise ConfigError("默认分析服务无效，请重新选择服务。")
                for provider, defaults in result["providers"].items():
                    for field, value in saved.get("providers", {}).get(provider, {}).items():
                        if field in PUBLIC_FIELDS + SECRETS and isinstance(value, str):
                            defaults[field] = _decrypt(value) if field in SECRETS else value
            except ConfigError:
                raise
            except Exception:
                raise ConfigError("AI 设置文件无法读取，请检查本地配置文件。") from None
            return result

    def public(self, config=None):
        config = config or self.load()
        result = {key: config[key] for key in ("enabled", "analysis_provider", "assessment_provider", "feedback_provider")}
        result["providers"] = {}
        for provider, values in config["providers"].items():
            fields = {key: value for key, value in values.items() if key in PUBLIC_FIELDS}
            fields.update({key + "_set": bool(values.get(key)) for key in SECRETS})
            fields["errors"] = validate_provider(provider, values)
            fields["configured"] = not fields["errors"]
            result["providers"][provider] = fields
        return result

    def update(self, patch):
        if not isinstance(patch, dict):
            raise ConfigError("设置必须是 JSON 对象。")
        if set(patch) - {"enabled", "analysis_provider", "assessment_provider", "feedback_provider", "providers"}:
            raise ConfigError("设置包含不支持的字段。")
        with _lock:
            config = self.load()
            if "enabled" in patch:
                if not isinstance(patch["enabled"], bool):
                    raise ConfigError("enabled 必须是布尔值。")
                config["enabled"] = patch["enabled"]
            for key, allowed in (("analysis_provider", ANALYSIS_PROVIDERS), ("assessment_provider", DEDICATED_PROVIDERS), ("feedback_provider", GENERIC_PROVIDERS)):
                if key in patch:
                    if patch[key] not in allowed:
                        raise ConfigError("请选择支持的分析服务。")
                    config[key] = patch[key]
            providers = patch.get("providers", {})
            if not isinstance(providers, dict):
                raise ConfigError("providers 必须是 JSON 对象。")
            for provider, values in providers.items():
                if provider not in config["providers"] or not isinstance(values, dict):
                    raise ConfigError("不支持的服务配置。")
                if set(values) - set(PUBLIC_FIELDS + SECRETS + ("clear_secrets",)):
                    raise ConfigError("服务配置包含不支持的字段。")
                target = config["providers"][provider]
                clears = values.get("clear_secrets", [])
                if not isinstance(clears, list) or any(key not in SECRETS for key in clears):
                    raise ConfigError("无效的密钥清除请求。")
                for key in clears:
                    target[key] = ""
                for key, value in values.items():
                    if key == "clear_secrets":
                        continue
                    if not isinstance(value, str) or len(value) > (4096 if key in SECRETS else 1000):
                        raise ConfigError("配置字段必须是长度合理的文字。")
                    value = value.strip()
                    if any(ord(c) < 32 for c in value):
                        raise ConfigError("配置字段不能含有换行或控制字符。")
                    if key not in SECRETS or value:
                        target[key] = value
                # Incomplete forms may be saved, but malformed endpoints cannot be used or echoed.
                if target.get("endpoint"):
                    errors = validate_provider(provider, target)
                    if any("地址" in error for error in errors):
                        raise ConfigError("服务地址无效，请检查协议、主机和路径。")
            saved = copy.deepcopy(config)
            for values in saved["providers"].values():
                for key in SECRETS:
                    if key in values:
                        values[key] = _encrypt(values[key])
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = None
            try:
                fd, tmp = tempfile.mkstemp(prefix=".ai-settings-", dir=self.path.parent)
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(saved, stream, ensure_ascii=False, indent=2)
                if os.name != "nt":
                    os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
            finally:
                if tmp and os.path.exists(tmp):
                    os.unlink(tmp)
            return self.public(config)


def get_ai_settings_store():
    return AISettingsStore()
