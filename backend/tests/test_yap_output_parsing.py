from main import _extract_json_blob


def test_extract_json_blob_returns_last_object_when_multiple_objects_are_logged():
    raw = """
{"event":"debug","practiceId":26}
{"ok":true,"result":{"saved":true,"mode":"commit"}}
""".strip()

    parsed = _extract_json_blob(raw)

    assert isinstance(parsed, dict)
    assert parsed.get("ok") is True
    assert parsed.get("result", {}).get("mode") == "commit"


def test_extract_json_blob_handles_braces_inside_json_string_values():
    raw = """
{"event":"debug","message":"before {not-json} after"}
{"ok":true,"result":{"saved":false,"mode":"commit-blocked-duplicate"}}
""".strip()

    parsed = _extract_json_blob(raw)

    assert isinstance(parsed, dict)
    assert parsed.get("result", {}).get("mode") == "commit-blocked-duplicate"
