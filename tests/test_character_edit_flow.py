import os
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token")

from bot.cogs.character.edit_flow import (
    CharacterEditError,
    fetch_editable_character,
    fetch_editable_characters,
    update_character_from_flow,
)
from db.models import Base, Character


class CharacterEditFlowTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.get_session_patch = patch(
            "bot.cogs.character.edit_flow.get_session",
            side_effect=self.session_factory,
        )
        self.get_session_patch.start()

        session = self.session_factory()
        session.add_all(
            [
                Character(
                    id=1,
                    guild_id=100,
                    discord_user_id=200,
                    char_name="Arthas",
                    realm="Icecrown",
                    char_class="Paladin",
                    spec="Holy",
                    gearscore=6200,
                ),
                Character(
                    id=2,
                    guild_id=100,
                    discord_user_id=200,
                    char_name="Arthas",
                    realm="Icecrown",
                    char_class="Paladin",
                    spec="Protection",
                    gearscore=6100,
                ),
                Character(
                    id=3,
                    guild_id=100,
                    discord_user_id=999,
                    char_name="Other",
                    realm="Icecrown",
                    char_class="Mage",
                    spec="Fire",
                    gearscore=6000,
                ),
            ]
        )
        session.commit()
        session.close()

    def tearDown(self):
        self.get_session_patch.stop()
        self.engine.dispose()

    def test_fetch_is_scoped_to_user_and_guild(self):
        characters = fetch_editable_characters(100, 200)

        self.assertEqual([character.id for character in characters], [1, 2])

    def test_fetch_one_enforces_ownership(self):
        self.assertEqual(fetch_editable_character(1, 100, 200).char_name, "Arthas")
        self.assertIsNone(fetch_editable_character(3, 100, 200))

    def test_edit_propagates_shared_fields_and_only_updates_selected_gearscore(self):
        updated = update_character_from_flow(
            character_id=1,
            guild_id=100,
            discord_user_id=200,
            name="uther",
            realm="blackrock",
            char_class="pala",
            spec="Retribution",
            gearscore="6.5k",
        )

        self.assertEqual(updated.char_name, "Uther")
        self.assertEqual(updated.spec, "Retribution")
        self.assertEqual(updated.gearscore, 6500)

        session = self.session_factory()
        selected = session.get(Character, 1)
        other_spec = session.get(Character, 2)
        self.assertEqual(selected.char_name, "Uther")
        self.assertEqual(other_spec.char_name, "Uther")
        self.assertEqual(selected.realm, "Blackrock")
        self.assertEqual(other_spec.realm, "Blackrock")
        self.assertEqual(selected.spec, "Retribution")
        self.assertEqual(other_spec.spec, "Protection")
        self.assertEqual(selected.gearscore, 6500)
        self.assertEqual(other_spec.gearscore, 6100)
        self.assertEqual(selected.role.value, "dps")
        self.assertEqual(other_spec.role.value, "tank")
        session.close()

    def test_cannot_edit_another_users_character(self):
        with self.assertRaisesRegex(CharacterEditError, "not yours"):
            update_character_from_flow(
                character_id=3,
                guild_id=100,
                discord_user_id=200,
                name="Other",
                realm="Icecrown",
                char_class="Mage",
                spec="Fire",
                gearscore="6000",
            )

    def test_duplicate_spec_is_rejected(self):
        with self.assertRaisesRegex(CharacterEditError, "already has a Protection entry"):
            update_character_from_flow(
                character_id=1,
                guild_id=100,
                discord_user_id=200,
                name="Arthas",
                realm="Icecrown",
                char_class="Paladin",
                spec="Protection",
                gearscore="6200",
            )

    def test_invalid_class_is_rejected(self):
        with self.assertRaisesRegex(CharacterEditError, "valid WoW class"):
            update_character_from_flow(
                character_id=1,
                guild_id=100,
                discord_user_id=200,
                name="Arthas",
                realm="Icecrown",
                char_class="Bard",
                spec="Music",
                gearscore="6200",
            )

    def test_class_change_cannot_leave_incompatible_specs(self):
        with self.assertRaisesRegex(CharacterEditError, "other spec.*Protection"):
            update_character_from_flow(
                character_id=1,
                guild_id=100,
                discord_user_id=200,
                name="Arthas",
                realm="Icecrown",
                char_class="Mage",
                spec="Fire",
                gearscore="6200",
            )


if __name__ == "__main__":
    unittest.main()
