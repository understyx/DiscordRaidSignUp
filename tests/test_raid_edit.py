import datetime
import os
import unittest

os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token")

from bot.cogs.raid.cog import EditRaidModal, _build_signup_embed, _parse_raid_datetime
from bot.cogs.signup.embed import _build_signup_embed as _build_refreshed_signup_embed
from bot.cogs.signup.embed import _utc_timestamp
from db.models import RaidStatus


class RaidEditTests(unittest.TestCase):
    def test_parse_raid_datetime_is_utc(self):
        parsed = _parse_raid_datetime("2026-08-20 18:30")

        self.assertEqual(
            parsed, datetime.datetime(2026, 8, 20, 18, 30, tzinfo=datetime.timezone.utc)
        )

    def test_naive_database_datetime_is_interpreted_as_utc(self):
        self.assertEqual(
            _utc_timestamp(datetime.datetime(2026, 8, 20, 18, 30)),
            1787250600,
        )

    def test_initial_embed_shows_relative_time_until_raid(self):
        raid = type(
            "RaidData",
            (),
            {
                "id": 9,
                "name": "Thursday ICC",
                "raid_instance": "ICC 25",
                "date": datetime.datetime(2026, 8, 20, 18, 30),
                "description": "Bring flasks",
                "status": RaidStatus.open,
            },
        )()

        embed = _build_signup_embed(raid, [])
        relative_field = next(field for field in embed.fields if field.name == "⏳ Time until raid")

        self.assertEqual(relative_field.value, "<t:1787250600:R>")

    def test_refreshed_embed_shows_relative_time_until_raid(self):
        embed = _build_refreshed_signup_embed(
            {
                "id": 9,
                "name": "Thursday ICC",
                "raid_instance": "ICC 25",
                "date": datetime.datetime(2026, 8, 20, 18, 30),
                "description": "Bring flasks",
                "status": "open",
            },
            [],
        )
        relative_field = next(field for field in embed.fields if field.name == "⏳ Time until raid")

        self.assertEqual(relative_field.value, "<t:1787250600:R>")

    def test_edit_modal_prefills_all_editable_raid_fields(self):
        modal = EditRaidModal(
            {
                "id": 9,
                "guild_raid_number": 4,
                "name": "Thursday ICC",
                "raid_instance": "ICC 25",
                "date": datetime.datetime(2026, 8, 20, 18, 30),
                "description": "Bring flasks",
                "max_size": 25,
            }
        )

        self.assertEqual(
            [field.to_component_dict()["label"] for field in modal.children],
            [
                "Raid Name",
                "Raid Instance",
                "Date (YYYY-MM-DD HH:MM UTC)",
                "Description",
                "Raid Size (1-100)",
            ],
        )
        self.assertEqual(modal.children[2].default, "2026-08-20 18:30")
        self.assertEqual(modal.children[4].default, "25")


if __name__ == "__main__":
    unittest.main()
