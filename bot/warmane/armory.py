import discord
from table2ascii import table2ascii as t2a, PresetStyle

from .scraping import (
    getHTML,
    check_for_error,
    extract_guild_from_profile,
    extract_class_race_level_from_profile,
    extract_items_from_profile,
    extract_professions_from_profile,
    extract_specializations_from_profile,
    extract_glyphs_from_talents,
    error_char_not_found_embed,
    format_prof_spec,
    format_glyphs,
    getTalentPoints,
)
from .calculations import (
    calculate_gearscore,
    calculate_avg_ilvl,
    check_enchants,
    check_gems,
    get_items_from_db,
    clean_data,
)


class QueryWarmaneArmory():

    def create_multi_response(*args, conn):
        body = list()
        for character in args:
            if character.isalpha():
                char_data = list()

                if len(character.split("-")) == 2:
                    character = character.split("-")[0]
                    realm = character.split("-")[1]
                    char_data.append(character)
                    char_data.append(realm)

                    profile_html = getHTML(character, realm, "summary")
                    char_data.append("H")
                    char_data.append(extract_guild_from_profile(profile_html))

                else:
                    realm = "Icecrown"

                    char_data.append(character)
                    char_data.append(realm)

                    profile_html = getHTML(character, realm, "summary")
                    race = extract_class_race_level_from_profile(profile_html)
                    faction = ""
                    if "Blood Elf" in race\
                        or "Orc" in race\
                        or "Tauren" in race\
                        or "Undead" in race\
                        or "Troll" in race:
                        faction = "H"
                    else:
                        faction = "A"
                    items = extract_items_from_profile(profile_html)
                    items_db = get_items_from_db(items, conn)
                    char_data.append(faction)
                    char_data.append(extract_guild_from_profile(profile_html))
                    char_data.append(calculate_gearscore(items_db))
                    char_data.append(clean_data(extract_specializations_from_profile(profile_html)))
                    char_data.append(clean_data(extract_professions_from_profile(profile_html)))
                body.append(char_data)
            output = t2a(
                header=["Character", "Realm", "A/H", "Guild", "Gearscore", "Specialization", "   Professions   "],
                body=body,
                style=PresetStyle.thin_compact
            )
        return f"```\n{output}\n```"

    @staticmethod
    def create_onyxia_stalk_response(character, realm, conn):
        profile_html = getHTML(character, realm, "summary")
        if check_for_error(profile_html):
            return error_char_not_found_embed()
        guild = extract_guild_from_profile(profile_html)
        race = extract_class_race_level_from_profile(profile_html)
        profs = extract_professions_from_profile(profile_html)
        specs = extract_specializations_from_profile(profile_html)
        items = extract_items_from_profile(profile_html)
        items_db = get_items_from_db(items, conn)
        talent_html = getHTML(character, realm, "talents")
        glyphs = extract_glyphs_from_talents(talent_html)
        embed = discord.Embed(
            title=f"Character summary for {character.capitalize()}-{realm.capitalize()}",
            color=discord.Color.blue()
        )
        embed.add_field(name="Level, Race, Class", value=f"{race}", inline=True)
        embed.add_field(name="Guild", value=f"{guild}", inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="Specializations",
            value=f"{format_prof_spec(specs)}",
            inline=True,
        )
        embed.add_field(
            name="Professions",
            value=f"{format_prof_spec(profs)}",
            inline=True,
        )
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(name="GearScore", value=f"{calculate_gearscore(items_db)}", inline=True)
        embed.add_field(name="Average item level", value=f"{calculate_avg_ilvl(items_db)}", inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(name="Enchants", value=f"{check_enchants(items, items_db, race, profs)}", inline=True)
        embed.add_field(name="Gems", value=f"{check_gems(items, items_db, profs)}", inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="Link to Armory",
            value=f"[Armory Link](https://armory.warmane.com/character/{character.capitalize()}/{realm.capitalize()}/summary)",
            inline=False,
        )
        return embed

    @staticmethod
    def test_talents(character, realm):
        getTalentPoints(character, realm)

    @staticmethod
    def create_stalk_response(character, realm, conn):
        profile_html = getHTML(character, realm, "summary")
        if check_for_error(profile_html):
            return error_char_not_found_embed()
        guild = extract_guild_from_profile(profile_html)
        race = extract_class_race_level_from_profile(profile_html)
        profs = extract_professions_from_profile(profile_html)
        specs = extract_specializations_from_profile(profile_html)
        items = extract_items_from_profile(profile_html)
        items_db = get_items_from_db(items, conn)
        talent_html = getHTML(character, realm, "talents")
        glyphs = extract_glyphs_from_talents(talent_html)
        embed = discord.Embed(
            title=f"Character summary for {character.capitalize()}-{realm.capitalize()}",
            color=discord.Color.blue()
        )
        embed.add_field(name="Level, Race, Class", value=f"{race}", inline=True)
        embed.add_field(name="Guild", value=f"{guild}", inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="Specializations",
            value=f"{format_prof_spec(specs)}",
            inline=True,
        )
        embed.add_field(
            name="Professions",
            value=f"{format_prof_spec(profs)}",
            inline=True,
        )
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(name="GearScore", value=f"{calculate_gearscore(items_db)}", inline=True)
        embed.add_field(name="Average item level", value=f"{calculate_avg_ilvl(items_db)}", inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(name="Enchants", value=f"{check_enchants(items, items_db, race, profs)}", inline=True)
        embed.add_field(name="Gems", value=f"{check_gems(items, items_db, profs)}", inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="[1] Major Glyphs",
            value=f"{format_glyphs(glyphs, 0, 'Major Glyphs')}",
            inline=True,
        )
        embed.add_field(
            name="[2] Major Glyphs",
            value=f"{format_glyphs(glyphs, 1, 'Major Glyphs')}",
            inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="[1] Minor Glyphs",
            value=f"{format_glyphs(glyphs, 0, 'Minor Glyphs')}",
            inline=True)
        embed.add_field(
            name="[2] Minor Glyphs",
            value=f"{format_glyphs(glyphs, 1, 'Minor Glyphs')}",
            inline=True)
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="Link to Armory",
            value=f"[Armory Link](https://armory.warmane.com/character/{character.capitalize()}/{realm.capitalize()}/summary)",
            inline=False,
        )
        return embed
