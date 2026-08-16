import os
import unittest
from unittest.mock import patch

import discord
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token")

from bot.cogs.character.edit_flow import (
    CharacterEditError,
    CharacterEditView,
    EditableCharacter,
    EditableSpec,
    EditCharacterModal,
    build_character_list_embed,
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

        self.assertEqual([character.id for character in characters], [1])
        self.assertEqual(
            [(spec.name, spec.gearscore) for spec in characters[0].specs],
            [("Holy", 6200), ("Protection", 6100)],
        )

    def test_fetch_one_enforces_ownership(self):
        self.assertEqual(fetch_editable_character(1, 100, 200).char_name, "Arthas")
        self.assertIsNone(fetch_editable_character(3, 100, 200))

    def test_picker_and_modal_edit_a_whole_character(self):
        characters = fetch_editable_characters(100, 200)
        view = CharacterEditView(user_id=200, guild_id=100, characters=characters)
        picker = view.children[0]

        self.assertEqual(len(picker.options), 1)
        self.assertEqual(picker.options[0].label, "Arthas")
        self.assertIn("Holy, Protection", picker.options[0].description)

        modal = EditCharacterModal(user_id=200, guild_id=100, character=characters[0])
        self.assertEqual(
            [field.to_component_dict()["label"] for field in modal.children],
            ["Character name", "Class", "Specializations and gearscores"],
        )
        self.assertEqual(modal.children[2].style, discord.TextStyle.paragraph)
        self.assertEqual(modal.children[2].default, "Holy / 6200\nProtection / 6100")

    def test_character_picker_pages_after_25_characters(self):
        characters = [
            EditableCharacter(
                id=index,
                char_name=f"Character{index}",
                realm="Icecrown",
                char_class="Mage",
                specs=(EditableSpec("Fire", 6000 + index),),
            )
            for index in range(1, 27)
        ]
        view = CharacterEditView(user_id=200, guild_id=100, characters=characters)

        self.assertEqual(view.page_count, 2)
        self.assertEqual(len(view.children[0].options), 25)
        self.assertTrue(view.children[1].disabled)
        self.assertEqual(view.children[2].to_component_dict()["label"], "Page 1/2")
        self.assertFalse(view.children[3].disabled)

        view.page = 1
        view._rebuild_items()

        self.assertEqual([option.value for option in view.children[0].options], ["26"])
        self.assertFalse(view.children[1].disabled)
        self.assertEqual(view.children[2].to_component_dict()["label"], "Page 2/2")
        self.assertTrue(view.children[3].disabled)

        first_embed = build_character_list_embed("Edgy", characters, 0)
        second_embed = build_character_list_embed("Edgy", characters, 1)
        self.assertEqual(len(first_embed.fields), 25)
        self.assertEqual(len(second_embed.fields), 1)
        self.assertEqual(second_embed.fields[0].name, "Character26")
        self.assertIn("Showing 26–26 of 26 characters", second_embed.description)

    def test_character_list_embed_shows_only_name_class_specs_and_gs(self):
        characters = fetch_editable_characters(100, 200)

        embed = build_character_list_embed("Edgy", characters, 0)
        field = embed.fields[0]

        self.assertEqual(field.name, "Arthas")
        self.assertIn("**Class:** Paladin", field.value)
        self.assertIn("**Holy:** GS 6200", field.value)
        self.assertIn("**Protection:** GS 6100", field.value)
        self.assertNotIn("Role", field.value)
        self.assertNotIn("Realm", field.value)
        self.assertNotIn("Icecrown", field.name)

    def test_edit_updates_the_whole_character_from_spec_lines(self):
        updated = update_character_from_flow(
            character_id=1,
            guild_id=100,
            discord_user_id=200,
            name="uther",
            char_class="pala",
            spec_gearscores="Holy / 6.5k\nRetribution / 6.4",
        )

        self.assertEqual(updated.char_name, "Uther")
        self.assertEqual(
            [(spec.name, spec.gearscore) for spec in updated.specs],
            [("Holy", 6500), ("Retribution", 6400)],
        )

        session = self.session_factory()
        selected = session.get(Character, 1)
        other_spec = session.get(Character, 2)
        self.assertEqual(selected.char_name, "Uther")
        self.assertEqual(selected.realm, "Icecrown")
        self.assertEqual(selected.spec, "Holy")
        self.assertEqual(selected.gearscore, 6500)
        self.assertEqual(selected.role.value, "healer")
        self.assertTrue(other_spec.is_deleted)
        self.assertEqual(other_spec.spec, "Protection")
        self.assertEqual(other_spec.gearscore, 6100)
        new_spec = (
            session.query(Character)
            .filter_by(char_name="Uther", spec="Retribution", is_deleted=False)
            .one()
        )
        self.assertEqual(new_spec.gearscore, 6400)
        self.assertEqual(new_spec.role.value, "dps")
        session.close()

    def test_cannot_edit_another_users_character(self):
        with self.assertRaisesRegex(CharacterEditError, "not yours"):
            update_character_from_flow(
                character_id=3,
                guild_id=100,
                discord_user_id=200,
                name="Other",
                char_class="Mage",
                spec_gearscores="Fire / 6000",
            )

    def test_duplicate_spec_line_is_rejected(self):
        with self.assertRaisesRegex(CharacterEditError, "listed more than once"):
            update_character_from_flow(
                character_id=1,
                guild_id=100,
                discord_user_id=200,
                name="Arthas",
                char_class="Paladin",
                spec_gearscores="Protection / 6200\nprotection / 6100",
            )

    def test_invalid_class_is_rejected(self):
        with self.assertRaisesRegex(CharacterEditError, "valid WoW class"):
            update_character_from_flow(
                character_id=1,
                guild_id=100,
                discord_user_id=200,
                name="Arthas",
                char_class="Bard",
                spec_gearscores="Music / 6200",
            )

    def test_class_change_replaces_specs_together(self):
        updated = update_character_from_flow(
            character_id=1,
            guild_id=100,
            discord_user_id=200,
            name="Arthas",
            char_class="Mage",
            spec_gearscores="Fire / 6200\nFrost / 6100",
        )

        self.assertEqual(updated.char_class, "Mage")
        self.assertEqual([spec.name for spec in updated.specs], ["Fire", "Frost"])

    def test_invalid_spec_line_format_is_rejected(self):
        with self.assertRaisesRegex(CharacterEditError, "Specialization / Gearscore"):
            update_character_from_flow(
                character_id=1,
                guild_id=100,
                discord_user_id=200,
                name="Arthas",
                char_class="Paladin",
                spec_gearscores="Holy 6200",
            )


if __name__ == "__main__":
    unittest.main()
