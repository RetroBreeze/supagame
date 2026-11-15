"""Drive the real CLI through a Linux PTY; no third-party terminal dependency."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

request = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(request['cwd'])
    os.execve(request['command'][0], request['command'], request['env'])
transcript = b''
steps = list(request.get('steps', []))
cursor = 0
deadline = time.monotonic() + 20
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                transcript += chunk
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
        if steps:
            marker, answer = steps[0]
            index = transcript.find(marker.encode(), cursor)
            if index >= 0:
                cursor = index + len(marker.encode())
                os.write(fd, answer.encode())
                steps.pop(0)
    ended, status = os.waitpid(pid, os.WNOHANG)
    # A PTY can close just before waitpid observes process exit, especially
    # under the full parallel unit suite. Keep the original bounded deadline.
    while not ended and time.monotonic() < deadline:
        time.sleep(0.01)
        ended, status = os.waitpid(pid, os.WNOHANG)
    if not ended:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
        raise RuntimeError('PTY command did not exit: ' + transcript.decode(errors='replace'))
    if steps:
        raise RuntimeError('PTY prompts were not reached: ' + transcript.decode(errors='replace'))
    print(json.dumps({'code': os.waitstatus_to_exitcode(status), 'output': transcript.decode(errors='replace')}))
finally:
    os.close(fd)
