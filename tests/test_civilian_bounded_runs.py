"""All transport is injected; no aircraft, bridge, socket, or real command."""
import copy
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from services.civilian_commands import CivilianCommandService, CommandError
from services.civilian_commands.supervisor import BoundedRunSupervisor, sign_plan
from test_civilian_commands import setup, request, response


class Bridge:
    def __init__(self, key):
        self.key = key
        self.messages = []
        self.on_status = None
        self.completion = True
        self.bad_completion = False

    def send(self, endpoint, message):
        self.messages.append(copy.deepcopy(message))
        kind = message['kind']
        req = message['request'] if kind == 'command' else message
        fields = {k: req[k] for k in ('deployment', 'aircraft', 'command_id', 'action')}
        if kind == 'status_request':
            if self.on_status:
                self.on_status()
            return response(self.key, {**fields, 'classification': 'civilian',
                            'allowed_actions': ['hold', 'return_home', 'land'], 'ready': True,
                            'issued_at': 109, 'expires_at': 120})
        if kind == 'command':
            return response(self.key, {**fields, 'actor': req['actor'], 'accepted': True,
                            'issued_at': 110, 'expires_at': 120})
        assert kind == 'completion_request'
        body = {**fields, 'kind': 'completion', 'actor': req['actor'],
                'completed': self.completion, 'issued_at': 110, 'expires_at': 120}
        if self.bad_completion:
            body['command_id'] = 'wrong'
        return response(self.key, body)

    @property
    def sends(self):
        return [m for m in self.messages if m['kind'] == 'command']


@pytest.fixture
def run_setup(tmp_path):
    config, state, key, bridge_key = setup(tmp_path)
    cfg = json.loads(config.read_text())
    cfg['bounded_runs_enabled'] = True
    cfg['actors']['alice']['allow_bounded_runs'] = True
    config.write_text(json.dumps(cfg))
    bridge = Bridge(bridge_key)
    service = CivilianCommandService(config, state, True, bridge, lambda: 110)
    commands = [request(key, action, sequence=i + 1) for i, action in enumerate(('hold', 'return_home', 'land'))]
    plan = {'version': 1, 'deployment': 'test-deployment', 'actor': 'alice', 'aircraft': 'c1',
            'run_id': 'operator-run-1', 'issued_at': 100, 'expires_at': 120, 'commands': commands}
    events = []
    supervisor = BoundedRunSupervisor(service, events.append)
    yield service, bridge, key, plan, events, supervisor
    service.close()


