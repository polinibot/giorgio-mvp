import pytest

from appointment_time import validate_appointment_time


def test_accepts_five_minute_steps():
    assert validate_appointment_time("09:24") == "09:24"
    assert validate_appointment_time("14:30") == "14:30"


def test_rejects_invalid():
    with pytest.raises(ValueError):
        validate_appointment_time("25:00")
    with pytest.raises(ValueError):
        validate_appointment_time("9:24")
