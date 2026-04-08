import requests
from bs4 import BeautifulSoup
import re
from enum import IntEnum
import discord
from table2ascii import table2ascii as t2a, PresetStyle

class Item_Types(IntEnum):
    HEAD = 1
    NECK = 2
    SHOULDER = 3
    BACK = 16
    CHEST = 5
    SHIRT = 4
    TABARD = 19
    WRIST = 9
    GLOVES = 10
    WAIST = 6
    LEGS = 7
    FEET = 8
    RING = 11
    TRINKET = 12
    WEAPON_2H = 17
    WEAPON_1H = 13
    SHIELD = 14
    OFF_HAND = 23
    RELIC = 28
    RANGED = 26


class QueryWarmaneArmory():

    def create_multi_response(*args, conn):
        body = list()
        for character in args:
            #print(character)
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
    def create_onyxia_stalk_response(character,realm, conn):
        profile_html = getHTML(character, realm, "summary")
        if check_for_error(profile_html):
            return error_char_not_found_embed()
        guild = extract_guild_from_profile(profile_html)
        race = extract_class_race_level_from_profile(profile_html)
        profs = extract_professions_from_profile(profile_html)
        specs = extract_specializations_from_profile(profile_html)
        items = extract_items_from_profile(profile_html)
        items_db = get_items_from_db(items, conn)
        talent_html = getHTML(character,realm, "talents")
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
        # Send the embed
        return embed

    @staticmethod
    def test_talents(character, realm):
        getTalentPoints(character, realm)

    @staticmethod
    def create_stalk_response(character,realm, conn):
        profile_html = getHTML(character, realm, "summary")
        if check_for_error(profile_html):
            return error_char_not_found_embed()
        guild = extract_guild_from_profile(profile_html)
        race = extract_class_race_level_from_profile(profile_html)
        profs = extract_professions_from_profile(profile_html)
        specs = extract_specializations_from_profile(profile_html)
        items = extract_items_from_profile(profile_html)
        items_db = get_items_from_db(items, conn)
        talent_html = getHTML(character,realm, "talents")
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
            inline=True)  # Empty field
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="[1] Minor Glyphs", 
            value=f"{format_glyphs(glyphs, 0, 'Minor Glyphs')}", 
            inline=True)  # Empty field
        embed.add_field(
            name="[2] Minor Glyphs", 
            value=f"{format_glyphs(glyphs, 1, 'Minor Glyphs')}",
            inline=True)  # Empty field
        embed.add_field(name="\u200b", value="\u200b")
        embed.add_field(
            name="Link to Armory",
            value=f"[Armory Link](https://armory.warmane.com/character/{character.capitalize()}/{realm.capitalize()}/summary)",
            inline=False,
        )
        # Send the embed
        return embed

def getHTML(character, realm, dataType):
    header = {"User-Agent":"Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"}
    url = f"http://armory.warmane.com/character/{character.capitalize()}/{realm.capitalize()}/{dataType}"
    r = requests.get(url, headers=header)
    if r.status_code != 200:
        return None
    return r.content

def check_for_error(html):
    message = "The character you are looking for does not exist or does not meet the minimum required level."
    parser = BeautifulSoup(html, 'html.parser')
    if message in parser.text:
        return True
    else:
        return False

def extract_items_from_profile(html):
    parser = BeautifulSoup(html, 'html.parser')
    rel_attributes = [tag['rel'] for tag in parser.find_all(attrs={'rel': True})]

    data = []
    for item in rel_attributes: #cleanup pass 1
        if "item" in item[0]:
            data.append(item[0])

    result = {}
    for item in data: #data into dict form for easier handling
        components = item.split("&")
        for component in components:
            if component.startswith("item="):
                item_id = component.split("=")[1]
                result[item_id] = {"enchant": None, "gems": []}
            elif component.startswith("ench="):
                enchant_id = component.split("=")[1]
                result[item_id]["enchant"] = enchant_id
            elif component.startswith("gems="):
                gem_ids = component.split("=")[1].split(":")
                result[item_id]["gems"] = [gem for gem in gem_ids if gem != "0"]
        
    return result

def extract_guild_from_profile(html):
    parser = BeautifulSoup(html, 'html.parser')
    try:
        return parser.find('span', class_='guild-name').a.text
    except AttributeError:
        return ""

def extract_professions_from_profile(html):
    parser = BeautifulSoup(html, 'html.parser')
    prof = parser.find('div', class_='profskills')
    try:
        text_divs = prof.find_all('div', class_='text')
    except AttributeError:
        return ["",""]
    results = []
    for div in text_divs:
        prof_name = div.contents[0].strip()
        prof_value = div.find('span', class_='value').text.strip()  # Span value
        results.append(f"{prof_name} ({prof_value})")
    return results

