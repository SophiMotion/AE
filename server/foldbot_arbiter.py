"""One local FoldBot owner across all control frontends; never performs I/O."""
import threading


class FoldBotArbiter:
    def __init__(self):
        self._lock = threading.Lock()
        self._owner = None
        self._mode = None
        self._phase = 'idle'

    def reserve(self, owner, mode):
        with self._lock:
            if self._owner is not None:
                return False
            self._owner, self._mode, self._phase = owner, mode, 'reserved'
            return True

    def stopping(self, owner):
        with self._lock:
            if self._owner == owner:
                self._phase = 'stopping'

    def release(self, owner):
        with self._lock:
            if self._owner != owner:
                return False
            self._owner, self._mode, self._phase = None, None, 'idle'
            return True

    def owns(self, owner):
        with self._lock:
            return self._owner == owner

    def status(self):
        with self._lock:
            return dict(mode=self._mode, phase=self._phase, occupied=self._owner is not None)
