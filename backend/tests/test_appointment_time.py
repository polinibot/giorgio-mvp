import pytest

from appointment_time import validate_appointment_time, normalize_appointment_time


def test_validates_raw_time_and_normalizes_to_yap_slot():
    assert validate_appointment_time("09:24") == "09:24"
    assert validate_appointment_time("14:30") == "14:30"
    assert normalize_appointment_time("09:24") == "09:20"
    assert normalize_appointment_time("14:30") == "14:40"


def test_rejects_invalid():
    with pytest.raises(ValueError):
        validate_appointment_time("25:00")
    with pytest.raises(ValueError):
        validate_appointment_time("9:24")
    with pytest.raises(ValueError):
        validate_appointment_time("00:40")
    with pytest.raises(ValueError):
        normalize_appointment_time("07:15")
