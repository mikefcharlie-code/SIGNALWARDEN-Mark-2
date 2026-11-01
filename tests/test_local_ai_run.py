import importlib, json, sys
from http.client import HTTPConnection
from threading import Thread
import pytest

@pytest.fixture
def runner(monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "unset")
    sys.modules.pop("scripts.local_ai_run", None)
    return importlib.import_module("scripts.local_ai_run")

def test_offline_flags_are_forced(runner):
    assert runner.os.environ["HF_HUB_OFFLINE"] == "1"
    assert runner.os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert runner.os.environ["HF_HUB_DISABLE_TELEMETRY"] == "1"
    assert runner.os.environ["DO_NOT_TRACK"] == "1"

def test_verified_rejects_missing_registry_before_verify(runner, monkeypatch, tmp_path):
    calls=[]; fake=tmp_path/"cached"; fake.mkdir()
    monkeypatch.setattr(runner,"_setup",lambda:(None,lambda:{"models":{}},lambda g:fake,lambda *a:calls.append(a) or False))
    with pytest.raises(RuntimeError,match="no model"): runner._verified("llm")
    assert calls==[]

def test_unsupported_and_non_loopback_rejected(runner):
    with pytest.raises(ValueError): runner.smoke("audio")
    with pytest.raises(ValueError,match="loopback"): runner.serve_llm("0.0.0.0")

def test_smoke_llm_uses_verified_cache(runner,monkeypatch,tmp_path):
    d=tmp_path/"llm"; d.mkdir()
    monkeypatch.setattr(runner,"_setup",lambda:(None,lambda:{"models":{"llm":{"repo_id":"Qwen/Qwen3-0.6B"}}},lambda g:d,lambda *a:True))
    monkeypatch.setattr(runner,"_llm",lambda prompt,device,registry,max_tokens=400:"hello")
    assert runner.smoke("llm")=={"group":"llm","text":"hello","advisory":True}

def _server(runner):
    s=runner.ThreadingHTTPServer(("127.0.0.1",0),runner._LLMHandler)
    s.repo_id="Qwen/Qwen3-0.6B"; s.device="cpu"; s.registry=None; s.model_loaded=True
    t=Thread(target=s.serve_forever,daemon=True); t.start(); return s,t

def _request(s, body, headers=None, path="/v1/chat/completions"):
    c=HTTPConnection("127.0.0.1",s.server_port); h={"Content-Type":"application/json"}; h.update(headers or {})
    c.request("POST",path,body, h); r=c.getresponse(); data=r.read(); c.close(); return r.status,data

def test_handler_rejects_scalars_tools_origin_and_oversize(runner):
    s,t=_server(runner)
    try:
        assert _request(s,"[]")[0]==400
        assert _request(s,json.dumps({"messages":[{"role":"user","content":"x"}],"tools":[]}))[0]==400
        assert _request(s,json.dumps({"messages":[{"role":"user","content":"x"}]}),{"Origin":"https://evil.example"})[0]==403
        assert _request(s,"x"*(runner.MAX_BODY+1),{"Content-Length":str(runner.MAX_BODY+1)})[0]==413
    finally: s.shutdown(); s.server_close(); t.join(2)

def test_handler_honors_max_tokens_and_chat_call(runner,monkeypatch):
    s,t=_server(runner); seen=[]
    monkeypatch.setattr(runner,"_llm",lambda prompt,device,registry,max_tokens: seen.append(max_tokens) or "ok")
    try:
        status,data=_request(s,json.dumps({"model":"Qwen/Qwen3-0.6B","messages":[{"role":"user","content":"x"}],"max_tokens":7}))
        assert status==200 and seen==[7] and json.loads(data)["choices"][0]["message"]["content"]=="ok"
    finally: s.shutdown(); s.server_close(); t.join(2)

def test_health_not_ready(runner):
    s=runner.ThreadingHTTPServer(("127.0.0.1",0),runner._LLMHandler); s.model_loaded=False
    t=Thread(target=s.serve_forever,daemon=True); t.start()
    try:
        c=HTTPConnection("127.0.0.1",s.server_port); c.request("GET","/health"); r=c.getresponse(); assert r.status==503; assert json.loads(r.read())["ready"] is False; c.close()
    finally: s.shutdown(); s.server_close(); t.join(2)
