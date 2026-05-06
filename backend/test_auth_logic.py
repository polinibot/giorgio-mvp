import unittest
from types import SimpleNamespace

from models import PracticeStatus
from main import (
    _can_access_draft_via_plate_compat,
    _can_access_practice,
    _repair_practice_owner_if_needed,
    _repair_practice_owner_via_plate_compat,
)
from security import SecurityService


class FakeDb:
    def __init__(self):
        self.commits = 0
        self.refreshes = 0

    def commit(self):
        self.commits += 1

    def refresh(self, _obj):
        self.refreshes += 1


class AuthLogicTests(unittest.TestCase):
    def test_access_token_is_bound_to_practice_and_user(self):
        token = SecurityService.generate_practice_access_token(7, 123)
        self.assertTrue(SecurityService.validate_practice_access_token(7, 123, token))
        self.assertFalse(SecurityService.validate_practice_access_token(8, 123, token))
        self.assertFalse(SecurityService.validate_practice_access_token(7, 999, token))

    def test_can_access_practice_with_owner_match_without_token(self):
        practice = SimpleNamespace(id=5, created_by_telegram_id=123)
        user_data = {"id": 123}
        self.assertTrue(_can_access_practice(practice, user_data, access_token=None))

    def test_can_access_practice_with_valid_token_even_if_owner_differs(self):
        token = SecurityService.generate_practice_access_token(5, 123)
        practice = SimpleNamespace(id=5, created_by_telegram_id=999)
        user_data = {"id": 123}
        self.assertTrue(_can_access_practice(practice, user_data, access_token=token))

    def test_cannot_access_practice_with_invalid_token_and_wrong_owner(self):
        practice = SimpleNamespace(id=5, created_by_telegram_id=999)
        user_data = {"id": 123}
        self.assertFalse(_can_access_practice(practice, user_data, access_token="bad-token"))

    def test_repair_owner_with_valid_access_token(self):
        token = SecurityService.generate_practice_access_token(9, 555)
        practice = SimpleNamespace(id=9, created_by_telegram_id=111, updated_by_telegram_id=None)
        user_data = {"id": 555}
        db = FakeDb()

        _repair_practice_owner_if_needed(db, practice, user_data, token)

        self.assertEqual(practice.created_by_telegram_id, 555)
        self.assertEqual(practice.updated_by_telegram_id, 555)
        self.assertEqual(db.commits, 1)
        self.assertEqual(db.refreshes, 1)

    def test_draft_plate_compat_only_allows_matching_draft(self):
        draft = SimpleNamespace(status=PracticeStatus.DRAFT, plate_confirmed="EG487YR")
        confirmed = SimpleNamespace(status=PracticeStatus.CONFIRMED, plate_confirmed="EG487YR")

        self.assertTrue(_can_access_draft_via_plate_compat(draft, "eg487yr"))
        self.assertFalse(_can_access_draft_via_plate_compat(draft, "AA111AA"))
        self.assertFalse(_can_access_draft_via_plate_compat(confirmed, "EG487YR"))

    def test_repair_owner_via_plate_compat_updates_owner(self):
        practice = SimpleNamespace(id=11, created_by_telegram_id=222, updated_by_telegram_id=None)
        user_data = {"id": 333}
        db = FakeDb()

        _repair_practice_owner_via_plate_compat(db, practice, user_data)

        self.assertEqual(practice.created_by_telegram_id, 333)
        self.assertEqual(practice.updated_by_telegram_id, 333)
        self.assertEqual(db.commits, 1)
        self.assertEqual(db.refreshes, 1)


if __name__ == "__main__":
    unittest.main()
