"""Mock-only command tests: no hardware, bridge, or actual external request."""
import copy
import hashlib
import hmac
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.civilian_commands import CivilianCommandService, CommandError, MockTransport, sign_request
from services.civilian_commands.core import HTTPSBridgeTransport, canonical, decode_json, _b64


def setup(tmp_path, enabled=True, actor_extra=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    tmp_path.chmod(0o700)
    key = tmp_path / 'actor'
    key.write_bytes(b'a' * 32)
    key.chmod(0o600)
    bridge = tmp_path / 'bridge'
    bridge.write_bytes(b'b' * 32)
    bridge.chmod(0o600)
    client_key = tmp_path / 'client-key'
    client_key.write_bytes(b'FAKE TEST KEY')
    client_key.chmod(0o600)
    for name in ('ca', 'cert'):
        file = tmp_path / name
        file.write_text('FAKE TEST PEM')
        file.chmod(0o600)
    actor = {'kind': 'human-operator', 'key_file': str(key), 'aircraft': ['c1'],
             'actions': ['hold', 'return_home', 'land']}
    actor.update(actor_extra or {})
    endpoint = {'host': 'bridge.invalid', 'port': 443, 'path': '/civilian/v1',
                'ca_file': str(tmp_path / 'ca'), 'client_cert': str(tmp_path / 'cert'),
                'client_key': str(client_key), 'timeout': 2}
    config = {'enabled': enabled, 'deployment': 'test-deployment', 'actors': {'alice': actor},
              'aircraft': {'c1': {'classification': 'civilian', 'status_key_file': str(bridge), 'endpoint': endpoint}}}
    file = tmp_path / 'config'
    file.write_text(json.dumps(config))
    file.chmod(0o600)
    return file, tmp_path / 'state', b'a' * 32, b'b' * 32


def response(key, body):
    return {**body, 'signature': _b64(hmac.new(key, canonical(body), hashlib.sha256).digest())}


def request(key, action='hold', **kwargs):
    body = {'version': 1, 'deployment': 'test-deployment', 'actor': 'alice', 'aircraft': 'c1',
            'command_id': 'id-' + action, 'sequence': 1, 'issued_at': 100,
            'expires_at': 120, 'action': action, 'initiation': 'operator'}
    body.update(kwargs)
    return sign_request(body, key)


def transport(key, action='hold'):
    fields = {'deployment': 'test-deployment', 'aircraft': 'c1', 'command_id': 'id-' + action, 'action': action}
    status = response(key, {**fields, 'classification': 'civilian', 'allowed_actions': [action],
                           'ready': True, 'issued_at': 109, 'expires_at': 120})
    ack = response(key, {**fields, 'actor': 'alice', 'accepted': True, 'issued_at': 110, 'expires_at': 120})
    return MockTransport(status, ack)


@pytest.mark.parametrize('action', ['hold', 'return_home', 'land'])
def test_actions_have_no_confirmation_but_durable_intent(tmp_path, action):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key, action)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    try:
        result = svc.dispatch(request(key, action))
        assert result['status'] == 'ack_received' and result['physical_success'] is False
        assert 'confirmation' not in t.messages[-1]
        assert [r[0] for r in svc.ledger.db.execute('SELECT result FROM audit ORDER BY id')] == ['intent', 'dispatching', 'ack_received']
    finally:
        svc.close()


@pytest.mark.parametrize('action', ['weapon', 'effector', 'fire', 'engage', 'target', 'payload',
                                   'arm', 'takeoff', 'mission', 'offboard', 'servo', 'parameter', 'custom', 'broadcast'])
def test_prohibited_actions_never_contact_transport(tmp_path, action):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    try:
        with pytest.raises(CommandError):
            svc.dispatch(request(key, action))
        assert not t.messages
    finally:
        svc.close()


@pytest.mark.parametrize('changes', [ {'version': True}, {'sequence': True}, {'sequence': -1},
    {'sequence': 2**63}, {'issued_at': 113}, {'expires_at': 110}, {'expires_at': 140},
    {'actor': 'unapproved'}, {'aircraft': 'other'}, {'deployment': 'other'},
    {'initiation': 'autonomous'}, {'command_id': '../not-an-id'} ])
def test_invalid_claims_rejected_without_network(tmp_path, changes):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    try:
        with pytest.raises(CommandError):
            svc.dispatch(request(key, **changes))
        assert not t.messages
    finally:
        svc.close()


