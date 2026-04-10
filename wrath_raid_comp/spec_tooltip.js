document.querySelector('.selecting-table').addEventListener("contextmenu", e => e.preventDefault())
const tooltip_item = Array.from(document.querySelectorAll('.selecting-table td')).filter(item => item.classList.contains("selecting-td"));
const tooltip_container = document.getElementById('spec-tooltip-container');
tooltip_item.forEach(item => item.addEventListener("contextmenu", e => {
    e.preventDefault()
    tooltip_container.innerHTML = SetupHoverTooltip(e.target)
    tooltip_container.toggleAttribute("hidden");
    tooltip_container.firstElementChild.style.left = `${e.target.getBoundingClientRect().left + e.target.getBoundingClientRect().width + 4}px`
    if (e.target.getBoundingClientRect().top <= 550) tooltip_container.firstElementChild.style.top = `${e.target.getBoundingClientRect().top}px`;
    else tooltip_container.firstElementChild.style.top = `${e.target.getBoundingClientRect().bottom - tooltip_container.firstElementChild.getBoundingClientRect().height}px`;
    // console.log();
}))
// const button_tiny = document.getElementById("button-tiny")
tooltip_container.addEventListener("click", e => {
    if (e.target == tooltip_container.children[0].children[0].children[1]) tooltip_container.toggleAttribute("hidden");
})
const party_data_tooltip = Array.from(document.querySelectorAll('[data-party]'))
party_data_tooltip.forEach(item => item.addEventListener("contextmenu", e => {
    e.preventDefault()
    if (!e.target.classList.contains("party-default")) {
        if (e.target.parentElement.classList.contains("group-box2") || e.target.parentElement.classList.contains("group-box4")) {
            //
            tooltip_container.innerHTML = SetupHoverTooltip(e.target)
            tooltip_container.toggleAttribute("hidden");
            //
            tooltip_container.firstElementChild.style.left = `${e.target.getBoundingClientRect().left + e.target.getBoundingClientRect().width + 4}px`
            tooltip_container.firstElementChild.style.top = `${e.target.getBoundingClientRect().top}px`;
        } else {
            //
            tooltip_container.innerHTML = SetupHoverTooltip(e.target)
            tooltip_container.toggleAttribute("hidden");
            //
            tooltip_container.firstElementChild.style.left = `${e.target.getBoundingClientRect().left - tooltip_container.firstElementChild.getBoundingClientRect().width - 4}px`
            //
            if (e.target.getBoundingClientRect().top <= 500) tooltip_container.firstElementChild.style.top = `${e.target.getBoundingClientRect().top}px`;
            else tooltip_container.firstElementChild.style.top = `${e.target.getBoundingClientRect().bottom - tooltip_container.firstElementChild.getBoundingClientRect().height - 8}px`;
        }
    }
}))
//
function SetupHoverTooltip(target) {
    // -do this the correct way in the future...
    switch (target.dataset.spec) {
        case "01":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-druid">
                <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/GiftoftheWild.jpg" alt="">
                <p>Gift of the Wild</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ImprovedMoonkinForm.jpg" alt="">
                <p>Improved Moonkin Form</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/MoonkinAura.jpg" alt="">
                <p>Moonkin Aura</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FaerieFire.jpg" alt="">
                <p>Improved Faerie Fire</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/EarthandMoon.jpg" alt="">
                <p>Earth and Moon</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/InsectSwarm.jpg" alt="">
                <p>Insect Swarm</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Innervate.jpg" alt="">
                <p>Innervate</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/RemoveCurseDruid.jpg" alt="">
                <p>Remove Curse</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AbolishPoison.jpg" alt="">
                <p>Abolish Poison</p>
            </li>
        </ul>`;
        case "02":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-druid">
                <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/GiftoftheWild.jpg" alt="">
                <p>Gift of the Wild</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/LeaderofthePack.jpg" alt="">
                <p>Leader of the Pack</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Mangle.jpg" alt="">
                <p>Mangle</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FaerieFire.jpg" alt="">
                <p>Faerie Fire</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/InfectedWounds.jpg" alt="">
                <p>Infected Wounds</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DemoralizingRoar.jpg" alt="">
                <p>Demoralizing Roar</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Innervate.jpg" alt="">
                <p>Innervate</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/LeaderofthePack.jpg" alt="">
                <p>Imp Leader of the Pack</p>
        </li>
        <li class="select-tooltip-flex">
            <img src="/wrath/imgtip/RemoveCurseDruid.jpg" alt="">
            <p>Remove Curse</p>
        </li>
        <li class="select-tooltip-flex">
            <img src="/wrath/imgtip/AbolishPoison.jpg" alt="">
            <p>Abolish Poison</p>
        </li>
        </ul>`;
        case "03":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-druid">
                <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/GiftoftheWild.jpg" alt="">
                <p>Gift of the Wild</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/LeaderofthePack.jpg" alt="">
                <p>Leader of the Pack</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Mangle.jpg" alt="">
                <p>Mangle</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FaerieFire.jpg" alt="">
                <p>Faerie Fire</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/InfectedWounds.jpg" alt="">
                <p>Infected Wounds</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DemoralizingRoar.jpg" alt="">
                <p>Demoralizing Roar</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Innervate.jpg" alt="">
                <p>Innervate</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/LeaderofthePack.jpg" alt="">
                <p>Imp Leader of the Pack</p>
        </li>
        <li class="select-tooltip-flex">
            <img src="/wrath/imgtip/RemoveCurseDruid.jpg" alt="">
            <p>Remove Curse</p>
        </li>
        <li class="select-tooltip-flex">
            <img src="/wrath/imgtip/AbolishPoison.jpg" alt="">
            <p>Abolish Poison</p>
        </li>
        </ul>`;
        case "04":
            return `<ul id="select-tooltip">
             <li class="select-tooltip-title select-druid">
                 <p>${target.textContent.trim()}</p>
                 <div id="button-tiny" class="button-tiny">X</div>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/GiftoftheWild.jpg" alt="">
                 <p>Gift of the Wild</p>
           </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/Revitalize.jpg" alt="">
                 <p>Revitalize</p>
           </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/Innervate.jpg" alt="">
                 <p>Innervate</p>
           </li>
           <li class="select-tooltip-flex">
               <img src="/wrath/imgtip/RemoveCurseDruid.jpg" alt="">
               <p>Remove Curse</p>
           </li>
           <li class="select-tooltip-flex">
               <img src="/wrath/imgtip/AbolishPoison.jpg" alt="">
               <p>Abolish Poison</p>
           </li>
         </ul>`;
        case "05":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-hunter">
                <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FerociousInspiration.jpg" alt="">
                <p>Ferocious Inspiration</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FaerieFire.jpg" alt="">
                <p>Tranquilizing Shot</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ScorpidSting.jpg" alt="">
                <p>Scorpid Sting</p>
            </li>
            <li class="select-tooltip-title select-hunter">
                <p>Pet</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Stampede.jpg" alt="">
                <p>Stampeed</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AcidSpit.jpg" alt="">
                <p>Acid Spit</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Sting.jpg" alt="">
                <p>Sting</p>
        </li>
        </ul>`;
        case "06":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-hunter">
                <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/TrueshotAura.jpg" alt="">
                <p>Trueshot Aura</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FaerieFire.jpg" alt="">
                <p>Tranquilizing Shot</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ScorpidSting.jpg" alt="">
                <p>Scorpid Sting</p>
            </li>
            <li class="select-tooltip-title select-hunter">
                <p>Pet</p>
            </li>
             <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Sting.jpg" alt="">
                <p>Sting</p>
             </li>
        </ul>`;
        case "07":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-hunter">
                <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FaerieFire.jpg" alt="">
                <p>Tranquilizing Shot</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ScorpidSting.jpg" alt="">
                <p>Scorpid Sting</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HuntingParty.jpg" alt="">
                <p>Hunting Party</p>
            </li>
            <li class="select-tooltip-title select-hunter">
                <p>Pet</p>
            </li>
             <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Sting.jpg" alt="">
                <p>Sting</p>
             </li>
        </ul>`;
        case "08":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-mage">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ArcaneEmpowerment.jpg" alt="">
                <p>Arcane Empowerment</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ArcaneIntellect.jpg" alt="">
                <p>Arcane Intellect</p>
            </li>
            <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/FocusMagic.jpg" alt="">
                 <p>Focus Magic</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Spellsteal.jpg" alt="">
                <p>Spellsteal</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/RemoveCurseMage.jpg" alt="">
                <p>Remove Curse</p>
            </li>
        </ul>`;
        case "09":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-mage">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ArcaneIntellect.jpg" alt="">
                <p>Arcane Intellect</p>
            </li>
            <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/FocusMagic.jpg" alt="">
                 <p>Focus Magic</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Spellsteal.jpg" alt="">
                <p>Spellsteal</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ImprovedScorch.jpg" alt="">
                <p>Improved Scorch</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/RemoveCurseMage.jpg" alt="">
                <p>Remove Curse</p>
            </li>
        </ul>`;
        case "10":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-mage">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ArcaneIntellect.jpg" alt="">
                <p>Arcane Intellect</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Spellsteal.jpg" alt="">
                <p>Spellsteal</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/WintersChill.jpg" alt="">
                <p>Winter's Chill</p>
            </li>      
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/EnduringWinter.jpg" alt="">
                <p>Enduring Winter</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/RemoveCurseMage.jpg" alt="">
                <p>Remove Curse</p>
            </li>
        </ul>`;
        case "11":
            return `<ul id="select-tooltip">
                <li class="select-tooltip-title select-paladin">
                    <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/BlessingofKings.jpg" alt="">
                    <p>Blessing of Kings</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/BlessingofMight.jpg" alt="">
                    <p>Blessing of Might</p>
                </li>
                <li class="select-tooltip-flex">
                     <img src="/wrath/imgtip/BlessingofWisdom.jpg" alt="">
                     <p>Blessing of Wisdom</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/JudgementofLight.jpg" alt="">
                    <p>Judgement of Light</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/JudgmentofWisdom.jpg" alt="">
                    <p>Judgment of Wisdom</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/Cleanse.jpg" alt="">
                    <p>Cleanse</p>
                </li>
            </ul>`;
        case "12":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-paladin">
            <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/BlessingofKings.jpg" alt="">
                    <p>Blessing of Kings</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/BlessingofSanctuary.jpg" alt="">
                    <p>Blessing of Sanctuary</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/BlessingofMight.jpg" alt="">
                    <p>Blessing of Might</p>
                </li>
                <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/BlessingofWisdom.jpg" alt="">
                <p>Blessing of Wisdom</p>
            </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/JudgementsoftheJust.jpg" alt="">
                    <p>Judgements of the Just</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/JudgementofLight.jpg" alt="">
                    <p>Judgement of Light</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/JudgmentofWisdom.jpg" alt="">
                    <p>Judgment of Wisdom</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/DivineGuardian.jpg" alt="">
                    <p>Divine Guardian</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/Cleanse.jpg" alt="">
                    <p>Cleanse</p>
                </li>
            </ul>`;
        case "13":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-paladin">
            <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/BlessingofKings.jpg" alt="">
                        <p>Blessing of Kings</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/BlessingofMight.jpg" alt="">
                        <p>Blessing of Might</p>
                    </li>
                    <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/BlessingofWisdom.jpg" alt="">
                    <p>Blessing of Wisdom</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/JudgementofLight.jpg" alt="">
                        <p>Judgement of Light</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/JudgmentofWisdom.jpg" alt="">
                        <p>Judgment of Wisdom</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/JudgementsoftheWise.jpg" alt="">
                        <p>Judgements of the Wise</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/SanctifiedRetribution.jpg" alt="">
                        <p>Sanctified Retribution</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/SwiftRetribution.jpg" alt="">
                        <p>Swift Retribution</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/HeartoftheCrusader.jpg" alt="">
                        <p>Heart of the Crusader</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/Vindication.jpg" alt="">
                        <p>Vindication</p>
                    </li>
                    <li class="select-tooltip-flex">
                        <img src="/wrath/imgtip/Cleanse.jpg" alt="">
                        <p>Cleanse</p>
                    </li>
                </ul>`;
        case "14":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-priest">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DivineSpirit.jpg" alt="">
                <p>Divine Spirit</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Fortitude.jpg" alt="">
                <p>Power Word: Fortitude</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/PowerInfusion.jpg" alt="">
                <p>Power Infusion</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/MassDispel.jpg" alt="">
                <p>Mass Dispel</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DispelMagic.jpg" alt="">
                <p>Dispel Magic</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HymnofHope.jpg" alt="">
                <p>Hymn of Hope</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Rapture.jpg" alt="">
                <p>Rapture</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AbolishDisease.jpg" alt="">
                <p>Abolish Disease</p>
            </li>
        </ul>`;
        case "15":
            return `<ul id="select-tooltip">
                <li class="select-tooltip-title select-priest">
                    <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/DivineSpirit.jpg" alt="">
                    <p>Divine Spirit</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/Fortitude.jpg" alt="">
                    <p>Power Word: Fortitude</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/MassDispel.jpg" alt="">
                    <p>Mass Dispel</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/DispelMagic.jpg" alt="">
                    <p>Dispel Magic</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/HymnofHope.jpg" alt="">
                    <p>Hymn of Hope</p>
                </li>
                <li class="select-tooltip-flex">
                    <img src="/wrath/imgtip/AbolishDisease.jpg" alt="">
                    <p>Abolish Disease</p>
                </li>
            </ul>`;
        case "16":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-priest">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DivineSpirit.jpg" alt="">
                <p>Divine Spirit</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Fortitude.jpg" alt="">
                <p>Power Word: Fortitude</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/MassDispel.jpg" alt="">
                <p>Mass Dispel</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DispelMagic.jpg" alt="">
                <p>Dispel Magic</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Misery.jpg" alt="">
                <p>Misery</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/VampiricTouch.jpg" alt="">
                <p>Vampiric Touch</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HymnofHope.jpg" alt="">
                <p>Hymn of Hope</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/VampiricEmbrace.jpg" alt="">
                <p>Vampiric Embrace</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AbolishDisease.jpg" alt="">
                <p>Abolish Disease</p>
            </li>
        </ul>`;
        case "17":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-rogue">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/tricks.jpg" alt="">
                <p>Tricks of the Trade</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AnestheticPoison.jpg" alt="">
                <p>Anesthetic Poison</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/MasterPoisoner.jpg" alt="">
                <p>Master Poisoner</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ExposeArmor.jpg" alt="">
                <p>Expose Armor</p>
            </li>
        </ul>`;
        case "18": return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-rogue">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/tricks.jpg" alt="">
                <p>Tricks of the Trade</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AnestheticPoison.jpg" alt="">
                <p>Anesthetic Poison</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/SavageCombat.jpg" alt="">
                <p>Savage Combat</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ExposeArmor.jpg" alt="">
                <p>Expose Armor</p>
            </li>
        </ul>`;
        case "19":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-rogue">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/tricks.jpg" alt="">
                <p>Tricks of the Trade</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AnestheticPoison.jpg" alt="">
                <p>Anesthetic Poison</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ExposeArmor.jpg" alt="">
                <p>Expose Armor</p>
            </li>
        </ul>`;
        case "20":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-shaman">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/StrengthofEarthTotem.jpg" alt="">
                <p>Strength of Earth Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HeroismBloodlust.jpg" alt="">
                <p>Heroism / Bloodlust</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/TotemofWrath.jpg" alt="">
                <p>Totem of Wrath</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ElementalOath.jpg" alt="">
                <p>Elemental Oath</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/WrathofAirTotem.jpg" alt="">
                <p>Wrath of Air Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Purge.jpg" alt="">
                <p>Purge</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ManaSpringTotem.jpg" alt="">
                <p>Mana Spring Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CureToxins.jpg" alt="">
                <p>Cure Toxins</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CleansingTotem.jpg" alt="">
                <p>Cleansing Totem</p>
            </li>
        </ul>`;
        case "21":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-shaman">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/StrengthofEarthTotem.jpg" alt="">
                <p>Strength of Earth Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/UnleashedRage.jpg" alt="">
                <p>Unleashed Rage</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ImprovedWindfuryTotem.jpg" alt="">
                <p>Imp Windfury Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HeroismBloodlust.jpg" alt="">
                <p>Heroism / Bloodlust</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FlametongueTotem.jpg" alt="">
                <p>Flametongue Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/WrathofAirTotem.jpg" alt="">
                <p>Wrath of Air Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Purge.jpg" alt="">
                <p>Purge</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ManaSpringTotem.jpg" alt="">
                <p>Mana Spring Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CureToxins.jpg" alt="">
                <p>Cure Toxins</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CleansingTotem.jpg" alt="">
                <p>Cleansing Totem</p>
            </li>
        </ul>`;
        case "22":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-shaman">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/StrengthofEarthTotem.jpg" alt="">
                <p>Strength of Earth Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HeroismBloodlust.jpg" alt="">
                <p>Heroism / Bloodlust</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FlametongueTotem.jpg" alt="">
                <p>Flametongue Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/WrathofAirTotem.jpg" alt="">
                <p>Wrath of Air Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Purge.jpg" alt="">
                <p>Purge</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ManaSpringTotem.jpg" alt="">
                <p>Mana Spring Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ManaTideTotem.jpg" alt="">
                <p>Mana Tide Totem</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CleanseSpirit.jpg" alt="">
                <p>Cleanse Spirit</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CleansingTotem.jpg" alt="">
                <p>Cleansing Totem</p>
            </li>
        </ul>`;
        case "23":
            return `<ul id="select-tooltip">
             <li class="select-tooltip-title select-warlock">
                 <p>${target.textContent.trim()}</p>
                 <div id="button-tiny" class="button-tiny">X</div>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/ImprovedShadowBolt.jpg" alt="">
                 <p>Imp Shadow Bolt</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/CurseoftheElements.jpg" alt="">
                 <p>Curse of the Elements</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/CurseofWeakness.jpg" alt="">
                 <p>Curse of Weakness</p>
             </li>
             <li class="select-tooltip-title select-warlock">
                 <p>Felhunter</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/FelIntelligence.jpg" alt="">
                 <p>Fel Intelligence</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/Purge.jpg" alt="">
                 <p>Devour Magic</p>
             </li>
             <li class="select-tooltip-title select-warlock">
                 <p>Imp</p>
             </li>
              <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/BloodPact.jpg" alt="">
                 <p>Blood Pact</p>
              </li>
         </ul>`;
        case "24":
            return `<ul id="select-tooltip">
             <li class="select-tooltip-title select-warlock">
                 <p>${target.textContent.trim()}</p>
                 <div id="button-tiny" class="button-tiny">X</div>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/DemonicPact.jpg" alt="">
                 <p>Demonic Pact</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/ImprovedShadowBolt.jpg" alt="">
                 <p>Imp Shadow Bolt</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/CurseoftheElements.jpg" alt="">
                 <p>Curse of the Elements</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/CurseofWeakness.jpg" alt="">
                 <p>Curse of Weakness</p>
             </li>
             <li class="select-tooltip-title select-warlock">
                 <p>Felhunter</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/FelIntelligence.jpg" alt="">
                 <p>Fel Intelligence</p>
             </li>
             <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/Purge.jpg" alt="">
                 <p>Devour Magic</p>
             </li>
             <li class="select-tooltip-title select-warlock">
                 <p>Imp</p>
             </li>
              <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/BloodPact.jpg" alt="">
                 <p>Blood Pact</p>
              </li>
         </ul>`;
        case "25":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-warlock">
                <p>${target.textContent.trim()}</p>
                <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CurseoftheElements.jpg" alt="">
                <p>Curse of the Elements</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CurseofWeakness.jpg" alt="">
                <p>Curse of Weakness</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ImprovedSoulLeech.jpg" alt="">
                <p>Imp Soul Leech</p>
            </li>
            <li class="select-tooltip-title select-warlock">
                <p>Felhunter</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/FelIntelligence.jpg" alt="">
                <p>Fel Intelligence</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Purge.jpg" alt="">
                <p>Devour Magic</p>
            </li>
            <li class="select-tooltip-title select-warlock">
                <p>Imp</p>
            </li>
             <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/BloodPact.jpg" alt="">
                <p>Blood Pact</p>
             </li>
        </ul>`;
        case "26":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-warrior">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/BattleShout.jpg" alt="">
                <p>Battle Shout</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CommandingShout.jpg" alt="">
                <p>Commanding Shout</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Trauma.jpg" alt="">
                <p>Trauma</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/BloodFrenzy.jpg" alt="">
                <p>Blood Frenzy</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/SunderArmor.jpg" alt="">
                <p>Sunder Armor</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ThunderClap.jpg" alt="">
                <p>Thunder Clap/p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DemoralizingShout.jpg" alt="">
                <p>Demoralizing Shout</p>
            </li>
        </ul>`;
        case "27":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-warrior">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/BattleShout.jpg" alt="">
                <p>Battle Shout</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CommandingShout.jpg" alt="">
                <p>Commanding Shout</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/Rampage.jpg" alt="">
                <p>Rampage</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/SunderArmor.jpg" alt="">
                <p>Sunder Armor</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ThunderClap.jpg" alt="">
                <p>Thunder Clap/p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DemoralizingShout.jpg" alt="">
                <p>Demoralizing Shout</p>
            </li>
        </ul>`;
        case "28":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-warrior">
                <p>${target.textContent.trim()}</p>
            <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/BattleShout.jpg" alt="">
                <p>Battle Shout</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/CommandingShout.jpg" alt="">
                <p>Commanding Shout</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ShieldSlam.jpg" alt="">
                <p>Shield Slam</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/SunderArmor.jpg" alt="">
                <p>Sunder Armor</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ThunderClap.jpg" alt="">
                <p>Thunder Clap/p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/DemoralizingShout.jpg" alt="">
                <p>Demoralizing Shout</p>
            </li>
        </ul>`;
        case "29":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-dk">
              <p>${target.textContent.trim()}</p>
              <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HornofWinter.jpg" alt="">
                <p>Horn of Winter</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/AbominationsMight.jpg" alt="">
                <p>Abominations Might</p>
            </li>
            <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/ImprovedIcyTalons.jpg" alt="">
                 <p>Improved Icy Talons</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/UnholyFrenzy.jpg" alt="">
                <p>Unholy Frenzy</p>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/ImprovedFrostFever.jpg" alt="">
                <p>Improved Frost Fever</p>
            </li>
        </ul>`;
        case "30": // Frost 
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-dk">
              <p>${target.textContent.trim()}</p>
              <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
                <img src="/wrath/imgtip/HornofWinter.jpg" alt="">
                <p>Horn of Winter</p>
            </li>
            <li class="select-tooltip-flex">
                 <img src="/wrath/imgtip/ImprovedIcyTalons.jpg" alt="">
                 <p>Improved Icy Talons</p>
            </li>
            <li class="select-tooltip-flex">
            <img src="/wrath/imgtip/ImprovedFrostFever.jpg" alt="">
            <p>Improved Frost Fever</p>
        </li>
        </ul>`;
        case "31": // Unholy
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-dk">
              <p>${target.textContent.trim()}</p>
              <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
            <img src="/wrath/imgtip/HornofWinter.jpg" alt="">
            <p>Horn of Winter</p>
        </li>
        <li class="select-tooltip-flex">
             <img src="/wrath/imgtip/EbonPlaguebringer.jpg" alt="">
             <p>Ebon Plaguebringer</p>
        </li>
        </ul>`;
        case "32":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-tank">
              <p>${target.textContent.trim()}</p>
              <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
            <p>No Abilities</p>
        </li>
        </ul>`;
        case "33":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-heal">
              <p>${target.textContent.trim()}</p>
              <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
            <p>No Abilities</p>
        </li>
        </ul>`;
        case "34":
        case "35":
            return `<ul id="select-tooltip">
            <li class="select-tooltip-title select-dps">
              <p>${target.textContent.trim()}</p>
              <div id="button-tiny" class="button-tiny">X</div>
            </li>
            <li class="select-tooltip-flex">
            <p>No Abilities</p>
        </li>
        </ul>`;
        default:
            return
    }
}