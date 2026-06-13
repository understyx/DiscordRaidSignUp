from __future__ import annotations

import json
import logging
import asyncio
import discord
from discord import app_commands
from discord.ext import commands
from sqlalchemy import select

from bot.db import get_session
from db.models import GuildSettings, RecruitmentForm, RecruitmentQuestion, RecruitmentApplication, RecruitmentAnswer, Character

logger = logging.getLogger(__name__)

async def get_active_form_fixed(guild_id: int):
    def _do():
        session = get_session()
        try:
            stmt = select(RecruitmentForm).where(
                RecruitmentForm.guild_id == guild_id,
                RecruitmentForm.is_active == True
            ).order_by(RecruitmentForm.created_at.desc()).limit(1)
            form = session.execute(stmt).scalar_one_or_none()
            if form:
                # Eagerly load questions to avoid DetachedInstanceError
                _ = form.questions
                session.expunge(form)
            return form
        finally:
            session.close()

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _do)

async def get_guild_settings(guild_id: int):
    def _do():
        session = get_session()
        try:
            settings = session.get(GuildSettings, guild_id)
            if settings:
                session.expunge(settings)
            return settings
        finally:
            session.close()

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _do)

class RecruitmentApplyView(discord.ui.View):
    def __init__(self, bot: commands.Bot):
        super().__init__(timeout=None)
        self.bot = bot

    @discord.ui.button(label="Apply", style=discord.ButtonStyle.green, custom_id="recruitment:apply")
    async def apply(self, interaction: discord.Interaction, button: discord.ui.Button):
        guild = interaction.guild
        if not guild:
            return

        form = await get_active_form_fixed(guild.id)
        if not form:
            await interaction.response.send_message("❌ Recruitment is currently closed (no active form found).", ephemeral=True)
            return

        settings = await get_guild_settings(guild.id)
        open_cat_id = settings.recruitment_category_open_id if settings else None
        open_category = guild.get_channel(open_cat_id) if open_cat_id else discord.utils.get(guild.categories, name="Status - Open")

        if not open_category:
            await interaction.response.send_message("❌ Recruitment categories not found. Please run `/recruitmentchannel` first.", ephemeral=True)
            return

        channel_name = f"app-{interaction.user.name}"
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            interaction.user: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True),
            guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True, embed_links=True, manage_channels=True)
        }

        try:
            app_channel = await guild.create_text_channel(
                name=channel_name,
                category=open_category,
                overwrites=overwrites,
                topic=f"Application for {interaction.user.display_name} (ID: {interaction.user.id})"
            )

            await interaction.response.send_message(f"✅ Your application channel has been created: {app_channel.mention}", ephemeral=True)

            cog = self.bot.get_cog("RecruitmentCog")
            if cog:
                await cog.start_questioning(app_channel, interaction.user, form)

        except Exception as e:
            logger.error("Failed to create application channel", exc_info=True)
            await interaction.response.send_message(f"❌ Failed to create application channel: {e}", ephemeral=True)

