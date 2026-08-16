import unittest

from bot.class_utils import KNOWN_CLASSES, normalize_class
from bot.wow import CLASS_SPEC_ROLES, REALMS, WOW_CLASSES


class WowDataTests(unittest.TestCase):
    def test_shared_data_contains_supported_classes(self):
        self.assertEqual(KNOWN_CLASSES, frozenset(WOW_CLASSES))
        self.assertEqual(len(KNOWN_CLASSES), 10)

    def test_class_aliases_are_normalized(self):
        self.assertEqual(normalize_class(" dk "), "Death Knight")
        self.assertEqual(normalize_class("pally"), "Paladin")

    def test_spec_roles_and_realms_are_loaded(self):
        self.assertEqual(CLASS_SPEC_ROLES[("Druid", "Feral (Bear)")], "tank")
        self.assertEqual(CLASS_SPEC_ROLES[("Priest", "Discipline")], "healer")
        self.assertIn("Icecrown", REALMS)


if __name__ == "__main__":
    unittest.main()
