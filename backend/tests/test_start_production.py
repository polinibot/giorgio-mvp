import subprocess

import pytest

import start_production


class FakeProc:
    def __init__(self, *, wait_result=None, wait_exception=None, returncode=0):
        self._wait_result = wait_result
        self._wait_exception = wait_exception
        self.returncode = returncode
        self.wait_calls = []

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        if self._wait_exception:
            raise self._wait_exception
        return self._wait_result

    def poll(self):
        return self.returncode


def test_migration_timeout_seconds_uses_default_on_invalid_value(monkeypatch):
    monkeypatch.setenv(start_production.MIGRATION_TIMEOUT_ENV, "not-a-number")
    assert start_production._migration_timeout_seconds() == start_production.DEFAULT_MIGRATION_TIMEOUT_SECONDS


def test_run_migrations_once_returns_false_on_timeout(monkeypatch):
    fake_proc = FakeProc(wait_exception=subprocess.TimeoutExpired(cmd="migrate", timeout=5))
    stopped = []

    monkeypatch.setenv(start_production.MIGRATION_TIMEOUT_ENV, "5")
    monkeypatch.setattr(start_production, "start_process", lambda args, env=None: fake_proc)
    monkeypatch.setattr(start_production, "stop_process", lambda proc: stopped.append(proc))

    assert start_production.run_migrations_once() is False
    assert fake_proc.wait_calls == [5]
    assert stopped == [fake_proc]


def test_run_migrations_once_raises_on_non_zero_exit(monkeypatch):
    fake_proc = FakeProc(returncode=3)
    monkeypatch.setattr(start_production, "start_process", lambda args, env=None: fake_proc)

    with pytest.raises(subprocess.CalledProcessError):
        start_production.run_migrations_once()


def test_run_migrations_once_returns_true_on_success(monkeypatch):
    fake_proc = FakeProc(returncode=0)
    monkeypatch.setattr(start_production, "start_process", lambda args, env=None: fake_proc)

    assert start_production.run_migrations_once() is True
    assert fake_proc.wait_calls == [start_production.DEFAULT_MIGRATION_TIMEOUT_SECONDS]
