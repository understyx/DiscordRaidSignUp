const display_data = { tank: 0, heal: 0, melee: 0, range: 0, players: 0, conqueror: 0, protector: 0, vanquisher: 0, plate: 0, mail: 0, leather: 0, cloth: 0, raid_buff_01: 0, raid_buff_02: 0, raid_buff_03: 0, raid_buff_04: 0, raid_buff_05: 0, raid_buff_06: 0, raid_buff_07: 0, raid_buff_08: 0, raid_buff_09: 0, raid_buff_10: 0, raid_buff_11: 0, raid_buff_12: 0, raid_buff_13: 0, raid_buff_14: 0, raid_buff_15: 0, raid_buff_16: 0, raid_buff_17: 0, raid_buff_18: 0, single_player_01: 0, single_player_02: 0, single_player_03: 0, single_player_04: 0, raid_damage_reduction_01: 0, offensive_dispel_01: 0, offensive_dispel_02: 0, offensive_debuff_01: 0, offensive_debuff_02: 0, offensive_debuff_03: 0, offensive_debuff_04: 0, offensive_debuff_05: 0, offensive_debuff_06: 0, reduction_debuff_01: 0, reduction_debuff_02: 0, reduction_debuff_03: 0, reduction_debuff_04: 0, reduction_debuff_05: 0, reduction_debuff_06: 0, resource_return_01: 0, resource_return_02: 0, resource_return_03: 0, resource_return_04: 0, resource_return_05: 0, resource_return_06: 0, resource_return_07: 0, resource_return_08: 0, health_return_01: 0, health_return_02: 0, health_return_03: 0, defensive_dispel_01: 0, defensive_dispel_02: 0, defensive_dispel_03: 0, defensive_dispel_04: 0 };// prettier-ignore
const comp_data = new Array(3)
window.addEventListener('load', function () {
    GetUrlString()
})
// const main = document.querySelector('#main-container > main');
const popout_about = document.getElementById('popout-about');
const hover_tooltip = document.getElementById('hover-tooltip');
document.getElementById('close_popout-about').addEventListener("click", e => CloseAbout(e))
document.getElementById('btn_clear-all').addEventListener("click", e => ClearDisplayData())
document.getElementById('btn_save-image').addEventListener("click", e => BtnSaveImage())
document.getElementById('btn_about').addEventListener("click", e => BtnAbout())
document.getElementById('btn_copy-link').addEventListener("click", e => SetUrl(e, comp_data[2]))
document.getElementById('dropdown-btn-cata').addEventListener("click", e => window.location.assign("https://wowraidcomp.com/cata"))
document.getElementById('dropdown-btn-mop').addEventListener("click", e => window.location.assign("https://wowraidcomp.com/mop"))
document.getElementById('dropdown-btn-tbc').addEventListener("click", e => window.location.assign("https://wowraidcomp.com/tbc"));
document.getElementById('dropdown-btn-tbc2').addEventListener("click", e => window.location.assign("https://wowraidcomp.com/tbc"));
document.getElementById('dropdown-btn-pv').addEventListener("click", e => window.location.assign("https://wowraidcomp.com/pv"));
document.getElementById('dropdown-btn-main').addEventListener("click", e => DropDownMain())
document.getElementById('dropdown-container').addEventListener("mouseleave", e => DropDownMouseLeave())
const table_drag = Array.from(document.querySelectorAll('.selecting-table td')).filter(item => item.classList.contains("selecting-td"));
// drag table - drag start
table_drag.forEach(item => item.addEventListener("dragstart", e => {
    e.dataTransfer.effectAllowed = "all";
    e.dataTransfer.setData("text/plain", e.target.dataset.spec);
    // e.preventDefault()
}))
// drag end table
table_drag.forEach(item => item.addEventListener("dragend", e => {
    CreateMainDatabase()
}))
// drag-over
document.querySelectorAll('.panel').forEach(item => item.addEventListener("dragover", e => {
    e.preventDefault()
    e.dataTransfer.effectAllowed = "all";
    e.dataTransfer.dropEffect = "copy";
}))
//  data-party drag Start
const data_party = Array.from(document.querySelectorAll('[data-party]'))
data_party.forEach(item => item.addEventListener("dragstart", e => {
    e.dataTransfer.effectAllowed = "all";
    e.dataTransfer.setData("text/plain", e.target.dataset.spec)
    // e.preventDefault()
}))
// data-party drop_zone
data_party.forEach(item => item.addEventListener("drop", e => {
    e.preventDefault()
    comp_data[1] = e.target.dataset.spec
    SetSpec(e.dataTransfer.getData("text/plain", e.target.dataset.spec), e.target);
    // CreateMainDatabase()
}))
// drag_end  LAST data-party
data_party.forEach(item => item.addEventListener("dragend", e => {
    comp_data[0] ? SetSpec(comp_data[1], document.getElementById(e.target.id)) : ClearParty(e.target);
    CreateMainDatabase()
}))
// click event
table_drag.forEach(item => item.addEventListener("click", e => {
    e.preventDefault()
    const click = Array.from(document.querySelectorAll('[data-party]'))
    for (const item of click) {
        if (item.classList.contains("party-default")) {
            SetSpec(e.target.dataset.spec, item)
            CreateMainDatabase()
            break;
        }
    }
}))
// enter-drop_zone data-party
data_party.forEach(item => item.addEventListener("dragenter", e => {
    e.preventDefault()
    comp_data[0] = e.target.hasAttribute("draggable")
    e.target.classList.remove("party-default")
    e.target.classList.add("class-hover")
}))
// leave-drop_zone data-party
data_party.forEach(item => item.addEventListener("dragleave", e => {
    e.preventDefault()
    e.target.classList.remove("class-hover")
    e.target.classList.add("party-default")
}))
//double_click data-party
data_party.forEach(item => item.addEventListener("dblclick", e => {
    e.target.removeAttribute("class")
    e.target.removeAttribute("draggable")
    e.target.classList.add("party-default")
    e.target.textContent = ""
    e.target.dataset.spec = ""
    CreateMainDatabase()
}))
//
function GetUrlString() {
    if (window.location.search !== "") {
        let url = window.location.search.slice(1)
        for (let i = 0; i < url.length; i += 4) {
            SetSpec(url.substring(i + 2, i + 4), document.getElementById(url.substring(i, i + 2)))
        }
        CreateMainDatabase()
    }
}
function BtnSaveImage() {
    html2canvas(document.getElementById("main-grid-area")).then(function (canvas) {
        let image = canvas.toDataURL("image/png").replace("image/png", "image/octet-stream");
        let save = document.createElement("a");
        save.href = image;
        save.download = "wow_raid_comp.png";
        document.body.appendChild(save);
        save.click();
    });
}
function BtnAbout() {
    popout_about.removeAttribute("hidden")
}
function CloseAbout(e) {
    e.target.parentElement.setAttribute("hidden", true)
}
function DropDownMain(e) {
    document.getElementById('dropdown-items').toggleAttribute("hidden")
}
function DropDownMouseLeave(e) {
    document.getElementById('dropdown-items').setAttribute("hidden", true)
}
//
function ClearDisplayData() {
    for (const key in display_data) {
        document.getElementById(key).textContent = 0;
        display_data[key] = 0;
    }
    document.querySelectorAll('.buff-selected').forEach(item => item.classList.replace("buff-selected", "buff-text"))
    document.querySelectorAll('.number-selected').forEach(item => item.classList.replace("number-selected", "buff-number"))
    document.querySelectorAll('[data-party]').forEach(item => {
        item.removeAttribute("class")
        item.removeAttribute("draggable")
        item.classList.add("party-default")
        item.textContent = ""
        item.dataset.spec = ""
    })
    window.history.replaceState(null, null, `${window.location.origin}${window.location.pathname}`);
}
function ClearParty(target) {
    target.removeAttribute("class")
    target.removeAttribute("draggable")
    target.classList.add("party-default")
    target.textContent = ""
    target.dataset.spec = ""
    CreateMainDatabase()
}
function CreateMainDatabase() {
    comp_data[2] = ""
    for (const key in display_data) {
        document.getElementById(key).textContent = 0;
        display_data[key] = 0;
    }
    document.querySelectorAll('.buff-selected').forEach(item => item.classList.replace("buff-selected", "buff-text"))
    document.querySelectorAll('.number-selected').forEach(item => item.classList.replace("number-selected", "buff-number"))
    const database = Array.from(document.querySelectorAll('[data-party]')).filter(item => item.hasAttribute("draggable")) // part data
    for (const item of database) {
        SetDisplay(item.dataset.spec);
        comp_data[2] += item.id + item.dataset.spec;
    }
}
function SetUrl(e, string) {
    e.target.textContent = "Copied"
    setTimeout(function () {
        e.target.textContent = "Copy Link"
    }, 400)
    let text = document.createElement("textarea");
    document.body.appendChild(text);
    text.value = `${window.location.origin}${window.location.pathname}?${string}`
    text.select();
    navigator.clipboard.writeText(text.value);
    document.body.removeChild(text);
}
function SetupSpec(target, number, classlist, text) {
    target.removeAttribute("class")
    target.setAttribute("draggable", true);
    target.classList.add(classlist)
    target.textContent = text
    target.dataset.spec = number
}
function SetSpec(number, target) {
    switch (number) {
        case "01":
            SetupSpec(target, number, "class-druid", "Balance")
            console.log(target);
            break;
        case "02":
            SetupSpec(target, number, "class-druid", "Feral (Bear)")
            break;
        case "03":
            SetupSpec(target, number, "class-druid", "Feral (Cat)")
            break;
        case "04":
            SetupSpec(target, number, "class-druid", "Restoration")
            break;
        case "05":
            SetupSpec(target, number, "class-hunter", "Beast Mastery")
            break;
        case "06":
            SetupSpec(target, number, "class-hunter", "Marksmanship")
            break;
        case "07":
            SetupSpec(target, number, "class-hunter", "Survival")
            break;
        case "08":
            SetupSpec(target, number, "class-mage", "Arcane")
            break;
        case "09":
            SetupSpec(target, number, "class-mage", "Fire")
            break;
        case "10":
            SetupSpec(target, number, "class-mage", "Frost")
            break;
        case "11":
            SetupSpec(target, number, "class-paladin", "Holy")
            break;
        case "12":
            SetupSpec(target, number, "class-paladin", "Protection")
            break;
        case "13":
            SetupSpec(target, number, "class-paladin", "Retribution")
            break;
        case "14":
            SetupSpec(target, number, "class-priest", "Discipline")
            break;
        case "15":
            SetupSpec(target, number, "class-priest", "Holy")
            break;
        case "16":
            SetupSpec(target, number, "class-priest", "Shadow")
            break;
        case "17":
            SetupSpec(target, number, "class-rogue", "Assassination")
            break;
        case "18":
            SetupSpec(target, number, "class-rogue", "Combat")
            break;
        case "19":
            SetupSpec(target, number, "class-rogue", "Subtlety")
            break;
        case "20":
            SetupSpec(target, number, "class-shaman", "Elemental")
            break;
        case "21":
            SetupSpec(target, number, "class-shaman", "Enhancement")
            break;
        case "22":
            SetupSpec(target, number, "class-shaman", "Restoration")
            break;
        case "23":
            SetupSpec(target, number, "class-warlock", "Affliction")
            break;
        case "24":
            SetupSpec(target, number, "class-warlock", "Demonology")
            break;
        case "25":
            SetupSpec(target, number, "class-warlock", "Destruction")
            break;
        case "26":
            SetupSpec(target, number, "class-warrior", "Arms")
            break;
        case "27": //
            SetupSpec(target, number, "class-warrior", "Fury")
            break;
        case "28"://
            SetupSpec(target, number, "class-warrior", "Protection")
            break;
        case "29": //
            SetupSpec(target, number, "class-dk", "Blood")
            break;
        case "30":
            SetupSpec(target, number, "class-dk", "Frost")
            break;
        case "31": //
            SetupSpec(target, number, "class-dk", "Unholy")
            break;
        case "32": //
            SetupSpec(target, number, "class-tank", "Tank")
            break;
        case "33":
            SetupSpec(target, number, "class-heal", "Heal")
            break;
        case "34": // Range Dps
            SetupSpec(target, number, "class-dps", "Range")
            break;
        case "35":// melee Dps   
            SetupSpec(target, number, "class-dps", "Melee")
            break;
        default:
            target.removeAttribute("class")
            target.removeAttribute("draggable")
            target.classList.add("party-default")
            target.textContent = ""
            target.dataset.spec = ""
            break;
    }
}
function SetupDisplay(array) {
    array.forEach(item => {
        display_data[item] += 1
        document.getElementById(item).textContent = display_data[item]
    })
    array.splice(0, 4)
    array.forEach(item => document.getElementById(item).classList.replace("buff-number", "number-selected"))
    array.forEach(item => document.getElementById(item).nextElementSibling.classList.replace("buff-text", "buff-selected"))
}
function SetDisplay(number) {
    switch (number) {
        case "01": // Balance
            SetupDisplay(["range", "players", "vanquisher", "leather", "raid_buff_01", "raid_buff_10", "raid_buff_14", "offensive_debuff_05", "offensive_debuff_06", "reduction_debuff_05", "resource_return_08", "defensive_dispel_02", "defensive_dispel_04", "reduction_debuff_02"])
            break;
        case "02": //Feral (Bear)
            SetupDisplay(["tank", "players", "vanquisher", "leather", "raid_buff_01", "raid_buff_07", "offensive_debuff_01", "reduction_debuff_02", "reduction_debuff_03", "reduction_debuff_04", "resource_return_08", "health_return_01", "defensive_dispel_02", "defensive_dispel_04"])
            break;
        case "03": //Feral (Cat)
            SetupDisplay(["melee", "players", "vanquisher", "leather", "raid_buff_01", "raid_buff_07", "offensive_debuff_01", "reduction_debuff_02", "reduction_debuff_03", "reduction_debuff_04", "resource_return_08", "health_return_01", "defensive_dispel_02", "defensive_dispel_04"])
            break;
        case "04": //Restoration
            SetupDisplay(["heal", "players", "vanquisher", "leather", "raid_buff_01", "resource_return_07", "resource_return_08", "defensive_dispel_02", "defensive_dispel_04", "reduction_debuff_02"])
            break;
        case "05": //Beast Mastery
            SetupDisplay(["range", "players", "protector", "mail", "raid_buff_09", "offensive_dispel_01", "offensive_dispel_02", "offensive_debuff_01", "reduction_debuff_01", "reduction_debuff_02", "reduction_debuff_05"])
            break;
        case "06": // Marksmanship
            SetupDisplay(["range", "players", "protector", "mail", "raid_buff_06", "offensive_dispel_01", "offensive_dispel_02", "reduction_debuff_02", "reduction_debuff_05"])
            break;
        case "07":// Survival
            SetupDisplay(["range", "players", "protector", "mail", "offensive_dispel_01", "offensive_dispel_02", "reduction_debuff_02", "reduction_debuff_05", "resource_return_02"])
            break;
        case "08": // Arcane
            SetupDisplay(["range", "players", "vanquisher", "cloth", "raid_buff_09", "raid_buff_12", "single_player_01", "offensive_dispel_01", "defensive_dispel_02"])
            break;
        case "09": // Fire
            SetupDisplay(["range", "players", "vanquisher", "cloth", "raid_buff_12", "single_player_01", "offensive_dispel_01", "offensive_debuff_04", "defensive_dispel_02"])
            break;
        case "10": // Frost
            SetupDisplay(["range", "players", "vanquisher", "cloth", "raid_buff_12", "offensive_dispel_01", "offensive_debuff_04", "resource_return_02", "defensive_dispel_02"])
            break;
        case "11": // Holy
            SetupDisplay(["heal", "players", "conqueror", "plate", "raid_buff_02", "raid_buff_05", "resource_return_01", "resource_return_03", "health_return_02", "defensive_dispel_01", "defensive_dispel_03", "defensive_dispel_04"])
            break;
        case "12": // Protection
            SetupDisplay(["tank", "players", "conqueror", "plate", "raid_buff_02", "raid_buff_03", "raid_buff_05", "raid_damage_reduction_01", "reduction_debuff_03", "resource_return_01", "resource_return_03", "health_return_02", "defensive_dispel_01", "defensive_dispel_03", "defensive_dispel_04"])
            break;
        case "13": // Retribution 
            SetupDisplay(["melee", "players", "conqueror", "plate", "raid_buff_02", "raid_buff_05", "raid_buff_09", "raid_buff_10", "offensive_debuff_03", "reduction_debuff_04", "resource_return_01", "resource_return_02", "resource_return_03", "health_return_02", "defensive_dispel_01", "defensive_dispel_03", "defensive_dispel_04"])
            break;
        case "14": // Discipline
            SetupDisplay(["heal", "players", "conqueror", "cloth", "raid_buff_16", "raid_buff_17", "single_player_04", "offensive_dispel_01", "resource_return_05", "resource_return_06", "defensive_dispel_01", "defensive_dispel_03"])
            break;
        case "15": // Holy
            SetupDisplay(["heal", "players", "conqueror", "cloth", "raid_buff_16", "raid_buff_17", "offensive_dispel_01", "resource_return_05", "defensive_dispel_01", "defensive_dispel_03"])
            break;
        case "16": // Shadow 
            SetupDisplay(["range", "players", "conqueror", "cloth", "raid_buff_16", "raid_buff_17", "offensive_dispel_01", "offensive_debuff_05", "resource_return_02", "resource_return_05", "health_return_03", "defensive_dispel_01", "defensive_dispel_03"])
            break;
        case "17": // Assassination
            SetupDisplay(["melee", "players", "vanquisher", "leather", "single_player_03", "offensive_dispel_02", "offensive_debuff_03", "reduction_debuff_01"])
            break;
        case "18": // Combat 
            SetupDisplay(["melee", "players", "vanquisher", "leather", "single_player_03", "offensive_dispel_02", "offensive_debuff_02", "reduction_debuff_01"])
            break;
        case "19": // Subtlety 
            SetupDisplay(["melee", "players", "vanquisher", "leather", "single_player_03", "offensive_dispel_02", "reduction_debuff_01"])
            break;
        case "20": // Elemental
            SetupDisplay(["range", "players", "protector", "mail", "raid_buff_04", "raid_buff_11", "raid_buff_13", "raid_buff_14", "raid_buff_15", "offensive_dispel_01", "offensive_debuff_03", "resource_return_03", "defensive_dispel_03", "defensive_dispel_04"])
            break;
        case "21": // Enhancement
            SetupDisplay(["melee", "players", "protector", "mail", "raid_buff_04", "raid_buff_06", "raid_buff_08", "raid_buff_11", "raid_buff_13", "raid_buff_15", "offensive_dispel_01", "resource_return_03", "defensive_dispel_03", "defensive_dispel_04"])
            break;
        case "22": // Restoration
            SetupDisplay(["heal", "players", "protector", "mail", "raid_buff_04", "raid_buff_11", "raid_buff_13", "raid_buff_15", "offensive_dispel_01", "resource_return_03", "resource_return_04", "defensive_dispel_02", "defensive_dispel_03", "defensive_dispel_04"])
            break;
        case "23": // Affliction 
            SetupDisplay(["range", "players", "conqueror", "cloth", "raid_buff_12", "raid_buff_16", "offensive_debuff_04", "offensive_debuff_06", "reduction_debuff_02", "reduction_debuff_04"])
            break;
        case "24": // Demonology
            SetupDisplay(["range", "players", "conqueror", "cloth", "raid_buff_13", "offensive_debuff_04", "offensive_debuff_06", "reduction_debuff_02", "reduction_debuff_04"])
            break;
        case "25": // Destruction 
            SetupDisplay(["range", "players", "conqueror", "cloth", "raid_buff_18", "offensive_debuff_06", "reduction_debuff_02", "reduction_debuff_04", "resource_return_02"])
            break;
        case "26": // Arms
            SetupDisplay(["melee", "players", "protector", "plate", "raid_buff_05", "raid_buff_18", "offensive_debuff_01", "offensive_debuff_02", "reduction_debuff_01", "reduction_debuff_03", "reduction_debuff_04"])
            break;
        case "27": // Fury
            SetupDisplay(["melee", "players", "protector", "plate", "raid_buff_05", "raid_buff_07", "raid_buff_18", "reduction_debuff_01", "reduction_debuff_03", "reduction_debuff_04"])
            break;
        case "28":// Protection
            SetupDisplay(["tank", "players", "protector", "plate", "raid_buff_05", "raid_buff_18", "offensive_dispel_01", "reduction_debuff_01", "reduction_debuff_03", "reduction_debuff_04"])
            break;
        case "29": // Blood 
            SetupDisplay(["tank", "players", "vanquisher", "plate", "raid_buff_04", "raid_buff_06", "raid_buff_08", "single_player_02", "reduction_debuff_03"])
            break;
        case "30": // Frost
            SetupDisplay(["melee", "players", "vanquisher", "plate", "raid_buff_04", "raid_buff_08", "reduction_debuff_03"])
            break;
        case "31": // Unholy 
            SetupDisplay(["melee", "players", "vanquisher", "plate", "raid_buff_04", "offensive_debuff_06"])
            break;
        case "32": // Tank
            display_data.tank += 1
            display_data.players += 1
            document.getElementById("tank").textContent = display_data.tank
            document.getElementById("players").textContent = display_data.players
            break;
        case "33": // Heal 
            display_data.heal += 1
            display_data.players += 1
            document.getElementById("heal").textContent = display_data.heal
            document.getElementById("players").textContent = display_data.players
            break;
        case "34": // Range Dps
            display_data.range += 1
            display_data.players += 1
            document.getElementById("range").textContent = display_data.range
            document.getElementById("players").textContent = display_data.players
            break;
        case "35":// Melee Dps
            display_data.melee += 1
            display_data.players += 1
            document.getElementById("melee").textContent = display_data.melee
            document.getElementById("players").textContent = display_data.players
            break;
        default:
            break;
    }
}
