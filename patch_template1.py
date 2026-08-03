import sys

def patch_file():
    with open('web/templates/raid_manage.html', 'r') as f:
        content = f.read()

    old_attrs = """                   data-char-class="{{ cls_key }}"
                   data-discord-user-id="{{ charGroup.discord_user_id }}"
                   data-spec="{{ firstSpec.spec or '' }}"
                   data-gearscore="{{ firstSpec.gearscore }}"
                   data-sfs-count="{{ charGroup.sfs_count if charGroup.sfs_count != null else '' }}\""""

    new_attrs = """                   data-char-class="{{ cls_key }}"
                   data-discord-user-id="{{ charGroup.discord_user_id }}"
                   data-display-label="{{ userGroup.display_label }}"
                   data-spec="{{ firstSpec.spec or '' }}"
                   data-gearscore="{{ firstSpec.gearscore }}"
                   data-sfs-count="{{ charGroup.sfs_count if charGroup.sfs_count != null else '' }}\""""

    if old_attrs in content:
        content = content.replace(old_attrs, new_attrs)
    else:
        print("Could not find old_attrs")

    with open('web/templates/raid_manage.html', 'w') as f:
        f.write(content)

patch_file()
