import sys

def patch_file():
    with open('web/templates/raid_manage.html', 'r') as f:
        content = f.read()

    old_slot = """                    <div class="assigned-char" data-char-id="{{ c.id }}" data-discord-user-id="{{ s.discord_user_id }}" data-char-class="{{ cls_key }}">
                      <span class="fw-bold cls-{{ cls_key }}">{{ c.char_name }}{% if comp_status_map[slot] == 'tentative' %} [?]{% endif %}</span><br>"""

    new_slot = """                    <div class="assigned-char" data-char-id="{{ c.id }}" data-discord-user-id="{{ s.discord_user_id }}" data-char-class="{{ cls_key }}">
                      <span class="fw-bold cls-{{ cls_key }}">{{ c.char_name }} ({{ s.display_label }}){% if comp_status_map[slot] == 'tentative' %} [?]{% endif %}</span><br>"""

    if old_slot in content:
        content = content.replace(old_slot, new_slot)
    else:
        print("Could not find old_slot")

    with open('web/templates/raid_manage.html', 'w') as f:
        f.write(content)

patch_file()