def extract_specializations_from_profile(html):
    parser = BeautifulSoup(html, 'html.parser')
    spec = parser.find('div', class_='specialization')
    text_divs = spec.find_all('div', class_='text')

    results = []
    for div in text_divs:
        spec_name = div.contents[0].strip()
        try:
            spec_value = div.find('span', class_='value').text.strip()  # Span value
        except AttributeError:
            spec_value = "0 / 0 / 0"
        results.append(f"{spec_name} ({spec_value})")
    return results

def extract_class_race_level_from_profile(html):
    parser = BeautifulSoup(html, 'html.parser')
    data = parser.find("div", class_="level-race-class").text
    result = re.findall(r"(\b[A-Za-z0-9]*[\s{1},])", data)
    result = "".join(result)
    return result[0:result.find(",")]

def extract_glyphs_from_talents(html):
    parser = BeautifulSoup(html, 'html.parser')
    glyph_sections = parser.find_all('div', attrs={'data-glyphs': True})

    glyph_data = {}
    for section in glyph_sections:
        glyph_id = section['data-glyphs']  # e.g., "0", "1"
        glyph_data[glyph_id] = {
            "Major Glyphs": [],
            "Minor Glyphs": []
        }
        
        major_glyphs = section.find_all('div', class_='glyph major')
        for glyph in major_glyphs:
            glyph_name = glyph.find('a').text.strip()
            glyph_data[glyph_id]["Major Glyphs"].append(glyph_name)

        minor_glyphs = section.find_all('div', class_='glyph minor')
        for glyph in minor_glyphs:
            glyph_name = glyph.find('a').text.strip()
            glyph_data[glyph_id]["Minor Glyphs"].append(glyph_name)

    return glyph_data

def error_char_not_found_embed():
    embed = discord.Embed(title=f"Error!", description="", color=discord.Color.red())
    embed.add_field(name="The character you are looking for does not exist or does not meet the minimum required level.!",value="", inline=False)
    return embed

def format_prof_spec(prof_spec):
    return "\n".join([f"[{i + 1}] {profession}" for i, profession in enumerate(prof_spec)])

def format_glyphs(x, id, glyph_type):
    return "\n".join(x[f"{id}"][glyph_type])

def calculate_gearscore(items):
    gearscore = 0
    fix_2h_dw_gs = list()
    dw_2h_gs = 0
    for itemid, value in items.items():
        if value[3] == 4 or value[3] == 19:
            continue
        if value[3] == 17:
            fix_2h_dw_gs.append(int(value[-1]))
            continue
        gearscore += int(value[-1])
        try:
            dw_2h_gs = round(sum(fix_2h_dw_gs) / len(fix_2h_dw_gs), 2)
        except ZeroDivisionError:
            dw_2h_gs = 0
    return gearscore + dw_2h_gs

def calculate_avg_ilvl(items):
    ilvl_total = 0
    count = 0
    for itemid, value in items.items():
        if value[3] == 4 or value[3] == 19:
            continue
        ilvl_total += int(value[1])
        count += 1
    try:
        return round(ilvl_total / count, 2)
    except ZeroDivisionError:
        return "0"

def check_enchants(items, item_db, class_, prof):
    not_enchanted = list()
    for item, value in items.items():
        db_item = item_db[int(item)]
        item_type = db_item[3]
        if item_type == Item_Types.NECK or item_type == Item_Types.SHIRT or item_type == Item_Types.TABARD \
            or item_type == Item_Types.TRINKET or item_type == Item_Types.WAIST:
            continue
        if "Mage" in class_ or "Warlock" in class_ or "Priest" in class_ or "Druid" in class_:
            if item_type == Item_Types.OFF_HAND or item_type == Item_Types.RANGED:
                continue
        if "Druid" in class_ or "Death Knight" in class_ or "Shaman" in class_ or "Paladin" in class_:
            if item_type == Item_Types.RELIC:
                continue
        if "Warrior" in class_ or "Rogue" in class_:
            if item_type == Item_Types.RANGED:
                continue
        if "Enchanting" not in prof:
            if item_type == Item_Types.RING:
                continue
        if value["enchant"] is None:
            not_enchanted.append(item_type)
        
    if len(not_enchanted) == 0:
        return "All items are enchanted!"
    else:
        return missing_enchant_message(not_enchanted)

