import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token")

from bot.cogs.character.cog import CharacterCog
from bot.cogs.character.helpnoobs import (
    HelpNoobsChoiceView,
    _message_guild_id,
    _useful_commands_embed,
)
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

    def test_helpraidbot_replaces_helpnoobs_and_has_optional_destinations(self):
        commands = {command.name: command for command in CharacterCog.__cog_app_commands__}

        self.assertIn("helpraidbot", commands)
        self.assertNotIn("helpnoobs", commands)
        parameter_names = {parameter.name for parameter in commands["helpraidbot"].parameters}
        self.assertEqual(parameter_names, {"user", "embed_channel"})

    def test_useful_commands_embed_lists_current_character_commands(self):
        embed = _useful_commands_embed()
        field_text = "\n".join(field.value for field in embed.fields)

        self.assertNotIn("/edit_characters", field_text)
        self.assertNotIn("/edit_character`", field_text)
        self.assertIn("/my_characters", field_text)
        self.assertIn("names, classes, specs, and GS", field_text)
        self.assertIn("/saves view", field_text)

    def test_website_queued_guide_preserves_its_guild_context_in_footer(self):
        interaction = SimpleNamespace(
            message=SimpleNamespace(
                embeds=[
                    SimpleNamespace(
                        footer=SimpleNamespace(text="Sent for Citadel · Guild ID: 123456")
                    )
                ]
            )
        )

        self.assertEqual(_message_guild_id(interaction), 123456)


class HelpRaidBotDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cog = CharacterCog(Mock())
        self.interaction = SimpleNamespace(
            guild_id=123,
            response=SimpleNamespace(send_message=AsyncMock()),
            user=SimpleNamespace(id=456),
        )

    async def test_member_gets_ephemeral_guide_without_destination(self):
        await CharacterCog.helpraidbot.callback(self.cog, self.interaction)

        kwargs = self.interaction.response.send_message.await_args.kwargs
        self.assertTrue(kwargs["ephemeral"])
        self.assertIsNotNone(kwargs["embed"])
        self.assertIsInstance(kwargs["view"], HelpNoobsChoiceView)

    @patch("bot.cogs.character.cog.has_officer_access", new_callable=AsyncMock)
    async def test_user_takes_precedence_over_channel_for_developer(self, officer_check):
        officer_check.return_value = False
        user = SimpleNamespace(id=789, mention="<@789>", send=AsyncMock())
        channel = SimpleNamespace(send=AsyncMock())

        with patch("bot.cogs.character.cog.config.DEV_USER_ID", "456"):
            await CharacterCog.helpraidbot.callback(
                self.cog,
                self.interaction,
                user=user,
                embed_channel=channel,
            )

        user.send.assert_awaited_once()
        channel.send.assert_not_awaited()
        sent_view = user.send.await_args.kwargs["view"]
        self.assertEqual(sent_view.guild_id, 123)
        self.assertEqual(sent_view.intended_user_id, 789)

    @patch("bot.cogs.character.cog.has_officer_access", new_callable=AsyncMock)
    async def test_non_officer_cannot_post_to_channel(self, officer_check):
        officer_check.return_value = False
        channel = SimpleNamespace(mention="#help", send=AsyncMock())

        await CharacterCog.helpraidbot.callback(
            self.cog,
            self.interaction,
            embed_channel=channel,
        )

        channel.send.assert_not_awaited()
        self.assertIn(
            "Only officers",
            self.interaction.response.send_message.await_args.args[0],
        )


if __name__ == "__main__":
    unittest.main()
