import sys

def patch_file():
    with open('web/routes/raids/index.js', 'r') as f:
        content = f.read()

    old_full_comp = """  const entries = rows.map(r => {
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

    new_full_comp = """  const entries = rows.map(r => ({
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    discord_user_id: r.discord_user_id ? String(r.discord_user_id) : (r.char_discord_user_id ? String(r.char_discord_user_id) : null),
    display_label: (r.du_username && r.du_display_name && r.du_display_name !== r.du_username) ? `${r.du_username} – ${r.du_display_name}` : (r.du_display_name || r.du_username || null),
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

    if old_full_comp in content:
        content = content.replace(old_full_comp, new_full_comp)

    old_full_comp2 = """  const entries = rows.map(r => {
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
    max_updated_at: r.max_updated_at,
  };
  });"""

    new_full_comp2 = """  const entries = rows.map(r => ({
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    discord_user_id: r.discord_user_id ? String(r.discord_user_id) : (r.char_discord_user_id ? String(r.char_discord_user_id) : null),
    display_label: (r.du_username && r.du_display_name && r.du_display_name !== r.du_username) ? `${r.du_username} – ${r.du_display_name}` : (r.du_display_name || r.du_username || null),
    char_name: r.char_name || null,
    char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: r.spec || null,
    gearscore: r.gearscore || 0,
    sfs_count: r.sfs_count,
    val_count: r.val_count,
    is_sfs_collector: !!r.is_sfs_collector,
    is_val_collector: !!r.is_val_collector,
    status: r.signup_status || null,
    max_updated_at: r.max_updated_at,
  }));"""

    if old_full_comp2 in content:
        content = content.replace(old_full_comp2, new_full_comp2)

    with open('web/routes/raids/index.js', 'w') as f:
        f.write(content)

patch_file()