def test_fixed_pre_authorized_run_has_visible_status_and_no_confirmations(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    result = supervisor.run(sign_plan(plan, key))
    assert result == {'run_id': plan['run_id'], 'state': 'completed', 'physical_success': False}
    assert [m['request']['action'] for m in bridge.sends] == ['hold', 'return_home', 'land']
    assert events[0]['state'] == 'authorized'
    assert events[-1]['state'] == 'completed'
    assert sum(e['state'] == 'bridge_reported_complete' for e in events) == 3
    assert all('confirmation' not in m for m in bridge.messages)
    rows = service.ledger.db.execute("SELECT result FROM audit WHERE result LIKE 'run_%'").fetchall()
    assert ('run_completed',) in rows


@pytest.mark.parametrize('mutation', ['signature', 'action', 'extra', 'too_many', 'too_long', 'ai', 'other_aircraft'])
def test_invalid_or_expanded_plan_never_contacts_bridge(run_setup, mutation):
    service, bridge, key, plan, events, supervisor = run_setup
    if mutation == 'action':
        plan['commands'][0] = request(key, 'effector', sequence=1)
    elif mutation == 'extra':
        plan['planner'] = 'AI'
    elif mutation == 'too_many':
        plan['commands'] *= 2
    elif mutation == 'too_long':
        plan['expires_at'] = 150
    elif mutation == 'ai':
        service.config['actors']['alice']['kind'] = 'ai-agent'
    elif mutation == 'other_aircraft':
        plan['aircraft'] = 'unapproved'
    if mutation == 'extra':
        signed = {**plan, 'signature': 'invalid'}
    else:
        signed = sign_plan(plan, key)
    if mutation == 'signature':
        signed['signature'] = 'invalid'
    with pytest.raises(CommandError):
        supervisor.run(signed)
    assert not bridge.messages


@pytest.mark.parametrize('gate', ['deployment', 'operator'])
def test_autonomy_requires_independent_opt_in(run_setup, gate):
    service, bridge, key, plan, events, supervisor = run_setup
    if gate == 'deployment':
        service.config['bounded_runs_enabled'] = False
    else:
        service.config['actors']['alice']['allow_bounded_runs'] = False
    with pytest.raises(CommandError):
        supervisor.run(sign_plan(plan, key))
    assert not bridge.messages


def test_abort_before_run_never_dispatches(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    supervisor.abort()
    with pytest.raises(CommandError, match='aborted'):
        supervisor.run(sign_plan(plan, key))
    assert not bridge.messages
    assert events[-1]['state'] == 'aborted'


def test_abort_during_status_check_prevents_command_send(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    bridge.on_status = supervisor.abort
    with pytest.raises(CommandError, match='aborted'):
        supervisor.run(sign_plan(plan, key))
    assert not bridge.sends


def test_abort_after_send_stops_all_subsequent_commands(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    bridge.completion = False
    supervisor.wait = lambda _: supervisor.abort()
    with pytest.raises(CommandError, match='aborted'):
        supervisor.run(sign_plan(plan, key))
    assert len(bridge.sends) == 1
    assert events[-1]['recalls_dispatched_commands'] is False


def test_ack_receipt_does_not_advance_without_authenticated_completion(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    bridge.bad_completion = True
    with pytest.raises(CommandError, match='unknown'):
        supervisor.run(sign_plan(plan, key))
    assert len(bridge.sends) == 1
    assert events[-1]['state'] == 'unknown'


def test_expiry_while_waiting_stops_sequence(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    bridge.completion = False
    supervisor.wait = lambda _: setattr(supervisor, '_deadline', 0)
    with pytest.raises(CommandError, match='unknown'):
        supervisor.run(sign_plan(plan, key))
    assert len(bridge.sends) == 1


def test_run_replay_is_rejected_without_more_sends(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    signed = sign_plan(plan, key)
    supervisor.run(signed)
    count = len(bridge.messages)
    with pytest.raises(CommandError):
        BoundedRunSupervisor(service, events.append).run(signed)
    assert len(bridge.messages) == count


def test_observer_failure_fails_closed_before_dispatch(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    supervisor.observer = lambda _: (_ for _ in ()).throw(RuntimeError('observer unavailable'))
    with pytest.raises((RuntimeError, CommandError)):
        supervisor.run(sign_plan(plan, key))
    assert not bridge.messages


def test_run_does_not_synthesize_abort_or_unsafe_fallback_command(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    def observe(event):
        events.append(event)
        if event['state'] == 'bridge_reported_complete':
            supervisor.abort()
    supervisor.observer = observe
    with pytest.raises(CommandError, match='aborted'):
        supervisor.run(sign_plan(plan, key))
    assert [m['request']['action'] for m in bridge.sends] == ['hold']


def test_run_replay_is_rejected_after_process_state_reopen(run_setup):
    service, bridge, key, plan, events, supervisor = run_setup
    signed = sign_plan(plan, key)
    supervisor.run(signed)
    path = service.ledger.path
    service.close()
    new_bridge = Bridge(b'b' * 32)
    reopened = CivilianCommandService(path.parent / 'config', path, False, new_bridge, lambda: 110)
    try:
        with pytest.raises(CommandError):
            BoundedRunSupervisor(reopened, events.append).run(signed)
        assert not new_bridge.messages
    finally:
        reopened.close()


@pytest.mark.parametrize('change', ['signature', 'stale', 'future', 'long_lived', 'boolean_time'])
def test_bad_completion_never_advances_run(run_setup, change):
    service, bridge, key, plan, events, supervisor = run_setup
    original = bridge.send
    def send(endpoint, message):
        reply = original(endpoint, message)
        if message['kind'] == 'completion_request':
            body = dict(reply); body.pop('signature')
            if change == 'stale': body['expires_at'] = 109
            if change == 'future': body['issued_at'] = 115
            if change == 'long_lived': body.update(issued_at=100, expires_at=1000)
            if change == 'boolean_time': body['issued_at'] = True
            reply = response(bridge.key, body)
            if change == 'signature': reply['signature'] = 'invalid'
        return reply
    bridge.send = send
    with pytest.raises(CommandError, match='unknown'):
        supervisor.run(sign_plan(plan, key))
    assert len(bridge.sends) == 1


def test_cli_emits_monitored_status_with_injected_mock_service(run_setup, tmp_path, monkeypatch, capsys):
    from services.civilian_commands import __main__ as cli
    service, bridge, key, plan, events, supervisor = run_setup
    path = tmp_path / 'signed-plan.json'
    path.write_text(json.dumps(sign_plan(plan, key)))
    monkeypatch.setattr(cli, 'CivilianCommandService', lambda *a, **k: service)
    assert cli.main(['--config', 'unused', '--run', str(path), '--state', 'unused']) == 0
    output = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert output[0]['state'] == 'authorized'
    assert output[-1]['state'] == 'completed'
    assert output[-1]['physical_success'] is False


def test_cli_sigint_interrupts_readiness_before_any_command(run_setup, tmp_path, monkeypatch, capsys):
    import signal
    from services.civilian_commands import __main__ as cli
    service, bridge, key, plan, events, supervisor = run_setup
    path = tmp_path / 'signed-plan.json'
    path.write_text(json.dumps(sign_plan(plan, key)))
    previous = signal.getsignal(signal.SIGINT)
    bridge.on_status = lambda: signal.getsignal(signal.SIGINT)(signal.SIGINT, None)
    monkeypatch.setattr(cli, 'CivilianCommandService', lambda *a, **k: service)
    assert cli.main(['--config', 'unused', '--run', str(path), '--state', 'unused']) == 2
    assert not bridge.sends
    assert signal.getsignal(signal.SIGINT) == previous
    assert 'aborted' in capsys.readouterr().out
