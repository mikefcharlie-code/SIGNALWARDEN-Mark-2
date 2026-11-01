"""Explicit invocation only. Normal application startup never launches this CLI."""
from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path

from .core import CivilianCommandService, CommandError, decode_json
from .supervisor import BoundedRunSupervisor


def main(argv=None):
    parser = argparse.ArgumentParser(description='Dispatch signed civilian requests or an operator-authorized bounded run.')
    parser.add_argument('--config', required=True)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--request', help='One signed JSON command file, or - for stdin')
    inputs.add_argument('--run', help='One signed, fixed bounded-run authorization, or - for stdin')
    parser.add_argument('--state', required=True)
    parser.add_argument('--initialize-state', action='store_true')
    args = parser.parse_args(argv)
    service = None
    old_handler = None
    try:
        source = args.run or args.request
        if source == '-':
            raw = sys.stdin.buffer.read(16385)
        else:
            with Path(source).open('rb') as stream:
                raw = stream.read(16385)
        if len(raw) > 16384:
            raise CommandError('input too large')
        signed = decode_json(raw)
        service = CivilianCommandService(args.config, args.state, args.initialize_state)
        if args.run:
            def observe(event):
                print(json.dumps(event, sort_keys=True), flush=True)
            supervisor = BoundedRunSupervisor(service, observe)
            def interrupt(_signum, _frame):
                supervisor.abort()
                raise CommandError('operator interrupted run; reconcile any already-dispatched command')
            old_handler = signal.signal(signal.SIGINT, interrupt)
            result = supervisor.run(signed)
        else:
            result = service.dispatch(signed)
        print(json.dumps(result, sort_keys=True), flush=True)
        return 0
    except (OSError, ValueError, CommandError, KeyboardInterrupt):
        # No exception/payload contents: error details may contain sensitive paths.
        print('Civilian operation stopped or rejected; consult protected audit. A possible send has unknown physical outcome; never retry automatically.', file=sys.stderr)
        return 2
    finally:
        if old_handler is not None:
            signal.signal(signal.SIGINT, old_handler)
        if service is not None:
            service.close()


if __name__ == '__main__':
    raise SystemExit(main())