class RecruitmentQuestionView(discord.ui.View):
    def __init__(self, bot: commands.Bot, questions, user, channel, form_id):
        super().__init__(timeout=3600)
        self.bot = bot
        self.questions = questions
        self.user = user
        self.channel = channel
        self.form_id = form_id
        self.current_idx = 0
        self.answers = {}

    async def ask_next(self):
        if self.current_idx >= len(self.questions):
            await self.finish_application()
            return

        question = self.questions[self.current_idx]

        if question.question_type.value in ('header', 'separator'):
            self.current_idx += 1
            await self.ask_next()
            return

        embed = discord.Embed(
            title=f"Question {self.current_idx + 1}",
            description=question.question_text,
            color=discord.Color.blue()
        )
        if question.is_required:
            embed.set_footer(text="This question is required.")

        view = discord.ui.View(timeout=None)

        if question.question_type.value == 'text':
            embed.description += "\n\nPlease type your answer in this channel."
        elif question.question_type.value == 'textarea':
            embed.description += "\n\nPlease type your long-form answer in this channel."
        elif question.question_type.value in ('select', 'radio'):
            options = json.loads(question.options) if question.options else []
            select_menu = discord.ui.Select(placeholder="Choose one...", custom_id=f"q_{question.id}")
            for opt in options[:25]:
                select_menu.add_option(label=opt, value=opt)

            async def select_callback(interaction: discord.Interaction):
                if interaction.user.id != self.user.id: return
                self.answers[question.id] = select_menu.values[0]
                self.current_idx += 1
                await interaction.response.defer()
                await self.ask_next()

            select_menu.callback = select_callback
            view.add_item(select_menu)
        elif question.question_type.value == 'checkbox':
            options = json.loads(question.options) if question.options else []
            select_menu = discord.ui.Select(
                placeholder="Choose one or more...",
                custom_id=f"q_{question.id}",
                min_values=1 if question.is_required else 0,
                max_values=len(options[:25])
            )
            for opt in options[:25]:
                select_menu.add_option(label=opt, value=opt)

            async def checkbox_callback(interaction: discord.Interaction):
                if interaction.user.id != self.user.id: return
                self.answers[question.id] = json.dumps(select_menu.values)
                self.current_idx += 1
                await interaction.response.defer()
                await self.ask_next()

            select_menu.callback = checkbox_callback
            view.add_item(select_menu)
        elif question.question_type.value == 'characters':
            def _get_chars():
                session = get_session()
                try:
                    stmt = select(Character).where(
                        Character.discord_user_id == self.user.id,
                        Character.is_deleted == False
                    )
                    return session.execute(stmt).scalars().all()
                finally:
                    session.close()

            loop = asyncio.get_running_loop()
            chars = await loop.run_in_executor(None, _get_chars)

            if not chars:
                embed.description += "\n\n⚠️ You have no characters registered. Please use `/addcharacter` first, then click the button below to continue."
                btn = discord.ui.Button(label="I've added my characters", style=discord.ButtonStyle.grey)
                async def char_retry(interaction: discord.Interaction):
                    if interaction.user.id != self.user.id: return
                    await interaction.response.defer()
                    await self.ask_next()
                btn.callback = char_retry
                view.add_item(btn)
            else:
                select_menu = discord.ui.Select(
                    placeholder="Select your characters...",
                    custom_id=f"q_{question.id}",
                    min_values=1 if question.is_required else 0,
                    max_values=len(chars[:25])
                )
                for char in chars[:25]:
                    label = f"{char.char_name} - {char.char_class} ({char.spec})"
                    select_menu.add_option(label=label[:100], value=str(char.id))

                async def char_callback(interaction: discord.Interaction):
                    if interaction.user.id != self.user.id: return
                    self.answers[question.id] = json.dumps(select_menu.values)
                    self.current_idx += 1
                    await interaction.response.defer()
                    await self.ask_next()

                select_menu.callback = char_callback
                view.add_item(select_menu)

        await self.channel.send(embed=embed, view=view if len(view.children) > 0 else None)

        if question.question_type.value in ('text', 'textarea'):
            def check(m):
                return m.author.id == self.user.id and m.channel.id == self.channel.id

            try:
                msg = await self.bot.wait_for('message', check=check, timeout=600)
                self.answers[question.id] = msg.content
                self.current_idx += 1
                await self.ask_next()
            except asyncio.TimeoutError:
                await self.channel.send("⌛ Application timed out. You can restart by clicking Apply again in the main channel.")

    async def finish_application(self):
        await self.channel.send("⌛ Saving your application...")

        def _save():
            session = get_session()
            try:
                app = RecruitmentApplication(
                    form_id=self.form_id,
                    guild_id=self.channel.guild.id,
                    applicant_discord_id=self.user.id,
                    applicant_username=self.user.name,
                    applicant_display_name=self.user.display_name,
                    status='pending',
                    discord_channel_id=self.channel.id
                )
                session.add(app)
                session.flush()

                for q_id, text in self.answers.items():
                    session.add(RecruitmentAnswer(
                        application_id=app.id,
                        question_id=q_id,
                        answer_text=str(text)
                    ))
                session.commit()
                return app.id
            finally:
                session.close()

        loop = asyncio.get_running_loop()
        app_id = await loop.run_in_executor(None, _save)

        embed = discord.Embed(
            title="Application Submitted!",
            description="Your application has been received and will be reviewed by the guild admins.",
            color=discord.Color.green()
        )
        await self.channel.send(embed=embed)

        summary_embed = discord.Embed(title="Application Summary", color=discord.Color.blue())
        for q in self.questions:
            if q.id in self.answers:
                val = self.answers[q.id]
                if q.question_type.value == 'characters':
                    try:
                        ids = json.loads(val)
                        val = f"{len(ids)} character(s) selected"
                    except (ValueError, TypeError):
                        pass
                summary_embed.add_field(name=q.question_text[:256], value=val[:1024] or "(empty)", inline=False)

        await self.channel.send(embed=summary_embed)

class RecruitmentCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def start_questioning(self, channel, user, form):
        def _get_questions():
            session = get_session()
            try:
                # Re-fetch form and questions in a new session to avoid detachment
                stmt = select(RecruitmentQuestion).where(
                    RecruitmentQuestion.form_id == form.id
                ).order_by(RecruitmentQuestion.sort_order.asc())
                questions = session.execute(stmt).scalars().all()
                for q in questions:
                    session.expunge(q)
                return questions
            finally:
                session.close()

        loop = asyncio.get_running_loop()
        questions = await loop.run_in_executor(None, _get_questions)

        if not questions:
            await channel.send("❌ Error: This form has no questions. Please contact an admin.")
            return

        flow = RecruitmentQuestionView(self.bot, questions, user, channel, form.id)
        await flow.ask_next()

    @app_commands.command(name="recruitmentchannel", description="Setup recruitment categories and application channel.")
    @app_commands.checks.has_permissions(manage_guild=True)
    async def setup_recruitment(self, interaction: discord.Interaction):
        guild = interaction.guild
        if not guild:
            await interaction.response.send_message("❌ This command must be used in a server.", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)

        try:
            open_category = discord.utils.get(guild.categories, name="Status - Open")
            if not open_category:
                open_category = await guild.create_category("Status - Open")

            closed_category = discord.utils.get(guild.categories, name="Status - Closed")
            if not closed_category:
                closed_category = await guild.create_category("Status - Closed")
                await closed_category.set_permissions(guild.default_role, view_channel=False)

            apply_channel = discord.utils.get(guild.text_channels, name="apply", category=open_category)
            if not apply_channel:
                overwrites = {
                    guild.default_role: discord.PermissionOverwrite(send_messages=False),
                    guild.me: discord.PermissionOverwrite(send_messages=True, embed_links=True)
                }
                apply_channel = await guild.create_text_channel("apply", category=open_category, overwrites=overwrites)

            embed = discord.Embed(
                title="Guild Recruitment",
                description="Click the button below to start your application process!",
                color=discord.Color.blue()
            )
            view = RecruitmentApplyView(self.bot)
            await apply_channel.send(embed=embed, view=view)

            def _save():
                session = get_session()
                try:
                    settings = session.get(GuildSettings, guild.id)
                    if not settings:
                        settings = GuildSettings(guild_id=guild.id)
                        session.add(settings)

                    settings.recruitment_category_open_id = open_category.id
                    settings.recruitment_category_closed_id = closed_category.id
                    session.commit()
                finally:
                    session.close()

            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, _save)

            await interaction.followup.send(
                f"✅ Recruitment setup complete!\n"
                f"• Category Open: {open_category.name}\n"
                f"• Category Closed: {closed_category.name}\n"
                f"• Application Channel: {apply_channel.mention}",
                ephemeral=True
            )

        except Exception as e:
            logger.error("Failed to setup recruitment channel", exc_info=True)
            await interaction.followup.send(f"❌ Failed to setup recruitment: {e}", ephemeral=True)

async def setup(bot: commands.Bot):
    await bot.add_cog(RecruitmentCog(bot))
    bot.add_view(RecruitmentApplyView(bot))
