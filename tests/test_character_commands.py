import os
import unittest

os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token")

from bot.cogs.character.cog import CharacterCog
from bot.cogs.character.helpnoobs import HelpNoobsChoiceView, _useful_commands_embed
from bot.cogs.dev import DevCog


class CharacterCommandTests(unittest.TestCase):
    def test_my_characters_is_the_only_edit_command(self):
        command_names = {command.name for command in CharacterCog.__cog_app_commands__}

        self.assertIn("my_characters", command_names)
        self.assertNotIn("edit_characters", command_names)
        self.assertNotIn("edit_character", command_names)

    def test_seed_fake_users_is_not_registered(self):
        command_names = {command.name for command in DevCog.__cog_app_commands__}

        self.assertNotIn("seed_fake_users", command_names)

    def test_helpnoobs_has_persistent_useful_commands_button(self):
        view = HelpNoobsChoiceView()
        buttons = {item.custom_id: item for item in view.children}

        self.assertIsNone(view.timeout)
        self.assertIn("helpnoobs:commands", buttons)
        self.assertEqual(buttons["helpnoobs:commands"].label, "Show useful bot commands")

    def test_useful_commands_embed_lists_current_character_commands(self):
        embed = _useful_commands_embed()
        field_text = "\n".join(field.value for field in embed.fields)

        self.assertNotIn("/edit_characters", field_text)
        self.assertNotIn("/edit_character`", field_text)
        self.assertIn("/my_characters", field_text)
        self.assertIn("names, classes, specs, and GS", field_text)
        self.assertIn("/saves view", field_text)


if __name__ == "__main__":
    unittest.main()
