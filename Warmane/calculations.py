from .item_types import Item_Types


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
    for item, _ in items.items():
        cur = conn.cursor()
        cur.execute(
            "SELECT itemID,name,ItemLevel,quality,type,requires,class,subclass,gems,GearScore FROM items WHERE itemID=?",
            (item,))
        for itemid, name, ilvl, quality, itemtype, requires, class_, sublcass, gems, gs in cur:
            results.update({itemid: [name, ilvl, quality, itemtype, requires, class_, sublcass, gems, gs]})
    return results


def clean_data(lines):
    import re
    fixed = list()
    for line in lines:
        line = line.replace("[", "").replace("]", "").replace("'", "")
        line = re.sub(r"\s*\([^)]*\)", "", line)
        fixed.append(line)
    return ", ".join(fixed)
