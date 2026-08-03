import sys

def patch_file():
    with open('web/routes/raids/index.js', 'r') as f:
        content = f.read()

    # 1. Update query for empty payloads to fetch display names
    old_query = """    const [emptyRows] = await pool.query(
      `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text,
            c.char_name, c.char_class, c.spec, c.gearscore, c.discord_user_id AS char_discord_user_id,
              s.status AS signup_status
       FROM compositions co
       LEFT JOIN characters c ON co.character_id = c.id
       LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
       WHERE co.raid_id = ? AND co.comp_number = ?
       ORDER BY co.role_slot`,"""

    new_query = """    const [emptyRows] = await pool.query(
      `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text,
            c.char_name, c.char_class, c.spec, c.gearscore, c.discord_user_id AS char_discord_user_id,
              s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
       FROM compositions co
       LEFT JOIN characters c ON co.character_id = c.id
       LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
       LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
       WHERE co.raid_id = ? AND co.comp_number = ?
       ORDER BY co.role_slot`,"""

    if old_query in content:
        content = content.replace(old_query, new_query)
    else:
        print("Could not find old_query")

    old_map = """    const emptyEntries = emptyRows.map(r => ({
      role_slot: r.role_slot,
      slot_role: r.slot_role || 'dps',
      character_id: r.character_id ? String(r.character_id) : null,
      placeholder_text: r.placeholder_text || null,
      char_name: r.char_name || null,
      char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
      spec: r.spec || null,
    gearscore: r.gearscore || 0,
      discord_user_id: r.char_discord_user_id ? String(r.char_discord_user_id) : null,
      status: r.signup_status || null,
    }));"""

    new_map = """    const emptyEntries = emptyRows.map(r => ({
      role_slot: r.role_slot,
      slot_role: r.slot_role || 'dps',
      character_id: r.character_id ? String(r.character_id) : null,
      placeholder_text: r.placeholder_text || null,
      char_name: r.char_name || null,
      char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
      spec: r.spec || null,
    gearscore: r.gearscore || 0,
      discord_user_id: r.char_discord_user_id ? String(r.char_discord_user_id) : null,
      display_label: r.du_display_name || r.du_username || null,
      status: r.signup_status || null,
    }));"""

    if old_map in content:
        content = content.replace(old_map, new_map)
    else:
        print("Could not find old_map")

    with open('web/routes/raids/index.js', 'w') as f:
        f.write(content)

patch_file()
