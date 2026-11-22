#!/usr/bin/env python3
"""Run a command in a pseudo-terminal and relay it over stdin/stdout.

Usage: pty_bridge.py COLS ROWS CMD [ARGS...]
fd 3 takes "COLS ROWS\n" lines to resize the terminal.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    cols, rows, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    set_size(fd, cols, rows)
    inputs, ctl_buf, out = [fd, 0, 3], b"", sys.stdout.buffer
    while True:
        r, _, _ = select.select(inputs, [], [])
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out.write(data)
            out.flush()
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                os.kill(pid, signal.SIGHUP)
                break
            os.write(fd, data)
        if 3 in r:
            chunk = os.read(3, 1024)
            if not chunk:
                inputs.remove(3)
            ctl_buf += chunk
            while b"\n" in ctl_buf:
                line, ctl_buf = ctl_buf.split(b"\n", 1)
                c, rw = map(int, line.split())
                set_size(fd, c, rw)
                os.kill(pid, signal.SIGWINCH)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))


if __name__ == "__main__":
    main()