def missing_enchant_message(missing):
    return_msg = "Enchants missing from: "
    missing_items_str = list()
    ring_counter = 1
    for type_id in missing:
        if type_id == Item_Types.HEAD:
            missing_items_str.append("Head")
        if type_id == Item_Types.SHOULDER:
            missing_items_str.append("Shoulders")
        if type_id == Item_Types.CHEST:
            missing_items_str.append("Chest")
        if type_id == Item_Types.BACK:
            missing_items_str.append("Back")
        if type_id == Item_Types.WRIST:
            missing_items_str.append("Wrist")
        if type_id == Item_Types.GLOVES:
            missing_items_str.append("Hands")
        if type_id == Item_Types.LEGS:
            missing_items_str.append("Legs")
        if type_id == Item_Types.FEET:
            missing_items_str.append("Feet")
        if type_id == Item_Types.RING:
            missing_items_str.append(f"Ring #{ring_counter}")
            ring_counter += 1
        if type_id == Item_Types.WEAPON_1H:
            missing_items_str.append("Weapon")
        if type_id == Item_Types.WEAPON_2H:
            missing_items_str.append("Weapon")
        if type_id == Item_Types.SHIELD:
            missing_items_str.append("Shield")
        if type_id == Item_Types.RANGED:
            missing_items_str.append("Ranged")
    return return_msg + ", ".join(missing_items_str)

def check_gems(items, item_db, profs):
    items_missing_gems = list()
    for item, value in items.items():
        db_item = item_db[int(item)]
        item_type = db_item[3]

        if item_type == Item_Types.WAIST:
            amount_of_gems = db_item[-2] + 1
        else:
            amount_of_gems = db_item[-2]
        
        if len(value['gems']) == amount_of_gems:
            continue
        items_missing_gems.append(item_type)
    if len(items_missing_gems) == 0:
        return "All items are gemmed!"
    else:
        return missing_gems_message(items_missing_gems)

def missing_gems_message(missing):
    return_msg = "Gems missing from: "
    missing_items_str = list()
    ring_counter = 1
    for type_id in missing:
        if type_id == Item_Types.WAIST:
            missing_items_str.append("Belt")
        if type_id == Item_Types.HEAD:
            missing_items_str.append("Head")
        if type_id == Item_Types.NECK:
            missing_items_str.append("Neck")
        if type_id == Item_Types.SHOULDER:
            missing_items_str.append("Shoulders")
        if type_id == Item_Types.CHEST:
            missing_items_str.append("Chest")
        if type_id == Item_Types.BACK:
            missing_items_str.append("Back")
        if type_id == Item_Types.WRIST:
            missing_items_str.append("Wrist")
        if type_id == Item_Types.GLOVES:
            missing_items_str.append("Hands")
        if type_id == Item_Types.LEGS:
            missing_items_str.append("Legs")
        if type_id == Item_Types.FEET:
            missing_items_str.append("Feet")
        if type_id == Item_Types.RING:
            missing_items_str.append(f"Ring #{ring_counter}")
            ring_counter += 1
        if type_id == Item_Types.WEAPON_1H:
            missing_items_str.append("Weapon")
        if type_id == Item_Types.WEAPON_2H:
            missing_items_str.append("Weapon")
        if type_id == Item_Types.SHIELD:
            missing_items_str.append("Shield")
        if type_id == Item_Types.RANGED:
            missing_items_str.append("Ranged")
        if type_id == Item_Types.TRINKET:
            missing_items_str.append("Trinket")

    return return_msg + ", ".join(missing_items_str)

def get_items_from_db(items, conn):
    results = dict()
    for item,_ in items.items():
        cur = conn.cursor()
        cur.execute(
        "SELECT itemID,name,ItemLevel,quality,type,requires,class,subclass,gems,GearScore FROM items WHERE itemID=?", 
        (item,))
        for itemid, name, ilvl, quality, itemtype, requires, class_, sublcass, gems, gs in cur:
            results.update({itemid: [name, ilvl, quality, itemtype, requires, class_, sublcass, gems, gs]})
    return results


def clean_data(lines):
    fixed = list()
    for line in lines:
        line = line.replace("[", "").replace("]", "").replace("'", "")
        line = re.sub(r"\s*\([^)]*\)", "", line)
        fixed.append(line)
    return ", ".join(fixed)

def getTalentPoints(character, realm):
    talent_html = getHTML(character.capitalize(),realm.capitalize(), "talents")
    soup = BeautifulSoup(talent_html, "html.parser")
    containers = soup.find_all("div", class_="talents-container wotlk")

    for container in containers:
        talent_divs = container.find_all("div", class_="talent-points")
        talent_numbers = []
        for div in talent_divs:
            text = div.get_text(strip=True)  # e.g., "0/5"
            allocated = text.split("/")[0]    # e.g., "0"
            talent_numbers.append(allocated)
        talent_string = "".join(talent_numbers)
        print(talent_string)