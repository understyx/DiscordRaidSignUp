import datetime
import os
import unittest
from types import SimpleNamespace

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("DISCORD_BOT_TOKEN", "test-token")

from bot.cogs.signup.process import _save_text_signup_db
from db.models import Base, Character, DiscordUser, Raid, Signup, SignupStatus


class SignupProcessTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.user = SimpleNamespace(id=200, name="raider", display_name="Raider")

    def tearDown(self):
        self.engine.dispose()

    def _raid(self, *, raid_id=1, guild_id=100):
        return Raid(
            id=raid_id,
            guild_id=guild_id,
            guild_raid_number=1,
            name="ICC",
            date=datetime.datetime(2026, 8, 20, 18, 30),
            raid_instance="ICC 25",
            created_by=999,
        )

    @staticmethod
    def _entry(name, char_class, spec, gearscore, *, is_prio=False):
        return {
            "char_name": name,
            "char_class": char_class,
            "spec": spec,
            "gearscore": gearscore,
            "is_prio": is_prio,
            "is_saved": False,
            "note": "",
        }

    def test_new_characters_use_raid_guild_and_each_signup_links_to_its_character(self):
        session = self.session_factory()
        session.add_all(
            [
                self._raid(),
                Character(
                    guild_id=200,
                    discord_user_id=self.user.id,
                    char_name="Blackqiraji",
                    char_class="Death Knight",
                    spec="Unholy",
                    gearscore=5000,
                ),
            ]
        )
        session.commit()

        _save_text_signup_db(
            session,
            self.user,
            [
                self._entry("Blackqiraji", "Death Knight", "Unholy", 6145, is_prio=True),
                self._entry("Lightbringer", "Paladin", "Holy", 6200),
            ],
            raid_id=1,
            signup_status=SignupStatus.signed,
        )

        guild_characters = session.scalars(
            select(Character).where(Character.guild_id == 100).order_by(Character.char_name)
        ).all()
        self.assertEqual(
            [(char.char_name, char.guild_id) for char in guild_characters],
            [("Blackqiraji", 100), ("Lightbringer", 100)],
        )

        signups = session.scalars(select(Signup).order_by(Signup.id)).all()
        self.assertEqual(
            [signup.character.char_name for signup in signups],
            ["Blackqiraji", "Lightbringer"],
        )
        self.assertEqual([signup.character.guild_id for signup in signups], [100, 100])

        other_guild_character = session.scalar(select(Character).where(Character.guild_id == 200))
        self.assertEqual(other_guild_character.gearscore, 5000)
        session.close()

    def test_raid_without_guild_is_rejected_before_writes(self):
        session = self.session_factory()
        session.add(self._raid(guild_id=None))
        session.commit()

        with self.assertRaisesRegex(ValueError, "not associated with a guild"):
            _save_text_signup_db(
                session,
                self.user,
                [self._entry("Blackqiraji", "Death Knight", "Unholy", 6145)],
                raid_id=1,
                signup_status=SignupStatus.signed,
            )

        self.assertIsNone(session.get(DiscordUser, self.user.id))
        self.assertEqual(session.scalars(select(Character)).all(), [])
        self.assertEqual(session.scalars(select(Signup)).all(), [])
        session.close()


if __name__ == "__main__":
    unittest.main()
