import sys

def patch_file():
    with open('web/static/js/raid_manage.js', 'r') as f:
        content = f.read()

    # 1. onDragStart logic
    old_drag = """  draggedCharId           = event.currentTarget.dataset.charId;
  draggedCharName         = event.currentTarget.dataset.charName;
  draggedCharClass        = event.currentTarget.dataset.charClass || null;
  draggedDiscordUserId    = event.currentTarget.dataset.discordUserId || null;"""

    new_drag = """  draggedCharId           = event.currentTarget.dataset.charId;
  draggedCharName         = event.currentTarget.dataset.charName;
  draggedCharClass        = event.currentTarget.dataset.charClass || null;
  draggedDiscordUserId    = event.currentTarget.dataset.discordUserId || null;
  draggedDisplayLabel     = event.currentTarget.dataset.displayLabel || null;"""

    if old_drag in content:
        content = content.replace(old_drag, new_drag)
    else:
        print("Could not find old_drag")

    # 2. char drop logic
    old_drop = """  nameSpan.textContent = draggedCharName + (isTentative ? ' [?]' : '');
  const specSmall = document.createElement('small');
  specSmall.className   = 'text-muted d-block';
  specSmall.textContent = `${draggedSpec || '?'} ${formatGearscore(draggedGearscore)}`;"""

    new_drop = """  nameSpan.textContent = draggedCharName + (draggedDisplayLabel ? ` (${draggedDisplayLabel})` : '') + (isTentative ? ' [?]' : '');
  const specSmall = document.createElement('small');
  specSmall.className   = 'text-muted d-block';
  specSmall.textContent = `${draggedSpec || '?'} ${formatGearscore(draggedGearscore)}`;"""

    if old_drop in content:
        content = content.replace(old_drop, new_drop)
    else:
        print("Could not find old_drop")

    # 3. sync logic (remote character update)
    old_sync = """          nameSpan.textContent = (remote.char_name || '?') + (remoteIsTentative ? ' [?]' : '');
          const specSmall = document.createElement('small');
          specSmall.className   = 'text-muted d-block';
          specSmall.textContent = `${remote.spec || '?'} ${formatGearscore(remote.gearscore)}`;"""

    new_sync = """          nameSpan.textContent = (remote.char_name || '?') + (remote.display_label ? ` (${remote.display_label})` : '') + (remoteIsTentative ? ' [?]' : '');
          const specSmall = document.createElement('small');
          specSmall.className   = 'text-muted d-block';
          specSmall.textContent = `${remote.spec || '?'} ${formatGearscore(remote.gearscore)}`;"""

    if old_sync in content:
        content = content.replace(old_sync, new_sync)
    else:
        print("Could not find old_sync")

    with open('web/static/js/raid_manage.js', 'w') as f:
        f.write(content)

patch_file()
