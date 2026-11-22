import contextlib
import os
import time


@contextlib.contextmanager
def file_lock(path,nonblocking=False):
    with path.open("a+b") as f:
        if os.name=="nt":
            import msvcrt
            while True:
                f.seek(0)
                try:
                    msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
                    break
                except OSError as err:
                    if nonblocking: raise BlockingIOError() from err
                    time.sleep(.1)
        else:
            import fcntl
            fcntl.flock(f,fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        yield
