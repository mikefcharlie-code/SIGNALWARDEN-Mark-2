"""Civilian bridge gateway. No startup connection and no MAVLink transmitter."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import signal
import threading
import tempfile
from contextlib import contextmanager
from urllib.parse import quote
import sqlite3
import ssl
import stat
import time
from pathlib import Path

from services.aircraft_gateway.security import read_private

ACTIONS = frozenset({'hold', 'return_home', 'land'})
REQUEST_KEYS = frozenset({'version', 'deployment', 'actor', 'aircraft', 'command_id',
                         'sequence', 'issued_at', 'expires_at', 'action', 'initiation'})
MAX_REQUEST = 4096
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')


class CommandError(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode()


def decode_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


def _b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def _unb64(value):
    if type(value) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{43}', value):
        raise CommandError('invalid signature encoding')
    decoded = base64.urlsafe_b64decode(value + '=')
    if _b64(decoded) != value:
        raise CommandError('noncanonical signature')
    return decoded


def sign_request(request, key):
    body = dict(request)
    body.pop('signature', None)
    if set(body) != REQUEST_KEYS:
        raise ValueError('request envelope keys are not exact')
    return {**body, 'signature': _b64(hmac.new(key, canonical(body), hashlib.sha256).digest())}


def _secret(path):
    key = read_private(path, 32)
    if len(key) != 32 or not any(key):
        raise CommandError('key must contain 32 bytes and not be all zero')
    return key


def _identifier(value):
    return type(value) is str and ID.fullmatch(value) is not None


def _fresh(body, now, lifetime=30):
    if type(now) not in (int, float) or not math.isfinite(now):
        raise CommandError('trusted clock unavailable')
    if any(type(body.get(k)) not in (int, float) or not math.isfinite(body[k])
           for k in ('issued_at', 'expires_at')):
        raise CommandError('invalid signed times')
    if not (body['issued_at'] <= now + 2 and now < body['expires_at']
            and 0 < body['expires_at'] - body['issued_at'] <= lifetime):
        raise CommandError('signed message stale or invalid')


def _verify_signature(signed, key):
    body = dict(signed)
    signature = _unb64(body.pop('signature'))
    if not hmac.compare_digest(signature, hmac.new(key, canonical(body), hashlib.sha256).digest()):
        raise CommandError('authentication failed')
    return body


def _endpoint_valid(endpoint):
    required = {'host', 'port', 'path', 'ca_file', 'client_cert', 'client_key', 'timeout'}
    return (type(endpoint) is dict and set(endpoint) == required
            and type(endpoint['host']) is str
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', endpoint['host']) is not None
            and type(endpoint['port']) is int and 1 <= endpoint['port'] <= 65535
            and type(endpoint['path']) is str and endpoint['path'].startswith('/')
            and len(endpoint['path']) <= 256
            and all(32 < ord(c) < 127 for c in endpoint['path'])
            and type(endpoint['timeout']) in (int, float) and 0 < endpoint['timeout'] <= 5
            and all(type(endpoint[k]) is str and Path(endpoint[k]).is_absolute()
                    for k in ('ca_file', 'client_cert', 'client_key')))


class _Ledger:
    """Single-writer durable replay/audit state. No resume, reset or pruning."""
    def __init__(self, state, binding, initialize):
        self.path = Path(state).absolute()
        parent = self.path.parent
        parent.mkdir(mode=0o700, exist_ok=True)
        info = parent.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise CommandError('state directory must be owned mode 0700')
        self.lock = os.open(str(self.path) + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.db = None
        try:
            info = os.fstat(self.lock)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise CommandError('invalid state lock')
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            exists = self.path.exists() or self.path.is_symlink()
            if exists and initialize:
                raise CommandError('refusing to reinitialize existing state')
            if not exists and not initialize:
                raise CommandError('state missing; explicitly initialize a new deployment')
            if exists:
                read_private(self.path, 128 * 1024 * 1024)
            else:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.close(fd)
            # Retain a no-follow descriptor and verify pathname identity around
            # SQLite's path-only open; the owned directory and process lock are
            # the local trust boundary (host owner/root is not an adversary).
            self.state_fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            self.state_identity = os.fstat(self.state_fd)
            self._check_inode()
            self.db = sqlite3.connect(f'file:{quote(str(self.path), safe="/")}?mode=rw', uri=True, isolation_level=None)
            self._check_inode()
            self.db.execute('PRAGMA journal_mode=DELETE')
            self.db.execute('PRAGMA synchronous=FULL')
            encoded = canonical(binding).decode()
            if not exists:
                self.db.executescript('''
                    BEGIN IMMEDIATE;
                    CREATE TABLE meta (k TEXT PRIMARY KEY,v TEXT NOT NULL);
                    CREATE TABLE commands (actor TEXT NOT NULL, command_id TEXT NOT NULL,
                        sequence INTEGER NOT NULL, accepted_at INTEGER NOT NULL,
                        PRIMARY KEY(actor,command_id), UNIQUE(actor,sequence));
                    CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
                        result TEXT NOT NULL, actor TEXT, aircraft TEXT, command_id TEXT,
                        action TEXT, reason TEXT);
                    CREATE TABLE bounded_runs (deployment TEXT NOT NULL, run_id TEXT NOT NULL,
                        actor TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(deployment,run_id));
                    COMMIT;
                ''')
                self.db.execute('INSERT INTO meta VALUES(?,?)', ('binding', encoded))
                directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            old = self.db.execute("SELECT v FROM meta WHERE k='binding'").fetchone()
            tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not old or old[0] != encoded or tables != {'meta', 'commands', 'audit', 'bounded_runs'}:
                raise CommandError('state binding or schema mismatch')
            if self.db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise CommandError('invalid state database')
        except Exception as exc:
            if self.db is not None:
                self.db.close()
            if hasattr(self, "state_fd"):
                os.close(self.state_fd)
            os.close(self.lock)
            if isinstance(exc, CommandError):
                raise
            raise CommandError('state unavailable, corrupt, or locked') from exc

    def _check_inode(self):
        info = self.path.lstat()
        expected = self.state_identity
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or (info.st_dev, info.st_ino) != (expected.st_dev, expected.st_ino)):
            raise CommandError('state identity changed; stopped')

    def consume(self, actor, cid, seq, now, audit_row):
        try:
            self._check_inode()
            self.db.execute('BEGIN IMMEDIATE')
            last = self.db.execute('SELECT MAX(sequence) FROM commands WHERE actor=?', (actor,)).fetchone()[0]
            if last is not None and seq <= last:
                raise CommandError('replay or out-of-order sequence rejected')
            self.db.execute('INSERT INTO commands VALUES(?,?,?,?)', (actor, cid, seq, now))
            self.db.execute('INSERT INTO audit(at,result,actor,aircraft,command_id,action,reason) VALUES(?,?,?,?,?,?,?)',
                            (now, 'intent', actor, audit_row[0], cid, audit_row[1], 'reserved'))
            self.db.commit()
        except Exception as exc:
            self.db.rollback()
            if isinstance(exc, CommandError):
                raise
            raise CommandError('replay or audit storage rejected') from exc

    def audit(self, result, actor=None, aircraft=None, cid=None, action=None, reason=None):
        try:
            self._check_inode()
            self.db.execute('INSERT INTO audit(at,result,actor,aircraft,command_id,action,reason) VALUES(?,?,?,?,?,?,?)',
                            (int(time.time()), result, actor, aircraft, cid, action, reason))
        except Exception as exc:
            raise CommandError('audit storage failure') from exc

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
            os.close(self.state_fd)
            os.close(self.lock)


@contextmanager
def _network_deadline(seconds):
    # The reference CLI is POSIX/single-threaded (as is its SQLite writer).
    # Refuse unsupported contexts rather than leave a late background sender.
    if threading.current_thread() is not threading.main_thread() or signal.getitimer(signal.ITIMER_REAL)[0]:
        raise CommandError('live transport requires an exclusive main-thread timer')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(_signum, _frame):
        raise CommandError('bridge operation deadline exceeded')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _tls_material(endpoint):
    return {k: read_private(endpoint[k], 65536) for k in ('ca_file', 'client_cert', 'client_key')}


class HTTPSBridgeTransport:
    """Verified mTLS, fixed destination, bounded response; no proxy or retries."""
    def __init__(self, materials=None):
        self.materials = materials or {}
    def send(self, endpoint, message):
        if not _endpoint_valid(endpoint):
            raise CommandError('invalid pinned endpoint')
        with _network_deadline(endpoint['timeout']):
            return self._send(endpoint, message)

    def _send(self, endpoint, message):
        material = self.materials.get(canonical(endpoint)) or _tls_material(endpoint)
        # CA is loaded from the exact checked bytes. OpenSSL's cert loader needs
        # filenames: copy only checked snapshots into a private temporary directory.
        context = ssl.create_default_context(cadata=material['ca_file'].decode('ascii'))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        with tempfile.TemporaryDirectory(prefix='civilian-tls-') as directory:
            cert, key = Path(directory) / 'cert', Path(directory) / 'key'
            for path, content in ((cert, material['client_cert']), (key, material['client_key'])):
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(content)
            context.load_cert_chain(cert, key)
        context.check_hostname = True
        conn = http.client.HTTPSConnection(endpoint['host'], endpoint['port'], context=context,
                                           timeout=endpoint['timeout'])
        try:
            data = canonical(message)
            conn.request('POST', endpoint['path'], body=data,
                         headers={'Content-Type': 'application/json', 'Content-Length': str(len(data))})
            response = conn.getresponse()
            data = response.read(16385)
            if not 200 <= response.status < 300 or len(data) > 16384:
                raise CommandError('bridge HTTP failure')
            return decode_json(data)
        finally:
            conn.close()


class MockTransport:
    def __init__(self, status, ack):
        self.status, self.ack, self.messages = status, ack, []

    def send(self, endpoint, message):
        self.messages.append(message)
        return self.status if message.get('kind') == 'status_request' else self.ack


class CivilianCommandService:
    def __init__(self, config_path, state_path, initialize_state=False, transport=None, clock=None):
        self.clock = clock or time.time
        try:
            config = decode_json(read_private(config_path, 65536))
            required = {'enabled', 'deployment', 'actors', 'aircraft'}
            if (type(config) is not dict or not required <= set(config)
                    or set(config) - required - {'bounded_runs_enabled'}
                    or type(config['enabled']) is not bool
                    or type(config.get('bounded_runs_enabled', False)) is not bool
                    or not _identifier(config['deployment'])
                    or type(config['actors']) is not dict or type(config['aircraft']) is not dict
                    or not 1 <= len(config['actors']) <= 64 or not 1 <= len(config['aircraft']) <= 64):
                raise CommandError('invalid config schema')
            self.actor_keys, self.bridge_keys, materials = {}, {}, {}
            for name, actor in config['actors'].items():
                needed = {'kind', 'key_file', 'aircraft', 'actions'}
                if (not _identifier(name) or type(actor) is not dict or not needed <= set(actor)
                        or set(actor) - needed - {'allow_bounded_runs'}
                        or actor['kind'] != 'human-operator'
                        or type(actor.get('allow_bounded_runs', False)) is not bool
                        or type(actor['aircraft']) is not list or not actor['aircraft']
                        or not all(_identifier(v) and v in config['aircraft'] for v in actor['aircraft'])
                        or type(actor['actions']) is not list or not actor['actions']
                        or any(type(v) is not str or v not in ACTIONS for v in actor['actions'])):
                    raise CommandError('invalid operator allowlist')
                self.actor_keys[name] = _secret(actor['key_file'])
            for name, ac in config['aircraft'].items():
                if (not _identifier(name) or type(ac) is not dict
                        or set(ac) != {'classification', 'status_key_file', 'endpoint'}
                        or ac['classification'] != 'civilian' or not _endpoint_valid(ac['endpoint'])):
                    raise CommandError('invalid civilian aircraft enrollment')
                self.bridge_keys[name] = _secret(ac['status_key_file'])
                materials[canonical(ac['endpoint'])] = _tls_material(ac['endpoint'])
            keys = list(self.actor_keys.values()) + list(self.bridge_keys.values())
            if len(set(keys)) != len(keys):
                raise CommandError('separate operator and bridge keys are required')
            self.config = config
            self.enabled = config['enabled']
            self.actors, self.aircraft = config['actors'], config['aircraft']
            binding = {'config_sha256': hashlib.sha256(canonical(config)).hexdigest(),
                       'actor_keys': {k: hashlib.sha256(v).hexdigest() for k, v in self.actor_keys.items()},
                       'bridge_keys': {k: hashlib.sha256(v).hexdigest() for k, v in self.bridge_keys.items()},
                       'tls_material': {k.decode(): {name: hashlib.sha256(value).hexdigest()
                                                   for name, value in material.items()}
                                        for k, material in materials.items()}}
            self.transport = transport or HTTPSBridgeTransport(materials)
            self.ledger = _Ledger(state_path, binding, initialize_state)
        except CommandError:
            raise
        except Exception as exc:
            raise CommandError('protected command configuration unavailable or invalid') from exc

    def validate_request(self, request):
        """Validate without transport, replay consumption, or side effects."""
        try:
            if not self.enabled:
                raise CommandError('civilian command path disabled')
            if type(request) is not dict or set(request) != REQUEST_KEYS | {'signature'}:
                raise CommandError('unknown or missing request fields')
            if len(canonical(request)) > MAX_REQUEST:
                raise CommandError('request too large')
            if (type(request['version']) is not int or request['version'] != 1
                    or request['deployment'] != self.config['deployment']
                    or request['initiation'] != 'operator'
                    or any(not _identifier(request[k]) for k in ('actor', 'aircraft', 'command_id', 'action'))
                    or request['action'] not in ACTIONS
                    or type(request['sequence']) is not int or not 0 <= request['sequence'] < 2**63):
                raise CommandError('unsupported request')
            actor = self.actors.get(request['actor'])
            if (actor is None or request['aircraft'] not in actor['aircraft']
                    or request['action'] not in actor['actions']):
                raise CommandError('operator or aircraft not allowed')
            _verify_signature(request, self.actor_keys[request['actor']])
            _fresh(request, self.clock())
            return dict(request)
        except CommandError:
            raise
        except Exception as exc:
            raise CommandError('malformed command request') from exc

    def dispatch(self, request, before_send=None):
        sent = False
        req = None
        try:
            req = self.validate_request(request)
            self.ledger.consume(req['actor'], req['command_id'], req['sequence'],
                                int(self.clock()), (req['aircraft'], req['action']))
            ac = self.aircraft[req['aircraft']]
            key = self.bridge_keys[req['aircraft']]
            status = self.transport.send(ac['endpoint'], {'kind': 'status_request', **{
                k: req[k] for k in ('deployment', 'aircraft', 'command_id', 'action')}})
            self._verify_status(status, req, key)
            if before_send is not None:
                if before_send(dict(req)) is False:
                    raise CommandError('dispatch cancelled before send')
            # Hooks and status retrieval may consume the authorization window.
            _fresh(req, self.clock())
            _fresh(status, self.clock())
            self.ledger.audit('dispatching', req['actor'], req['aircraft'], req['command_id'], req['action'])
            if before_send is not None:
                if before_send(dict(req)) is False:
                    raise CommandError('dispatch cancelled before send')
            _fresh(req, self.clock())
            unsigned = dict(req)
            signature = unsigned.pop('signature')
            sent = True
            ack = self.transport.send(ac['endpoint'], {'kind': 'command', 'request': unsigned, 'signature': signature})
            self._verify_ack(ack, req, key)
            self.ledger.audit('ack_received', req['actor'], req['aircraft'], req['command_id'], req['action'])
            return {'status': 'ack_received', 'physical_success': False, 'ack': ack}
        except Exception as exc:
            # Never store raw untrusted payload, signature, key, or exception text.
            self.ledger.audit('unknown' if sent else 'rejected',
                              req['actor'] if req else None, req['aircraft'] if req else None,
                              req['command_id'] if req else None, req['action'] if req else None,
                              'possible_send' if sent else 'validation_or_safety_gate')
            if sent:
                raise CommandError('unknown outcome after possible send; do not retry') from exc
            if isinstance(exc, CommandError):
                raise
            raise CommandError('command rejected before dispatch') from exc

    def _verify_status(self, status, req, key):
        keys = {'deployment', 'aircraft', 'command_id', 'action', 'classification',
                'allowed_actions', 'ready', 'issued_at', 'expires_at', 'signature'}
        if type(status) is not dict or set(status) != keys:
            raise CommandError('invalid signed status')
        body = _verify_signature(status, key)
        if (any(body[k] != req[k] for k in ('deployment', 'aircraft', 'command_id', 'action'))
                or body['classification'] != 'civilian' or body['ready'] is not True
                or type(body['allowed_actions']) is not list
                or any(type(v) is not str or v not in ACTIONS for v in body['allowed_actions'])
                or req['action'] not in body['allowed_actions']):
            raise CommandError('status identity or readiness rejected')
        _fresh(body, self.clock())
        if body['issued_at'] < req['issued_at']:
            raise CommandError('status predates authorization')

    def _verify_ack(self, ack, req, key):
        keys = {'deployment', 'actor', 'aircraft', 'command_id', 'action', 'accepted',
                'issued_at', 'expires_at', 'signature'}
        if type(ack) is not dict or set(ack) != keys:
            raise CommandError('invalid signed acknowledgement')
        body = _verify_signature(ack, key)
        if (any(body[k] != req[k] for k in ('deployment', 'actor', 'aircraft', 'command_id', 'action'))
                or body['accepted'] is not True or body['issued_at'] < req['issued_at']):
            raise CommandError('ack identity or acceptance rejected')
        _fresh(body, self.clock())

    def close(self):
        self.ledger.close()
