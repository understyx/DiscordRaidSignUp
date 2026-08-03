import sys

def patch_file():
    with open('web/routes/raids/index.js', 'r') as f:
        content = f.read()

    # 1. Update signups map
    old_signups = """  const signups = allSignups.map(s => ({
    ...s,"""

    new_signups = """  const signups = allSignups.map(s => {
    let label;
    const uid = String(s.discord_user_id);
    if (s.du_username && s.du_display_name && s.du_display_name !== s.du_username) {
      label = `${s.du_username} \u2013 ${s.du_display_name}`;
    } else if (s.du_username) {
      label = s.du_username;
    } else {
      label = uid;
    }
    return {
      ...s,
      display_label: label,"""

    if old_signups in content:
        content = content.replace(old_signups, new_signups)
        # Fix the end of the map function
        content = content.replace("""        val_count: s.val_count,
    },
  }));""", """        val_count: s.val_count,
    },
  };
  });""")
    else:
        print("Could not find old_signups")

    with open('web/routes/raids/index.js', 'w') as f:
        f.write(content)

patch_file()