def test_tampering_unknown_fields_and_unsigned_commands_fail_closed(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    try:
        for mutation in ('tamper', 'extra', 'unsigned'):
            req = request(key)
            if mutation == 'tamper': req['action'] = 'land'
            if mutation == 'extra': req['target'] = 'forbidden'
            if mutation == 'unsigned': req.pop('signature')
            with pytest.raises(CommandError): svc.dispatch(req)
        assert not t.messages
        assert all(row[0] is None for row in svc.ledger.db.execute('SELECT actor FROM audit'))
    finally:
        svc.close()


@pytest.mark.parametrize('changes', [{'aircraft': 'other'}, {'ready': False},
    {'classification': 'effector'}, {'allowed_actions': ['fire']}, {'expires_at': 109},
    {'issued_at': 1, 'expires_at': 1000}, {'issued_at': True}])
def test_unready_stale_or_wrong_status_never_sends_command(tmp_path, changes):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    body = dict(t.status); body.pop('signature'); body.update(changes)
    t.status = response(bridge_key, body)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    try:
        with pytest.raises(CommandError): svc.dispatch(request(key))
        assert len(t.messages) == 1
    finally:
        svc.close()


@pytest.mark.parametrize('changes', [{'accepted': False}, {'aircraft': 'other'}, {'expires_at': 109}, {'issued_at': True}])
def test_unverified_ack_is_unknown_and_never_retried(tmp_path, changes):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    body = dict(t.ack); body.pop('signature'); body.update(changes)
    t.ack = response(bridge_key, body)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    try:
        with pytest.raises(CommandError, match='unknown'): svc.dispatch(request(key))
        assert len(t.messages) == 2
        assert svc.ledger.db.execute('SELECT result FROM audit ORDER BY id DESC LIMIT 1').fetchone()[0] == 'unknown'
    finally:
        svc.close()


def test_replay_and_out_of_order_rejected_after_restart(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    svc = CivilianCommandService(config, state, True, transport(bridge_key), lambda: 110)
    svc.dispatch(request(key, sequence=3)); svc.close()
    t = transport(bridge_key)
    svc = CivilianCommandService(config, state, False, t, lambda: 110)
    try:
        for seq in (3, 2):
            with pytest.raises(CommandError, match='replay'):
                svc.dispatch(request(key, sequence=seq))
        assert not t.messages
    finally:
        svc.close()


def test_disabled_and_explicit_permission_revocation(tmp_path):
    config, state, key, bridge_key = setup(tmp_path, False)
    t = transport(bridge_key)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    try:
        with pytest.raises(CommandError, match='disabled'): svc.dispatch(request(key))
        assert not t.messages
    finally:
        svc.close()
    cfg = json.loads(config.read_text()); cfg['actors']['alice'].pop('actions')
    config.write_text(json.dumps(cfg))
    with pytest.raises(CommandError): CivilianCommandService(config, tmp_path / 'other', True, t, lambda: 110)


def test_state_cannot_reset_or_open_concurrently_and_binds_keys(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    svc = CivilianCommandService(config, state, True, transport(bridge_key), lambda: 110)
    with pytest.raises(CommandError): CivilianCommandService(config, state, False)
    svc.close()
    with pytest.raises(CommandError, match='reinitialize'): CivilianCommandService(config, state, True)
    (tmp_path / 'actor').write_bytes(b'c' * 32)
    with pytest.raises(CommandError, match='binding'): CivilianCommandService(config, state)


def test_empty_corrupt_missing_and_symlink_state_fail_closed(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    with pytest.raises(CommandError, match='missing'): CivilianCommandService(config, state)
    state.touch(mode=0o600)
    with pytest.raises(CommandError): CivilianCommandService(config, state)
    state.unlink(); state.symlink_to(tmp_path / 'actor')
    with pytest.raises(CommandError): CivilianCommandService(config, state)


def test_audit_failure_prevents_command_transmission(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    svc.ledger.db.execute('DROP TABLE audit')
    try:
        with pytest.raises(CommandError): svc.dispatch(request(key))
        assert not t.messages
    finally:
        svc.close()


def test_cancellation_and_expiry_in_hook_prevent_send(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    clock = [110]
    svc = CivilianCommandService(config, state, True, t, lambda: clock[0])
    def hook(_): clock[0] = 121
    try:
        with pytest.raises(CommandError): svc.dispatch(request(key), before_send=hook)
        assert len(t.messages) == 1
    finally:
        svc.close()


def test_json_duplicates_and_nonfinite_are_rejected():
    for raw in ('{"action":"hold","action":"fire"}', '{"expires_at":NaN}'):
        with pytest.raises(ValueError): decode_json(raw)


def test_https_transport_uses_mtls_and_closes_without_following_redirect(tmp_path, monkeypatch):
    config, state, key, bridge_key = setup(tmp_path)
    endpoint = json.loads(config.read_text())['aircraft']['c1']['endpoint']
    calls = []
    class Context:
        def load_cert_chain(self, cert, key): calls.append(('cert', cert, key))
    class Connection:
        def __init__(self, host, port, **kwargs): calls.append(('connect', host, port, kwargs))
        def request(self, *args, **kwargs): calls.append(('request', args, kwargs))
        def getresponse(self):
            return type('Response', (), {'status': 302, 'read': lambda _, n: b'{}'})()
        def close(self): calls.append(('close',))
    monkeypatch.setattr('services.civilian_commands.core.ssl.create_default_context', lambda **kw: Context())
    monkeypatch.setattr('services.civilian_commands.core.http.client.HTTPSConnection', Connection)
    with pytest.raises(CommandError): HTTPSBridgeTransport().send(endpoint, {'kind': 'test'})
    assert sum(c[0] == 'connect' for c in calls) == 1
    assert calls[-1] == ('close',)
    assert calls[0][0] == 'cert'


def test_transport_total_operation_deadline_interrupts_slow_mock(tmp_path, monkeypatch):
    import time
    config, state, key, bridge_key = setup(tmp_path)
    endpoint = json.loads(config.read_text())['aircraft']['c1']['endpoint']
    endpoint['timeout'] = 0.02
    def slow_mock(*_): time.sleep(0.2)
    monkeypatch.setattr(HTTPSBridgeTransport, '_send', slow_mock)
    with pytest.raises(CommandError, match='deadline'):
        HTTPSBridgeTransport().send(endpoint, {'kind': 'test'})


def test_live_transport_refuses_background_thread_before_network(tmp_path):
    import threading
    config, state, key, bridge_key = setup(tmp_path)
    endpoint = json.loads(config.read_text())['aircraft']['c1']['endpoint']
    errors = []
    def attempt():
        try: HTTPSBridgeTransport().send(endpoint, {'kind': 'test'})
        except CommandError as exc: errors.append(str(exc))
    thread = threading.Thread(target=attempt)
    thread.start(); thread.join(timeout=1)
    assert not thread.is_alive()
    assert errors == ['live transport requires an exclusive main-thread timer']


def test_checked_tls_bytes_are_pinned_and_loaded_not_reopened(tmp_path, monkeypatch):
    config, state, key, bridge_key = setup(tmp_path)
    expected = transport(bridge_key)
    svc = CivilianCommandService(config, state, True, clock=lambda: 110)
    material = json.loads(config.read_text())['aircraft']['c1']['endpoint']
    for name in ('ca_file', 'client_cert', 'client_key'):
        Path(material[name]).write_text('REPLACED AFTER CONFIG LOAD')
    loaded = []
    class Context:
        def load_cert_chain(self, cert, key):
            assert Path(cert).read_bytes() == b'FAKE TEST PEM'
            assert Path(key).read_bytes() == b'FAKE TEST KEY'
            loaded.append(True)
    class Connection:
        def __init__(self, *a, **kw): pass
        def request(self, method, path, body, **kw): self.message = json.loads(body)
        def getresponse(self):
            value = expected.status if self.message['kind'] == 'status_request' else expected.ack
            return type('Response', (), {'status': 200, 'read': lambda _, n: canonical(value)})()
        def close(self): pass
    def context(**kwargs):
        assert kwargs['cadata'] == 'FAKE TEST PEM'
        return Context()
    monkeypatch.setattr('services.civilian_commands.core.ssl.create_default_context', context)
    monkeypatch.setattr('services.civilian_commands.core.http.client.HTTPSConnection', Connection)
    try:
        assert svc.dispatch(request(key))['status'] == 'ack_received'
        assert len(loaded) == 2
    finally:
        svc.close()
    with pytest.raises(CommandError, match='binding'):
        CivilianCommandService(config, state)


def test_replacing_state_inode_stops_before_transport(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    t = transport(bridge_key)
    svc = CivilianCommandService(config, state, True, t, lambda: 110)
    replacement = tmp_path / 'replacement'
    replacement.write_bytes(state.read_bytes())
    replacement.chmod(0o600)
    os.replace(replacement, state)
    try:
        with pytest.raises(CommandError): svc.dispatch(request(key))
        assert not t.messages
    finally:
        svc.close()
