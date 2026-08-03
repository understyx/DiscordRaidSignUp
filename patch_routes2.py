import sys

def patch_file():
    with open('web/routes/raids/index.js', 'r') as f:
        content = f.read()

    # The review pointed out that I failed to update the API responses for the composition endpoints (like emptyEntries and full composition fetch).
    # I did update emptyEntries, but missed the others in patch_routes2.py

    # Update full current composition fetch at lines 1357-1393
    old_full_comp_map = """  const entries = rows.map(r => ({
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    discord_user_id: r.discord_user_id ? String(r.discord_user_id) : (r.char_discord_user_id ? String(r.char_discord_user_id) : null),
    display_label: r.du_display_name || r.du_username || null,
    char_name: r.char_name || null,
    char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: r.spec || null,
    gearscore: r.gearscore || 0,
    sfs_count: r.sfs_count,
    val_count: r.val_count,
    is_sfs_collector: !!r.is_sfs_collector,
    is_val_collector: !!r.is_val_collector,
    status: r.signup_status || null,
  }));"""

    new_full_comp_map = """  const entries = rows.map(r => {
    let label = r.du_display_name || r.du_username || null;
    if (r.du_username && r.du_display_name && r.du_display_name !== r.du_username) {
        label = `${r.du_username} – ${r.du_display_name}`;
    }
    return {
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    discord_user_id: r.discord_user_id ? String(r.discord_user_id) : (r.char_discord_user_id ? String(r.char_discord_user_id) : null),
    display_label: label,
    char_name: r.char_name || null,
    char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: r.spec || null,
    gearscore: r.gearscore || 0,
    sfs_count: r.sfs_count,
    val_count: r.val_count,
    is_sfs_collector: !!r.is_sfs_collector,
    is_val_collector: !!r.is_val_collector,
    status: r.signup_status || null,
  };
  });"""

    if old_full_comp_map in content:
        content = content.replace(old_full_comp_map, new_full_comp_map)
    else:
        print("Could not find old_full_comp_map")

    # Same mapping logic needed for other occurrences
    # Wait, let's just do a search and replace for all instances where `display_label: r.du_display_name || r.du_username || null` exists
    # Or `display_label: comp.du_display_name || comp.du_username || null`

    # Let's write a generic replacer for all these map blocks in web/routes/raids/index.js

    # We want to replace this logic across all mapping blocks:
    # 1. emptyEntries (already modified, let's fix the consistency)
    content = content.replace("display_label: r.du_display_name || r.du_username || null,", "display_label: (r.du_username && r.du_display_name && r.du_display_name !== r.du_username) ? `${r.du_username} – ${r.du_display_name}` : (r.du_display_name || r.du_username || null),")

    content = content.replace("display_label: comp.du_display_name || comp.du_username || null,", "display_label: (comp.du_username && comp.du_display_name && comp.du_display_name !== comp.du_username) ? `${comp.du_username} – ${comp.du_display_name}` : (comp.du_display_name || comp.du_username || null),")

    # Also fix the initial page load placeholders in get /:raid_number/manage
    old_placeholder = """      let displayLabel = c.du_display_name || c.du_username || String(c.discord_user_id);"""
    new_placeholder = """      let displayLabel = (c.du_username && c.du_display_name && c.du_display_name !== c.du_username) ? `${c.du_username} – ${c.du_display_name}` : (c.du_display_name || c.du_username || String(c.discord_user_id));"""

    if old_placeholder in content:
        content = content.replace(old_placeholder, new_placeholder)

    with open('web/routes/raids/index.js', 'w') as f:
        f.write(content)

patch_file()
